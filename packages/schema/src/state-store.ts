import { createHash } from 'node:crypto'
import path from 'node:path'
import type { FabricJsonValue, FabricStateRecord, FabricTopicMessage } from 'dsh-fabric-protocol'
import { FabricStateKey, FabricTopicId } from 'dsh-fabric-protocol'
import { FabricMeshError, type FabricMeshWorkspace } from 'dsh-fabric-mesh'
import { countFileComplexity } from './complexity.ts'
import { runCommand, type CommandResult } from './evidence-runner.ts'
import type {
  AdvanceHeadInput,
  StateCertificate,
  StateCertificationHead,
  StateCertificationTarget,
  StateComplexityDelta,
  StateComplexityFile,
  StateComplexityResult,
  StateComplexitySummary,
  StateGoal,
  StateHead,
  StateHeadValue,
  StateTransitionComplexity,
  StateTransitionInput,
  StateTransitionKind,
  StateTransitionPhase,
  StateTransitionRecord,
  VerificationFailure,
  VerificationReport,
  VerifyResult,
} from './types.ts'

export type {
  AdvanceHeadInput,
  StateCertificate,
  StateComplexityResult,
  StateComplexitySummary,
  StateGoal,
  StateHead,
  StateTransitionInput,
  StateTransitionKind,
  StateTransitionRecord,
  VerificationReport,
} from './types.ts'

/** The Fabric state layer is the Schema world-model heart: an append-only Timeline of typed, validated transitions stored as mesh topic events, plus a compare-and-swap head pointer recomputable from the log. Raw mesh calls (fabric_mesh snapshot/get_state/read_topic) can inspect everything here. The typed state tools validate the calls that use them; they are not a gate on direct mesh use. */

export const STATE_TOPIC = 'fabric.state'
export const CURRENT_KEY = 'state/current'
export const GOAL_KEY = 'state/goal'
export const COMPLEXITY_KEY_PREFIX = 'state/complexity/'

/** A mesh-topic event as the state layer reads it (payload-carried fields). */
export interface SchemaMeshEvent {
  id: string
  sequence: number
  kind: string
  from?: string
  text?: string
  data?: Record<string, unknown>
  createdAt: number
}

interface ComplexityLedgerValue {
  file: string
  language: string
  count: number
  lastDelta: number
  ts: number
}

interface PreparedComplexity {
  record: StateTransitionComplexity
  updates: Array<{
    key: string
    value: ComplexityLedgerValue
    expectedVersion: number
    before: FabricStateRecord | undefined
  }>
}

interface AppliedStateWrite {
  key: string
  before: FabricStateRecord | undefined
  written: FabricStateRecord
}

interface TransitionOutcome {
  event: SchemaMeshEvent
  phase: 'certified' | 'violated'
}

const CAS_RETRY_LIMIT = 8
const REPORT_TEXT_MAX_BYTES = 8 * 1024
const EVENT_TEXT_MAX_BYTES = 1024
const EVENT_OUTPUT_MAX_BYTES = 4 * 1024
const EVENT_RESULT_LIMIT = 8
const EVENT_TARGET_LIMIT = 16
const EVENT_ROLLBACK_LIMIT = 8
const TRANSITION_PROTOCOL_VERSION = 1
const DURABLE_HEAD_PROTOCOL_VERSION = 2
const HEAD_COMMIT_PROOF_VERSION = 1
const STATE_EVENT_READ_LIMIT = 500

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isCasError = (error: unknown): boolean =>
  error instanceof Error && /expected version \d+, current version is \d+/.test(error.message)

const isNotFoundError = (error: unknown): boolean =>
  (error instanceof FabricMeshError && error.code === 'not-found') || /not found|does not exist/.test(errorMessage(error))

const toStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) items.push(item)
  }
  return items.length > 0 ? items : undefined
}

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

const truncateUtf8 = (
  value: string,
  maxBytes: number,
): { value: string; omittedBytes: number } => {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return { value, omittedBytes: 0 }
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  const bounded = bytes.subarray(0, end).toString('utf8')
  return { value: bounded, omittedBytes: bytes.length - end }
}

const boundedError = (error: unknown): string =>
  truncateUtf8(errorMessage(error), REPORT_TEXT_MAX_BYTES).value

const casActualVersion = (error: unknown): number | undefined => {
  const match = errorMessage(error).match(/current version is (\d+)/)
  return match ? Number(match[1]) : undefined
}

const toComplexityRecord = (
  value: unknown,
): StateTransitionComplexity | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { files?: unknown; netDelta?: unknown }
  if (!Array.isArray(raw.files) || typeof raw.netDelta !== 'number') {
    return undefined
  }
  const files: StateComplexityDelta[] = []
  for (const item of raw.files) {
    if (!item || typeof item !== 'object') continue
    const delta = item as Record<string, unknown>
    if (typeof delta.file !== 'string' || typeof delta.supported !== 'boolean') {
      continue
    }
    files.push({
      file: delta.file,
      supported: delta.supported,
      ...(typeof delta.language === 'string' ? { language: delta.language } : {}),
      ...(typeof delta.previous === 'number' ? { previous: delta.previous } : {}),
      ...(typeof delta.current === 'number' ? { current: delta.current } : {}),
      ...(typeof delta.delta === 'number' ? { delta: delta.delta } : {}),
      ...(typeof delta.baseline === 'boolean' ? { baseline: delta.baseline } : {}),
    })
  }
  return { files, netDelta: raw.netDelta }
}

const transitionReference = (event: SchemaMeshEvent): string | undefined => {
  const data = event.data
  return data && typeof data.transitionId === 'string' ? data.transitionId : undefined
}

const committedTransitionIds = (events: SchemaMeshEvent[]): Set<string> => {
  const committed = new Set<string>()
  const rejected = new Set<string>()
  for (const event of events) {
    const transitionId = transitionReference(event)
    if (!transitionId) continue
    if (event.kind === 'transition.committed') committed.add(transitionId)
    if (event.kind === 'transition.rejected') rejected.add(transitionId)
  }
  for (const transitionId of rejected) committed.delete(transitionId)
  return committed
}

const toRecord = (
  event: SchemaMeshEvent,
  committedIds?: ReadonlySet<string>,
): StateTransitionRecord | undefined => {
  if (event.kind !== 'transition') return undefined
  const data = event.data
  if (!data) return undefined
  if (
    data.phase === 'proposed' &&
    (committedIds === undefined || !committedIds.has(event.id))
  ) {
    return undefined
  }
  if (data.phase === 'rejected') return undefined
  const label = typeof data.label === 'string' ? data.label : ''
  const to = typeof data.to === 'string' ? data.to : ''
  const summary = typeof data.summary === 'string' ? data.summary : ''
  const kind =
    data.kind === 'representation' ? 'representation' : 'state'
  const ts = typeof data.ts === 'number' ? data.ts : event.createdAt
  const from = typeof data.from === 'string' ? data.from : undefined
  const evidence = toStringArray(data.evidence)
  const tags = toStringArray(data.tags)
  const complexity = toComplexityRecord(data.complexity)
  const certificationStatus =
    data.certificationStatus === 'pending' ? 'pending' : undefined
  if (!label || !to) return undefined
  return {
    transitionId: event.id,
    sequence: event.sequence,
    label,
    ...(from !== undefined ? { from } : {}),
    to,
    summary,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(tags !== undefined ? { tags } : {}),
    kind,
    ...(complexity !== undefined ? { complexity } : {}),
    ...(certificationStatus !== undefined ? { certificationStatus } : {}),
    ts,
  }
}

const toHeadRecord = (head: StateHead): StateTransitionRecord | undefined => {
  if (
    typeof head.transitionSequence !== 'number' ||
    !Number.isSafeInteger(head.transitionSequence) ||
    head.transitionSequence < 1
  ) {
    return undefined
  }
  return {
    transitionId: head.transitionId,
    sequence: head.transitionSequence,
    label: head.label,
    ...(head.from !== undefined ? { from: head.from } : {}),
    to: head.to,
    summary: head.summary,
    ...(head.evidence !== undefined ? { evidence: head.evidence } : {}),
    ...(head.tags !== undefined ? { tags: head.tags } : {}),
    kind: head.kind,
    ...(head.complexity !== undefined ? { complexity: head.complexity } : {}),
    ...(head.certificationStatus !== undefined
      ? { certificationStatus: head.certificationStatus }
      : {}),
    ts: head.ts,
  }
}

const toCertificationTarget = (value: unknown): StateCertificationTarget | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const target = value as Record<string, unknown>
  if (
    typeof target.transitionId !== 'string' ||
    typeof target.label !== 'string' ||
    typeof target.to !== 'string'
  ) {
    return undefined
  }
  return {
    transitionId: target.transitionId,
    label: target.label,
    to: target.to,
  }
}

const toCertificationHead = (value: unknown): StateCertificationHead | null => {
  if (value === null) return null
  if (!value || typeof value !== 'object') return null
  const head = value as Record<string, unknown>
  if (
    typeof head.transitionId !== 'string' ||
    typeof head.label !== 'string' ||
    typeof head.to !== 'string' ||
    typeof head.version !== 'number'
  ) {
    return null
  }
  return {
    transitionId: head.transitionId,
    label: head.label,
    ...(typeof head.labelDigest === 'string' ? { labelDigest: head.labelDigest } : {}),
    ...(typeof head.labelOmittedBytes === 'number'
      ? { labelOmittedBytes: head.labelOmittedBytes }
      : {}),
    to: head.to,
    ...(typeof head.toDigest === 'string' ? { toDigest: head.toDigest } : {}),
    ...(typeof head.toOmittedBytes === 'number'
      ? { toOmittedBytes: head.toOmittedBytes }
      : {}),
    version: head.version,
  }
}

const verificationTargets = (event: SchemaMeshEvent): StateCertificationTarget[] => {
  if (event.kind !== 'state.certified' && event.kind !== 'state.violated') return []
  const data = event.data
  if (!data || !Array.isArray(data.targets)) return []
  return data.targets
    .map(toCertificationTarget)
    .filter((target): target is StateCertificationTarget => target !== undefined)
}

const latestTransitionOutcomes = (events: SchemaMeshEvent[]): Map<string, TransitionOutcome> => {
  const latest = new Map<string, TransitionOutcome>()
  for (const event of events) {
    if (event.kind !== 'state.certified' && event.kind !== 'state.violated') continue
    for (const target of verificationTargets(event)) {
      latest.set(target.transitionId, {
        event,
        phase: event.kind === 'state.certified' ? 'certified' : 'violated',
      })
    }
  }
  return latest
}

const toCertificate = (
  event: SchemaMeshEvent,
  currentHead: StateHead | null,
  latestOutcomes?: ReadonlyMap<string, TransitionOutcome>,
): StateCertificate | undefined => {
  if (event.kind !== 'state.certified') return undefined
  const data = event.data
  if (
    !data ||
    !Array.isArray(data.targets) ||
    typeof data.evidenceDigest !== 'string' ||
    typeof data.resultDigest !== 'string'
  ) {
    return undefined
  }
  const targets = data.targets
    .map(toCertificationTarget)
    .filter((target): target is StateCertificationTarget => target !== undefined)
  if (targets.length === 0) return undefined
  const head = toCertificationHead(data.head)
  const currentTarget =
    currentHead === null
      ? undefined
      : targets.find((target) => target.transitionId === currentHead.transitionId)
  const latestCurrentOutcome = currentTarget
    ? latestOutcomes?.get(currentTarget.transitionId)
    : undefined
  const current =
    head !== null &&
    currentHead !== null &&
    currentTarget !== undefined &&
    head.transitionId === currentHead.transitionId &&
    (head.labelDigest
      ? head.labelDigest === digest(currentHead.label)
      : head.label === currentHead.label) &&
    (head.toDigest ? head.toDigest === digest(currentHead.to) : head.to === currentHead.to) &&
    head.version === currentHead.version &&
    (latestCurrentOutcome === undefined ||
      (latestCurrentOutcome.phase === 'certified' &&
        latestCurrentOutcome.event.sequence === event.sequence))
  return {
    certificateId: event.id,
    sequence: event.sequence,
    certificationStatus: 'certified',
    targets,
    head,
    evidenceDigest: data.evidenceDigest,
    resultDigest: data.resultDigest,
    ts: typeof data.ts === 'number' ? data.ts : event.createdAt,
    current,
  }
}

const durableCurrentCertificate = (
  head: StateHead,
  latestOutcomes?: ReadonlyMap<string, TransitionOutcome>,
): StateCertificate | undefined => {
  const certificate = head.certificate
  if (
    !certificate ||
    certificate.certificationStatus !== 'certified' ||
    typeof certificate.certificateId !== 'string' ||
    typeof certificate.sequence !== 'number' ||
    !Array.isArray(certificate.targets) ||
    typeof certificate.evidenceDigest !== 'string' ||
    typeof certificate.resultDigest !== 'string' ||
    typeof certificate.ts !== 'number'
  ) {
    return undefined
  }
  const certificateHead = toCertificationHead(certificate.head)
  const targets = certificate.targets
    .map(toCertificationTarget)
    .filter((target): target is StateCertificationTarget => target !== undefined)
  const target = targets.find(
    (item) =>
      item.transitionId === head.transitionId &&
      item.label === head.label &&
      item.to === head.to,
  )
  const latestOutcome = latestOutcomes?.get(head.transitionId)
  if (
    !target ||
    certificateHead === null ||
    certificateHead.transitionId !== head.transitionId ||
    (certificateHead.labelDigest
      ? certificateHead.labelDigest !== digest(head.label)
      : certificateHead.label !== head.label) ||
    (certificateHead.toDigest
      ? certificateHead.toDigest !== digest(head.to)
      : certificateHead.to !== head.to) ||
    certificateHead.version !== head.version ||
    (latestOutcome !== undefined &&
      (latestOutcome.phase !== 'certified' ||
        latestOutcome.event.sequence !== certificate.sequence))
  ) {
    return undefined
  }
  return {
    ...certificate,
    targets,
    head: certificateHead,
    current: true,
  }
}

const toVerifyResult = (
  claim: string,
  command: string,
  result: CommandResult,
): VerifyResult => {
  const boundedClaim = truncateUtf8(claim, REPORT_TEXT_MAX_BYTES)
  const boundedCommand = truncateUtf8(command, REPORT_TEXT_MAX_BYTES)
  const boundedResultError = result.error
    ? truncateUtf8(result.error, REPORT_TEXT_MAX_BYTES)
    : undefined
  return {
    claim: boundedClaim.value,
    claimDigest: digest(claim),
    ...(boundedClaim.omittedBytes > 0
      ? { claimOmittedBytes: boundedClaim.omittedBytes }
      : {}),
    command: boundedCommand.value,
    commandDigest: digest(command),
    ...(boundedCommand.omittedBytes > 0
      ? { commandOmittedBytes: boundedCommand.omittedBytes }
      : {}),
    status: result.status,
    exitCode: result.exitCode,
    output: result.output,
    outputBytes: result.outputBytes,
    outputOmittedBytes: result.outputOmittedBytes,
    outputDigest: result.outputDigest,
    ...(boundedResultError
      ? {
          error: boundedResultError.value,
          errorDigest: digest(result.error),
          ...(boundedResultError.omittedBytes > 0
            ? { errorOmittedBytes: boundedResultError.omittedBytes }
            : {}),
        }
      : {}),
  }
}

const toEventResult = (result: VerifyResult): VerifyResult => {
  const claim = truncateUtf8(result.claim, EVENT_TEXT_MAX_BYTES)
  const command = truncateUtf8(result.command, EVENT_TEXT_MAX_BYTES)
  const output = truncateUtf8(result.output, EVENT_OUTPUT_MAX_BYTES)
  const error = result.error
    ? truncateUtf8(result.error, EVENT_TEXT_MAX_BYTES)
    : undefined
  return {
    ...result,
    claim: claim.value,
    claimOmittedBytes: (result.claimOmittedBytes ?? 0) + claim.omittedBytes,
    command: command.value,
    commandOmittedBytes: (result.commandOmittedBytes ?? 0) + command.omittedBytes,
    output: output.value,
    outputOmittedBytes: result.outputOmittedBytes + output.omittedBytes,
    ...(error
      ? {
          error: error.value,
          errorOmittedBytes: (result.errorOmittedBytes ?? 0) + error.omittedBytes,
        }
      : {}),
  }
}

const toEventFailure = (failure: VerificationFailure): VerificationFailure => {
  const message = truncateUtf8(failure.message, EVENT_TEXT_MAX_BYTES).value
  const transitionId = failure.transitionId
    ? truncateUtf8(failure.transitionId, EVENT_TEXT_MAX_BYTES).value
    : undefined
  const label = failure.label
    ? truncateUtf8(failure.label, EVENT_TEXT_MAX_BYTES).value
    : undefined
  const command = failure.command
    ? truncateUtf8(failure.command, EVENT_TEXT_MAX_BYTES).value
    : undefined
  const error = failure.error
    ? truncateUtf8(failure.error, EVENT_TEXT_MAX_BYTES).value
    : undefined
  return {
    ...failure,
    message,
    ...(transitionId !== undefined ? { transitionId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

export class StateStore {
  constructor(
    readonly mesh: FabricMeshWorkspace,
    readonly identity: string,
  ) {}

  toHead(entry: FabricStateRecord): StateHead {
    const value = entry.value as unknown as StateHeadValue
    return { ...value, version: entry.version }
  }

  get(): {
    head: StateHead | null
    goal: StateGoal | null
    complexity: StateComplexitySummary
    certification: {
      current: StateCertificate | null
      recent: StateCertificate[]
    }
  } {
    const storedHead = this.getHead()
    const goalEntry = this.getState(GOAL_KEY)
    const goal = goalEntry ? (goalEntry.value as unknown as StateGoal) : null
    const ledgers = this.complexityLedgers()
    const history = this.history({})
    const lastComplexity = history.transitions
      .filter((transition) => transition.complexity !== undefined)
      .at(-1)?.complexity
    const headRecord = storedHead
      ? history.transitions.find(
          (transition) => transition.transitionId === storedHead.transitionId,
        )
      : undefined
    const head = storedHead
      ? (() => {
          const { certificate: _storedCertificate, ...baseHead } = storedHead
          return headRecord?.certificate
            ? {
                ...baseHead,
                certificationStatus: 'certified' as const,
                certificate: headRecord.certificate,
              }
            : baseHead
        })()
      : null
    const complexity = {
      files: ledgers.length,
      decisionPoints: ledgers.reduce((total, ledger) => total + ledger.count, 0),
      lastNetDelta: lastComplexity?.netDelta ?? 0,
    }
    return {
      head,
      goal,
      complexity,
      certification: {
        current: history.certifications.find((certificate) => certificate.current) ?? null,
        recent: history.certifications.slice(0, 20),
      },
    }
  }

  getHead(): StateHead | null {
    const entry = this.getState(CURRENT_KEY)
    if (!entry) return null
    const head = this.toHead(entry)
    if (head.protocolVersion === DURABLE_HEAD_PROTOCOL_VERSION) {
      const proof = head.commitProof
      const hasValidSequence =
        typeof head.transitionSequence === 'number' &&
        Number.isSafeInteger(head.transitionSequence) &&
        head.transitionSequence > 0
      if (
        !hasValidSequence ||
        proof?.version !== HEAD_COMMIT_PROOF_VERSION
      ) {
        return null
      }
      if (proof.status === 'committed') return head
      if (proof.status !== 'pending') return null
      return committedTransitionIds(this.stateEvents()).has(head.transitionId)
        ? head
        : null
    }
    const events = this.stateEvents()
    const committedIds = committedTransitionIds(events)
    if (head.protocolVersion === TRANSITION_PROTOCOL_VERSION) {
      return committedIds.has(head.transitionId) ? head : null
    }
    const proposal = events.find(
      (event) => event.kind === 'transition' && event.id === head.transitionId,
    )
    if (!proposal) return head
    const data = proposal.data
    return data?.phase === 'proposed' && !committedIds.has(proposal.id) ? null : head
  }

  async transition(
    input: StateTransitionInput,
    cwd = process.cwd(),
  ): Promise<{ event: SchemaMeshEvent; head: StateHead }> {
    const physicalCurrent = this.getState(CURRENT_KEY)
    const current = this.getHead()
    const expectedVersion = physicalCurrent?.version ?? 0
    if (physicalCurrent && !current) {
      throw new Error(
        'State contention: current head belongs to an uncommitted or quarantined proposal',
      )
    }
    const currentTo = current?.to
    const force = input.force === true
    if (!force && currentTo !== undefined && input.from !== undefined) {
      if (input.from !== currentTo) {
        throw new Error(
          `State from-mismatch: head is at "${currentTo}", but transition declares from "${input.from}"`,
        )
      }
    }
    const ts = Date.now()
    const preparedComplexity = input.complexity
      ? this.prepareComplexity(input.complexity.files, cwd, ts)
      : undefined
    const isComplexityReduction =
      preparedComplexity !== undefined && preparedComplexity.record.netDelta < 0
    if (
      isComplexityReduction &&
      !input.evidence?.some((command) => command.trim().length > 0)
    ) {
      throw new Error(
        `State complexity reduction rejected: net decision-point delta is ${preparedComplexity!.record.netDelta}. Reducing branches is also achievable by deleting error handling; attach at least one replayable behavior-preservation evidence command to separate abstraction from vandalism. The reduction remains pending until a later state_verify succeeds.`,
      )
    }
    const kind: StateTransitionKind = input.kind ?? 'state'
    const data: Record<string, unknown> = {
      protocolVersion: TRANSITION_PROTOCOL_VERSION,
      phase: 'proposed' satisfies StateTransitionPhase,
      label: input.label,
      to: input.to,
      summary: input.summary,
      kind,
      ts,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(preparedComplexity ? { complexity: preparedComplexity.record } : {}),
      ...(isComplexityReduction ? { certificationStatus: 'pending' } : {}),
    }
    const event = await this.publish('transition', data, input.summary)
    const applied: AppliedStateWrite[] = []
    let headWrite: AppliedStateWrite | undefined
    let commitMarkerPublished = false
    try {
      for (const update of preparedComplexity?.updates ?? []) {
        const written = await this.cas(update.key, update.expectedVersion, update.value)
        applied.push({ key: update.key, before: update.before, written })
      }
      const payload: StateHeadValue = {
        protocolVersion: DURABLE_HEAD_PROTOCOL_VERSION,
        commitProof: {
          version: HEAD_COMMIT_PROOF_VERSION,
          status: 'pending',
        },
        transitionSequence: event.sequence,
        label: input.label,
        ...(input.from !== undefined ? { from: input.from } : {}),
        to: input.to,
        summary: input.summary,
        kind,
        ...(preparedComplexity ? { complexity: preparedComplexity.record } : {}),
        transitionId: event.id,
        ts,
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(isComplexityReduction ? { certificationStatus: 'pending' } : {}),
      }
      const advanced = await this.advanceHeadWithBefore({
        payload,
        from: input.from,
        force,
        expectedVersion,
      })
      headWrite = {
        key: CURRENT_KEY,
        before: advanced.before,
        written: advanced.entry,
      }
      await this.publish('transition.committed', {
        protocolVersion: TRANSITION_PROTOCOL_VERSION,
        phase: 'committed' satisfies StateTransitionPhase,
        transitionId: event.id,
        ts: Date.now(),
      }, 'state transition committed')
      commitMarkerPublished = true
      const committedHead = await this.markHeadCommitted(advanced.entry)
      return { event, head: this.toHead(committedHead) }
    } catch (error) {
      if (commitMarkerPublished) {
        throw new Error(
          `State transition committed, but its durable head proof remains pending: ${boundedError(error)}`,
          { cause: error },
        )
      }
      const rollback = await this.rollbackWrites(
        [...(headWrite ? [headWrite] : []), ...applied.reverse()],
      )
      let reportingError: string | undefined
      try {
        const deletedChunks: Array<Array<{ key: string; version: number }>> = []
        for (
          let index = 0;
          index < rollback.deleted.length;
          index += EVENT_ROLLBACK_LIMIT
        ) {
          deletedChunks.push(
            rollback.deleted.slice(index, index + EVENT_ROLLBACK_LIMIT).map((item) => ({
              key: truncateUtf8(item.key, REPORT_TEXT_MAX_BYTES).value,
              version: item.version,
            })),
          )
        }
        if (deletedChunks.length === 0) deletedChunks.push([])
        for (let index = 0; index < deletedChunks.length; index++) {
          await this.publish('transition.rejected', {
            protocolVersion: TRANSITION_PROTOCOL_VERSION,
            phase: 'rejected' satisfies StateTransitionPhase,
            transitionId: event.id,
            error: truncateUtf8(errorMessage(error), EVENT_TEXT_MAX_BYTES).value,
            rollback: {
              restored: rollback.errors.length === 0,
              deleted: deletedChunks[index],
              errors: index === 0
                ? rollback.errors
                    .slice(0, EVENT_ROLLBACK_LIMIT)
                    .map((item) => truncateUtf8(item, EVENT_TEXT_MAX_BYTES).value)
                : [],
              omittedErrorCount: Math.max(
                0,
                rollback.errors.length - EVENT_ROLLBACK_LIMIT,
              ),
              chunk: { index, count: deletedChunks.length },
            },
            quarantine: rollback.errors.length > 0,
            ts: Date.now(),
          }, rollback.errors.length > 0
            ? 'state transition quarantined'
            : 'state transition rejected')
        }
      } catch (publishError) {
        reportingError = boundedError(publishError)
      }
      const detail = [
        `State transition rejected: ${boundedError(error)}`,
        ...(rollback.errors.length > 0
          ? [`rollback quarantine: ${rollback.errors.join('; ')}`]
          : []),
        ...(reportingError ? [`rejection reporting failed: ${reportingError}`] : []),
      ].join('; ')
      throw new Error(detail, { cause: error })
    }
  }

  private async markHeadCommitted(
    pending: FabricStateRecord,
  ): Promise<FabricStateRecord> {
    const value = pending.value as unknown as StateHeadValue
    try {
      return await this.cas(CURRENT_KEY, pending.version, {
        ...value,
        commitProof: {
          version: HEAD_COMMIT_PROOF_VERSION,
          status: 'committed',
        },
      } satisfies StateHeadValue)
    } catch (error) {
      if (!isCasError(error)) throw error
      const current = this.getState(CURRENT_KEY)
      if (
        current &&
        (current.value as unknown as StateHeadValue).transitionId === value.transitionId &&
        (current.value as unknown as StateHeadValue).commitProof?.version ===
          HEAD_COMMIT_PROOF_VERSION &&
        (current.value as unknown as StateHeadValue).commitProof?.status === 'committed'
      ) {
        return current
      }
      return pending
    }
  }

  // Advance the compare-and-swap head pointer for a durable proposal. The
  // proposal remains invisible until its commit marker. On CAS contention we
  // re-read, re-validate `from` against the new head, and retry — a bounded
  // number of times. If `from` no longer chains from the current head, the
  // transition is rejected with the actual current label (Schema's surprise:
  // the plan's assumed state was voided by a concurrent writer).
  async advanceHead(input: AdvanceHeadInput): Promise<FabricStateRecord> {
    return (await this.advanceHeadWithBefore(input)).entry
  }

  private async advanceHeadWithBefore(
    input: AdvanceHeadInput,
  ): Promise<{ entry: FabricStateRecord; before: FabricStateRecord | undefined }> {
    let version = input.expectedVersion
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt++) {
      const before = this.getState(CURRENT_KEY)
      try {
        const entry = await this.cas(CURRENT_KEY, version, input.payload)
        return { entry, before }
      } catch (error) {
        if (!isCasError(error)) throw error
        const current = this.getState(CURRENT_KEY)
        const actualTo = current
          ? (current.value as unknown as StateHeadValue).to
          : undefined
        if (!input.force) {
          if (current && input.from !== undefined && actualTo !== undefined) {
            if (input.from !== actualTo) {
              throw new Error(
                `State contention: head is at "${actualTo}", cannot transition from "${input.from}"`,
              )
            }
          } else if (current && input.from === undefined) {
            throw new Error(
              `State contention: head advanced to "${actualTo ?? '<unknown>'}" before transition`,
            )
          }
        }
        version = current?.version ?? casActualVersion(error) ?? 0
      }
    }
    throw new Error(
      `State contention: compare-and-swap retries exhausted after ${CAS_RETRY_LIMIT} attempts`,
    )
  }

  private async rollbackWrites(
    writes: AppliedStateWrite[],
  ): Promise<{ deleted: Array<{ key: string; version: number }>; errors: string[] }> {
    const deleted: Array<{ key: string; version: number }> = []
    const errors: string[] = []
    for (const write of writes) {
      try {
        if (write.before) {
          await this.cas(write.key, write.written.version, write.before.value)
        }
        // dsh-fabric mesh state has no delete; an absent-before write (a
        // baseline complexity ledger entry for a never-seen file) is left in
        // place. It only feeds future delta measurements, never the head.
      } catch (error) {
        errors.push(`${write.key}: ${boundedError(error)}`)
      }
    }
    return { deleted, errors }
  }

  private stateEvents(): SchemaMeshEvent[] {
    return this.readTopic(STATE_TOPIC, STATE_EVENT_READ_LIMIT)
  }

  private async nextSequence(): Promise<number> {
    const events = this.stateEvents()
    const max = events.reduce((highest, event) => Math.max(highest, event.sequence), 0)
    return max + 1
  }

  private async publish(kind: string, data: Record<string, unknown>, text?: string): Promise<SchemaMeshEvent> {
    await this.ensureTopic(STATE_TOPIC)
    const sequence = await this.nextSequence()
    const ts = Date.now()
    const message = await this.mesh.publish(topicId(STATE_TOPIC), {
      kind,
      sequence,
      ts,
      ...(this.identity ? { from: this.identity } : {}),
      ...(text !== undefined ? { text } : {}),
      data,
    } as FabricJsonValue)
    return eventFromMessage(message)
  }

  private readTopic(topic: string, limit: number): SchemaMeshEvent[] {
    try {
      const messages = this.mesh.topicMessages(topicId(topic), limit)
      return messages
        .map(eventFromMessage)
        .sort((left, right) => left.sequence - right.sequence || String(left.id).localeCompare(String(right.id)))
    } catch (error) {
      if (isNotFoundError(error)) return []
      throw error
    }
  }

  private async ensureTopic(topic: string): Promise<void> {
    try {
      this.mesh.topic(topicId(topic))
      return
    } catch {
      try {
        await this.mesh.createTopic(topic, topicId(topic))
      } catch (error) {
        if (!/already exists/.test(errorMessage(error))) throw error
      }
    }
  }

  private getState(key: string): FabricStateRecord | undefined {
    return this.mesh.getState(FabricStateKey(key))
  }

  private async cas(key: string, expectedVersion: number, value: unknown): Promise<FabricStateRecord> {
    return this.mesh.compareAndSwap(FabricStateKey(key), expectedVersion, value as FabricJsonValue)
  }

  history(input: {
    label?: string
    limit?: number
    includeArchived?: boolean
  } = {}): {
    transitions: StateTransitionRecord[]
    labels: string[]
    certifications: StateCertificate[]
  } {
    const events = this.stateEvents()
    const committedIds = committedTransitionIds(events)
    const currentHead = this.getHead()
    const records: StateTransitionRecord[] = []
    for (const event of events) {
      const record = toRecord(event, committedIds)
      if (record) records.push(record)
    }
    if (
      currentHead &&
      !records.some((record) => record.transitionId === currentHead.transitionId)
    ) {
      const currentRecord = toHeadRecord(currentHead)
      if (currentRecord) records.push(currentRecord)
    }
    records.sort((left, right) => left.sequence - right.sequence)
    let lastRepresentation = -1
    for (let index = records.length - 1; index >= 0; index--) {
      if (records[index]?.kind === 'representation') {
        lastRepresentation = index
        break
      }
    }
    const visibleRecords =
      input.includeArchived || lastRepresentation < 0
        ? records
        : records.slice(lastRepresentation)
    const visibleIds = new Set(visibleRecords.map((record) => record.transitionId))
    const latestOutcomes = latestTransitionOutcomes(events)
    const eventCertifications = events
      .map((event) => toCertificate(event, currentHead, latestOutcomes))
      .filter((certificate): certificate is StateCertificate => certificate !== undefined)
      .filter((certificate) =>
        certificate.targets.every((target) => visibleIds.has(target.transitionId)),
      )
      .reverse()
    const durableCertificate = currentHead
      ? durableCurrentCertificate(currentHead, latestOutcomes)
      : undefined
    const certifications = durableCertificate
      ? [
          durableCertificate,
          ...eventCertifications.filter(
            (certificate) =>
              certificate.certificateId !== durableCertificate.certificateId,
          ),
        ]
      : eventCertifications
    const certificatesBySequence = new Map(
      certifications.map((certificate) => [certificate.sequence, certificate]),
    )
    const latestCertificate = new Map<string, StateCertificate>()
    for (const record of visibleRecords) {
      const outcome = latestOutcomes.get(record.transitionId)
      if (outcome?.phase !== 'certified') continue
      const certificate = certificatesBySequence.get(outcome.event.sequence)
      if (certificate) latestCertificate.set(record.transitionId, certificate)
    }
    if (durableCertificate) {
      latestCertificate.set(currentHead!.transitionId, durableCertificate)
    }
    const archiveBoundaryId =
      input.includeArchived !== true && lastRepresentation > 0
        ? records[lastRepresentation]?.transitionId
        : undefined
    const filtered = (input.label
      ? visibleRecords.filter(
          (record) =>
            record.label === input.label ||
            record.to === input.label ||
            (record.from === input.label &&
              record.transitionId !== archiveBoundaryId),
        )
      : visibleRecords
    ).map((record) => {
      const certificate = latestCertificate.get(record.transitionId)
      return certificate
        ? { ...record, certificationStatus: 'certified' as const, certificate }
        : record
    })
    const limited =
      input.limit !== undefined && input.limit > 0
        ? filtered.slice(0, input.limit)
        : filtered
    const labelSet = new Set<string>()
    const limitedIds = new Set<string>()
    for (const record of limited) {
      limitedIds.add(record.transitionId)
      if (record.from && record.transitionId !== archiveBoundaryId) {
        labelSet.add(record.from)
      }
      labelSet.add(record.to)
      labelSet.add(record.label)
    }
    return {
      transitions: limited,
      labels: [...labelSet],
      certifications: certifications.filter((certificate) =>
        certificate.targets.some((target) => limitedIds.has(target.transitionId)),
      ),
    }
  }

  complexity(input: { files?: string[]; cwd: string }): StateComplexityResult {
    const requestedFiles = input.files ?? this.complexityLedgers().map((entry) => entry.file)
    const files: StateComplexityFile[] = []
    let netDelta = 0
    for (const file of this.normalizeComplexityFiles(requestedFiles, input.cwd)) {
      const measured = countFileComplexity(path.resolve(input.cwd, file))
      if (!measured) {
        files.push({ file, supported: false })
        continue
      }
      const ledger = this.readComplexityLedger(file)
      const delta = ledger ? measured.count - ledger.count : 0
      netDelta += delta
      files.push({
        file,
        supported: true,
        language: measured.language,
        current: measured.count,
        ...(ledger
          ? {
              recorded: ledger.count,
              delta,
              recordedDelta: ledger.lastDelta,
            }
          : { delta: 0 }),
      })
    }
    return { files, netDelta }
  }

  private prepareComplexity(
    files: string[],
    cwd: string,
    ts: number,
  ): PreparedComplexity {
    const deltas: StateComplexityDelta[] = []
    const updates: PreparedComplexity['updates'] = []
    let netDelta = 0
    for (const file of this.normalizeComplexityFiles(files, cwd)) {
      const measured = countFileComplexity(path.resolve(cwd, file))
      if (!measured) {
        deltas.push({ file, supported: false })
        continue
      }
      const entry = this.getState(this.complexityKey(file))
      const previous = entry ? (entry.value as unknown as ComplexityLedgerValue).count : undefined
      const delta = previous === undefined ? 0 : measured.count - previous
      netDelta += delta
      deltas.push({
        file,
        supported: true,
        language: measured.language,
        ...(previous !== undefined ? { previous } : {}),
        current: measured.count,
        delta,
        baseline: previous === undefined,
      })
      const key = this.complexityKey(file)
      updates.push({
        key,
        value: {
          file,
          language: measured.language,
          count: measured.count,
          lastDelta: delta,
          ts,
        },
        expectedVersion: entry?.version ?? 0,
        before: entry,
      })
    }
    return { record: { files: deltas, netDelta }, updates }
  }

  private complexityLedgers(): ComplexityLedgerValue[] {
    return this.mesh
      .snapshot()
      .states
      .filter((entry) => entry.key.startsWith(COMPLEXITY_KEY_PREFIX))
      .map((entry) => entry.value as unknown as ComplexityLedgerValue)
      .filter(
        (value) =>
          typeof value.file === 'string' &&
          typeof value.language === 'string' &&
          typeof value.count === 'number' &&
          typeof value.lastDelta === 'number',
      )
  }

  private readComplexityLedger(file: string): ComplexityLedgerValue | undefined {
    const entry = this.getState(this.complexityKey(file))
    return entry ? (entry.value as unknown as ComplexityLedgerValue) : undefined
  }

  private complexityKey(file: string): string {
    return `${COMPLEXITY_KEY_PREFIX}${file}`
  }

  private normalizeComplexityFiles(files: string[], cwd: string): string[] {
    const normalized = new Set<string>()
    for (const file of files) {
      if (!file.trim()) continue
      const relative = path.relative(cwd, path.resolve(cwd, file))
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`State complexity file must be inside the project cwd: ${file}`)
      }
      normalized.add(relative.split(path.sep).join('/'))
    }
    return [...normalized]
  }

  async goal(
    input: { check: string; description?: string },
  ): Promise<FabricStateRecord> {
    const value: StateGoal = {
      check: input.check,
      ...(input.description !== undefined ? { description: input.description } : {}),
    }
    return this.cas(GOAL_KEY, this.getState(GOAL_KEY)?.version ?? 0, value)
  }

  async checkGoal(input: {
    cwd: string
    timeoutMs?: number
    signal?: AbortSignal | undefined
  }): Promise<{
    passed: boolean
    output: string
    exitCode: number | null
    error?: string
  }> {
    const entry = this.getState(GOAL_KEY)
    if (!entry) throw new Error('No goal set')
    const goal = entry.value as unknown as StateGoal
    const result = await runCommand(goal.check, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 30_000,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const passed = result.status === 'confirmed'
    if (passed) {
      const check = truncateUtf8(goal.check, EVENT_TEXT_MAX_BYTES)
      const output = truncateUtf8(result.output, EVENT_OUTPUT_MAX_BYTES)
      await this.publish('state.goal.met', {
        check: check.value,
        checkDigest: digest(goal.check),
        checkOmittedBytes: check.omittedBytes,
        output: output.value,
        outputBytes: result.outputBytes,
        outputOmittedBytes: result.outputOmittedBytes + output.omittedBytes,
        outputDigest: result.outputDigest,
        exitCode: result.exitCode,
      }, 'goal met')
    }
    return {
      passed,
      output: result.output,
      exitCode: result.exitCode,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
  }

  private async persistCurrentCertificate(
    certificate: StateCertificate,
    verificationHead: StateHead,
  ): Promise<StateCertificate> {
    const current = this.getState(CURRENT_KEY)
    const currentValue = current?.value as StateHeadValue | undefined
    if (
      !current ||
      current.version !== verificationHead.version ||
      currentValue?.transitionId !== verificationHead.transitionId ||
      currentValue.label !== verificationHead.label ||
      currentValue.to !== verificationHead.to
    ) {
      return { ...certificate, current: false }
    }
    const certificateHead = certificate.head
    if (certificateHead === null) return { ...certificate, current: false }
    const nextVersion = current.version + 1
    const durableCertificate: StateCertificate = {
      ...certificate,
      head: { ...certificateHead, version: nextVersion },
      current: true,
    }
    try {
      const written = await this.cas(CURRENT_KEY, current.version, {
        ...currentValue,
        certificate: durableCertificate,
      } satisfies StateHeadValue)
      return written.version === nextVersion
        ? durableCertificate
        : { ...durableCertificate, current: false }
    } catch (error) {
      if (isCasError(error)) return { ...certificate, current: false }
      throw error
    }
  }

  private async revokeCurrentCertificate(
    verificationHead: StateHead,
  ): Promise<void> {
    const current = this.getState(CURRENT_KEY)
    const currentValue = current?.value as StateHeadValue | undefined
    if (
      !current ||
      current.version !== verificationHead.version ||
      currentValue?.transitionId !== verificationHead.transitionId ||
      currentValue.label !== verificationHead.label ||
      currentValue.to !== verificationHead.to ||
      currentValue.certificate === undefined
    ) {
      return
    }
    const { certificate: _certificate, ...withoutCertificate } = currentValue
    try {
      await this.cas(CURRENT_KEY, current.version, withoutCertificate)
    } catch (error) {
      if (!isCasError(error)) throw error
    }
  }

  async verify(input: {
    labels?: string[]
    includeArchived?: boolean
    cwd: string
    timeoutMs?: number
    signal?: AbortSignal | undefined
  }): Promise<VerificationReport> {
    const verificationHead = this.getHead()
    const boundedHeadLabel = verificationHead
      ? truncateUtf8(verificationHead.label, EVENT_TEXT_MAX_BYTES)
      : undefined
    const boundedHeadTo = verificationHead
      ? truncateUtf8(verificationHead.to, EVENT_TEXT_MAX_BYTES)
      : undefined
    const headIdentity: StateCertificationHead | null =
      verificationHead && boundedHeadLabel && boundedHeadTo
        ? {
            transitionId: verificationHead.transitionId,
            label: boundedHeadLabel.value,
            labelDigest: digest(verificationHead.label),
            ...(boundedHeadLabel.omittedBytes > 0
              ? { labelOmittedBytes: boundedHeadLabel.omittedBytes }
              : {}),
            to: boundedHeadTo.value,
            toDigest: digest(verificationHead.to),
            ...(boundedHeadTo.omittedBytes > 0
              ? { toOmittedBytes: boundedHeadTo.omittedBytes }
              : {}),
            version: verificationHead.version,
          }
        : null
    let targets: StateTransitionRecord[]
    if (input.labels !== undefined) {
      const matches = new Map<string, StateTransitionRecord>()
      for (const label of input.labels.filter((item) => item.trim().length > 0)) {
        const { transitions } = this.history({
          label,
          includeArchived: input.includeArchived === true,
        })
        for (const transition of transitions) {
          matches.set(transition.transitionId, transition)
        }
      }
      targets = [...matches.values()].sort(
        (left, right) => left.sequence - right.sequence,
      )
    } else if (verificationHead) {
      const { transitions } = this.history({
        includeArchived: input.includeArchived === true,
      })
      const match = transitions.find(
        (record) => record.transitionId === verificationHead.transitionId,
      )
      targets = match ? [match] : []
    } else {
      targets = []
    }

    const certificationTargets: StateCertificationTarget[] = targets.map((target) => ({
      transitionId: target.transitionId,
      label: target.label,
      to: target.to,
    }))
    const evidenceDigest = digest(
      targets.map((target) => ({
        transitionId: target.transitionId,
        label: target.label,
        to: target.to,
        evidence: target.evidence ?? [],
      })),
    )
    const results: VerifyResult[] = []
    const failures: VerificationFailure[] = []
    if (targets.length === 0) {
      failures.push({
        reason: 'missing-target',
        message:
          input.labels === undefined
            ? 'No current state transition is available to verify'
            : 'No active state transitions matched the requested labels',
      })
    }

    for (const target of targets) {
      const evidence = target.evidence ?? []
      if (evidence.length === 0) {
        failures.push({
          reason: 'missing-evidence',
          message: `Transition "${target.label}" has no executable evidence`,
          transitionId: target.transitionId,
          label: target.label,
        })
      }
      for (const command of evidence) {
        const result: CommandResult = input.signal?.aborted
          ? {
              status: 'error',
              exitCode: null,
              output: '',
              outputBytes: 0,
              outputOmittedBytes: 0,
              outputDigest: digest(''),
              error: 'aborted before execution',
            }
          : await runCommand(command, {
              cwd: input.cwd,
              timeoutMs: input.timeoutMs ?? 30_000,
              ...(input.signal ? { signal: input.signal } : {}),
            })
        results.push(toVerifyResult(target.summary, command, result))
      }
    }

    for (const result of results) {
      if (result.status === 'confirmed') continue
      failures.push({
        reason: result.status === 'violated' ? 'nonzero-exit' : 'execution-error',
        message:
          result.status === 'violated'
            ? `Evidence exited nonzero (${result.exitCode ?? 'unknown'}): ${result.command}`
            : `Evidence could not be confirmed: ${result.command}${result.error ? ` (${result.error})` : ''}`,
        command: result.command,
        status: result.status,
        exitCode: result.exitCode,
        ...(result.error !== undefined ? { error: result.error } : {}),
      })
    }

    let certified =
      results.length > 0 &&
      failures.length === 0 &&
      results.every((result) => result.status === 'confirmed')
    let resultDigest = digest({ results, failures })
    const boundedTargets = certificationTargets.map((target) => ({
      transitionId: truncateUtf8(target.transitionId, EVENT_TEXT_MAX_BYTES).value,
      label: truncateUtf8(target.label, EVENT_TEXT_MAX_BYTES).value,
      to: truncateUtf8(target.to, EVENT_TEXT_MAX_BYTES).value,
    }))
    const targetChunks: StateCertificationTarget[][] = []
    for (let index = 0; index < boundedTargets.length; index += EVENT_TARGET_LIMIT) {
      targetChunks.push(boundedTargets.slice(index, index + EVENT_TARGET_LIMIT))
    }
    if (targetChunks.length === 0) targetChunks.push([])
    const targetsCurrentHead =
      verificationHead !== null &&
      certificationTargets.some(
        (target) => target.transitionId === verificationHead.transitionId,
      )
    const publishViolation = async (): Promise<string | undefined> => {
      const nonConfirmed = results.filter((result) => result.status !== 'confirmed')
      try {
        for (let index = 0; index < targetChunks.length; index++) {
          await this.publish('state.violated', {
            certified: false,
            head: headIdentity,
            evidenceDigest,
            resultDigest,
            targets: targetChunks[index],
            targetChunk: { index, count: targetChunks.length },
            results: index === 0
              ? nonConfirmed.slice(0, EVENT_RESULT_LIMIT).map(toEventResult)
              : [],
            omittedResultCount: Math.max(0, nonConfirmed.length - EVENT_RESULT_LIMIT),
            reasons: index === 0
              ? failures.slice(0, EVENT_RESULT_LIMIT).map(toEventFailure)
              : [],
            omittedReasonCount: Math.max(0, failures.length - EVENT_RESULT_LIMIT),
            ts: Date.now(),
          }, 'state certification blocked')
        }
        return undefined
      } catch (error) {
        return boundedError(error)
      }
    }
    const recordViolation = async (): Promise<string | undefined> => {
      let revocationError: string | undefined
      if (targetsCurrentHead && verificationHead) {
        try {
          await this.revokeCurrentCertificate(verificationHead)
        } catch (error) {
          revocationError = `current certificate revocation failed: ${boundedError(error)}`
        }
      }
      const publishError = await publishViolation()
      return [revocationError, publishError]
        .filter((value): value is string => value !== undefined)
        .join('; ') || undefined
    }

    if (!certified) {
      const reportingError = await recordViolation()
      return {
        results,
        certified: false,
        violated: true,
        certificationStatus: 'failed',
        evidenceDigest,
        resultDigest,
        failures,
        ...(reportingError ? { reportingError } : {}),
      }
    }

    const ts = Date.now()
    try {
      let certificateEvent: SchemaMeshEvent | undefined
      for (let index = 0; index < targetChunks.length; index++) {
        const event = await this.publish('state.certified', {
          certificationStatus: 'certified',
          targets: targetChunks[index],
          targetChunk: { index, count: targetChunks.length },
          head: headIdentity,
          evidenceDigest,
          resultDigest,
          ts,
        }, 'state certified')
        if (
          certificateEvent === undefined ||
          targetChunks[index]?.some(
            (target) => target.transitionId === headIdentity?.transitionId,
          )
        ) {
          certificateEvent = event
        }
      }
      if (!certificateEvent) throw new Error('State certificate event was not recorded')
      const certificate = toCertificate(certificateEvent, this.getHead())
      if (!certificate) throw new Error('State certificate event was malformed')
      const durableCertificate = verificationHead && certificate.current
        ? await this.persistCurrentCertificate(
            certificate,
            verificationHead,
          )
        : certificate
      return {
        results,
        certified: true,
        violated: false,
        certificationStatus: 'certified',
        evidenceDigest,
        resultDigest,
        failures,
        certificate: durableCertificate,
      }
    } catch (error) {
      certified = false
      const certificationReportingError = boundedError(error)
      failures.push({
        reason: 'reporting-error',
        message: `Certification could not be recorded: ${certificationReportingError}`,
        error: certificationReportingError,
      })
      resultDigest = digest({ results, failures })
      const violationReportingError = await recordViolation()
      const reportingError = violationReportingError
        ? `${certificationReportingError}; violation reporting failed: ${violationReportingError}`
        : certificationReportingError
      return {
        results,
        certified,
        violated: true,
        certificationStatus: 'failed',
        evidenceDigest,
        resultDigest,
        failures,
        reportingError,
      }
    }
  }
}

function topicId(value: string): FabricTopicId {
  return FabricTopicId(value)
}

function eventFromMessage(message: FabricTopicMessage): SchemaMeshEvent {
  const payload = (message.payload ?? {}) as Record<string, unknown>
  const kind = typeof payload.kind === 'string' ? payload.kind : 'unknown'
  const sequence = typeof payload.sequence === 'number' ? payload.sequence : 0
  const ts = typeof payload.ts === 'number' ? payload.ts : message.publishedAt
  const from = typeof payload.from === 'string' ? payload.from : undefined
  const text = typeof payload.text === 'string' ? payload.text : undefined
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : undefined
  return {
    id: message.id,
    sequence,
    kind,
    ...(from !== undefined ? { from } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(data !== undefined ? { data } : {}),
    createdAt: ts,
  }
}

export default StateStore
