/**
 * Typed records for the Fabric schema-enforced world state.
 *
 * Ported from pi-fabric's `src/state/types.ts` and `src/schema/types.ts`
 * (the Schema world-model heart): an append-only Timeline of typed,
 * validated transitions stored as mesh events, a compare-and-swap head
 * pointer recomputable from the log, and a falsifiable hypothesis /
 * certificate transaction surface over the workspace. Raw mesh calls
 * (`fabric_mesh` snapshot / get_state / read_topic) can inspect
 * everything here; the typed tools validate the calls that use them.
 */

/** A labeled world-state transition (`state` moves state, `representation` revises the state schema and archives earlier labels). */
export type StateTransitionKind = 'state' | 'representation'
type StateCertificationStatus = 'pending' | 'certified'
export type StateTransitionPhase = 'proposed' | 'committed' | 'rejected'

export interface StateTransitionInput {
  label: string
  from?: string
  to: string
  summary: string
  evidence?: string[]
  tags?: string[]
  kind?: StateTransitionKind
  complexity?: { files: string[] }
  force?: boolean
}

export interface StateComplexityDelta {
  file: string
  supported: boolean
  language?: string
  previous?: number
  current?: number
  delta?: number
  baseline?: boolean
}

export interface StateTransitionComplexity {
  files: StateComplexityDelta[]
  netDelta: number
}

export interface StateComplexityFile {
  file: string
  supported: boolean
  language?: string
  current?: number
  recorded?: number
  delta?: number
  recordedDelta?: number
}

export interface StateComplexityResult {
  files: StateComplexityFile[]
  netDelta: number
}

export interface StateComplexitySummary {
  files: number
  decisionPoints: number
  lastNetDelta: number
}

export interface StateTransitionRecord {
  transitionId: string
  sequence: number
  label: string
  from?: string
  to: string
  summary: string
  evidence?: string[]
  tags?: string[]
  kind: StateTransitionKind
  complexity?: StateTransitionComplexity
  certificationStatus?: StateCertificationStatus
  certificate?: StateCertificate
  ts: number
}

interface StateHeadCommitProof {
  version: 1
  status: 'pending' | 'committed'
}

export interface StateHeadValue {
  protocolVersion?: number
  commitProof?: StateHeadCommitProof
  transitionSequence?: number
  label: string
  from?: string
  to: string
  summary: string
  evidence?: string[]
  tags?: string[]
  kind: StateTransitionKind
  complexity?: StateTransitionComplexity
  transitionId: string
  certificationStatus?: StateCertificationStatus
  certificate?: StateCertificate
  ts: number
}

export interface StateHead extends StateHeadValue {
  version: number
}

export interface AdvanceHeadInput {
  payload: StateHeadValue
  from: string | undefined
  force: boolean
  expectedVersion: number
}

export interface StateGoal {
  check: string
  description?: string
}

export type VerifyStatus = 'confirmed' | 'violated' | 'error'

export interface VerifyResult {
  claim: string
  claimDigest: string
  claimOmittedBytes?: number
  command: string
  commandDigest: string
  commandOmittedBytes?: number
  status: VerifyStatus
  exitCode: number | null
  output: string
  outputBytes: number
  outputOmittedBytes: number
  outputDigest: string
  error?: string
  errorDigest?: string
  errorOmittedBytes?: number
}

export interface StateCertificationTarget {
  transitionId: string
  label: string
  to: string
}

export interface StateCertificationHead {
  transitionId: string
  label: string
  labelDigest?: string
  labelOmittedBytes?: number
  to: string
  toDigest?: string
  toOmittedBytes?: number
  version: number
}

export interface StateCertificate {
  certificateId: string
  sequence: number
  certificationStatus: 'certified'
  targets: StateCertificationTarget[]
  head: StateCertificationHead | null
  evidenceDigest: string
  resultDigest: string
  ts: number
  current: boolean
}

export interface VerificationFailure {
  reason:
    | 'missing-target'
    | 'missing-evidence'
    | 'nonzero-exit'
    | 'execution-error'
    | 'reporting-error'
  message: string
  transitionId?: string
  label?: string
  command?: string
  status?: VerifyStatus
  exitCode?: number | null
  error?: string
}

export interface VerificationReport {
  results: VerifyResult[]
  certified: boolean
  violated: boolean
  certificationStatus: 'certified' | 'failed'
  evidenceDigest: string
  resultDigest: string
  failures: VerificationFailure[]
  certificate?: StateCertificate
  reportingError?: string
}

/** Schema evidence kinds: typed, falsifiable claims over the workspace. */
export type SchemaEvidence =
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_absent'; path: string }
  | { kind: 'file_contains'; path: string; literal: string }
  | { kind: 'file_sha256'; path: string; sha256: string }
  | { kind: 'trusted_command'; name: string }

/** Schema transaction file operations with SHA-256 preconditions. */
export type SchemaFileOperation =
  | { kind: 'write'; path: string; content: string; expected: { absent: true } | { sha256: string } }
  | { kind: 'edit'; path: string; oldText: string; newText: string; expectedSha256: string }
  | { kind: 'delete'; path: string; expectedSha256: string }

export interface SchemaStateBinding {
  transitionId: string
  version: number
  to: string
}

export const stateBinding = (head: StateHead | null): SchemaStateBinding | null =>
  head
    ? { transitionId: head.transitionId, version: head.version, to: head.to }
    : null

export interface SchemaHypothesisRecord {
  id: string
  label: string
  summary: string
  evidence: SchemaEvidence[]
  complexityReduction: boolean
  parentToolCallId: string
  state: SchemaStateBinding | null
  fingerprint: string
  generation: number
  status: 'active' | 'verified' | 'committed' | 'aborted' | 'abandoned'
  createdAt: number
  updatedAt: number
}

export interface SchemaCertificateRecord {
  tokenHash: string
  hypothesisId: string
  parentToolCallId: string
  state: SchemaStateBinding | null
  fingerprint: string
  generation: number
  issuedAt: number
  expiresAt: number
  status: 'active' | 'consumed' | 'aborted' | 'abandoned'
  consumedAt?: number
}

export interface SchemaEvidenceResult {
  evidence: SchemaEvidence
  status: 'confirmed' | 'nonconfirmed' | 'error'
  detail: string
  exitCode?: number | null
  output?: string
  observedSha256?: string
}

export interface SchemaWorkspaceRecord {
  generation: number
  lastOutcome?: 'committed' | 'rolled_back' | 'quarantined'
  lastTransactionId?: string
  updatedAt: number
}
