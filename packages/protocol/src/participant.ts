import type {
  FabricNodeId,
  FabricNodeStatus,
  FabricSessionInput,
} from './types.ts'

/** Semantic participant classes independent of the underlying agent executor. */
export type FabricParticipantKind = 'root' | 'session' | 'agent' | 'actor'

/** How long the authoritative runtime behind a participant is expected to exist. */
export type FabricParticipantResidency = 'session' | 'durable'

/** Truthful controls exposed by the supplying participant adapter. */
export type FabricParticipantCapability = 'open-session' | 'send-message'

/** Authority that supplied one participant record. */
export type FabricParticipantSource = 'session-mirror' | 'fabric-actor'

/** Fabric-facing identity for an authoritative session, delegated agent, or actor endpoint. */
export interface FabricParticipantRecord {
  format: 1
  id: FabricNodeId
  kind: FabricParticipantKind
  rootId: FabricNodeId
  parentId?: FabricNodeId
  name: string
  status: FabricNodeStatus
  residency: FabricParticipantResidency
  capabilities: readonly FabricParticipantCapability[]
  source: FabricParticipantSource
  updatedAt: number
  sessionId?: string
  cwd?: string
  preset?: string
  jobCount: number
  tokens?: number
  durationMs?: number
  detail?: string
}

/** Selected participant family projected from a retained session mirror. */
export interface FabricParticipantDirectory {
  rootId: FabricNodeId
  selectedId: FabricNodeId
  participants: readonly FabricParticipantRecord[]
}

/** Convert a session identity into the stable Fabric participant namespace. */
function fabricSessionNodeId(sessionId: string): FabricNodeId {
  return `session:${sessionId}` as FabricNodeId
}

/**
 * Build Fabric semantic identities over an authoritative session mirror and actor records.
 * This is a read projection only; the supplying runtime retains lifecycle authority.
 */
export function buildParticipantDirectory(
  sessions: readonly FabricSessionInput[],
  selectedSessionId: string,
): FabricParticipantDirectory | null {
  const byId = new Map(sessions.map(session => [session.id, session]))
  if (!byId.has(selectedSessionId)) return null

  const rootSessionId = findRoot(byId, selectedSessionId)
  const children = new Map<string, FabricSessionInput[]>()
  for (const session of sessions) {
    if (session.parentId === undefined || !byId.has(session.parentId)) continue
    const values = children.get(session.parentId) ?? []
    values.push(session)
    children.set(session.parentId, values)
  }
  for (const values of children.values()) values.sort((left, right) => left.id.localeCompare(right.id))

  const lineage: FabricSessionInput[] = []
  const visited = new Set<string>()
  const pending = [rootSessionId]
  while (pending.length > 0) {
    const sessionId = pending.pop()
    if (sessionId === undefined || visited.has(sessionId)) continue
    const session = byId.get(sessionId)
    if (session === undefined) continue
    visited.add(sessionId)
    lineage.push(session)
    const descendants = children.get(sessionId) ?? []
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      const child = descendants[index]
      if (child !== undefined) pending.push(child.id)
    }
  }

  const rootId = fabricSessionNodeId(rootSessionId)
  const participants: FabricParticipantRecord[] = lineage.map((session) => {
    const id = fabricSessionNodeId(session.id)
    const root = session.id === rootSessionId
    return {
      format: 1,
      id,
      kind: root ? 'root' : session.origin === 'subagent' ? 'agent' : 'session',
      rootId,
      ...(root || session.parentId === undefined || !visited.has(session.parentId)
        ? {}
        : { parentId: fabricSessionNodeId(session.parentId) }),
      name: session.label,
      status: sessionStatus(session),
      residency: 'session',
      capabilities: ['open-session'],
      source: 'session-mirror',
      updatedAt: session.updatedAt,
      sessionId: session.id,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.preset === undefined ? {} : { preset: session.preset }),
      jobCount: session.jobCount ?? 0,
      ...(session.tokens === undefined ? {} : { tokens: session.tokens }),
      ...(session.durationMs === undefined ? {} : { durationMs: session.durationMs }),
    }
  })

  const actorById = new Map<FabricNodeId, { participant: FabricParticipantRecord; owned: boolean }>()
  for (const owner of lineage) {
    const projection = owner.activity
    if (projection === undefined) continue
    const ownerId = fabricSessionNodeId(owner.id)
    for (const node of projection.nodes) {
      if (node.kind !== 'actor') continue
      const id = node.id as FabricNodeId
      const owned = projection.edges.some(edge =>
        edge.source === '$session'
        && edge.target === node.id
        && edge.kind === 'contains')
      const candidate: FabricParticipantRecord = {
        format: 1,
        id,
        kind: 'actor',
        rootId,
        parentId: ownerId,
        name: node.label,
        status: node.status,
        residency: 'durable',
        capabilities: ['send-message'],
        source: 'fabric-actor',
        updatedAt: node.updatedAt,
        jobCount: 0,
        ...(node.detail === undefined ? {} : { detail: node.detail }),
      }
      const existing = actorById.get(id)
      if (existing === undefined
        || (owned && !existing.owned)
        || (owned === existing.owned && candidate.updatedAt >= existing.participant.updatedAt)) {
        actorById.set(id, { participant: candidate, owned })
      }
    }
  }
  participants.push(...[...actorById.values()]
    .map(value => value.participant)
    .toSorted((left, right) => left.name.localeCompare(right.name) || String(left.id).localeCompare(String(right.id))))

  return {
    rootId,
    selectedId: fabricSessionNodeId(selectedSessionId),
    participants,
  }
}

function findRoot(byId: ReadonlyMap<string, FabricSessionInput>, selectedSessionId: string): string {
  const lineage: string[] = []
  const seen = new Set<string>()
  let current = selectedSessionId
  while (!seen.has(current)) {
    seen.add(current)
    lineage.push(current)
    const parent = byId.get(current)?.parentId
    if (parent === undefined || !byId.has(parent)) return current
    current = parent
  }
  return lineage.toSorted()[0] ?? selectedSessionId
}

function sessionStatus(session: FabricSessionInput): FabricNodeStatus {
  if (session.blocked === true) return 'blocked'
  if (session.running) return 'running'
  if (session.completed === true) return 'completed'
  return 'idle'
}
