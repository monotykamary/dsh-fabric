import { describe, expect, it } from 'vitest'
import { createToolResultMessage } from '@monotykamary/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@monotykamary/dsh-session'
import type { SessionEvent } from '@monotykamary/dsh-session'
import { fabricMeshResultMeta } from '@dsh-fabric/protocol'
import { createFabricActivityProjection } from '../src/projection.ts'
import type {} from '../src/types.ts'

/** Native tool/result events survive DSH persistence without plugin event registration. */
describe('DSH session persistence compatibility', () => {
  it('round-trips mesh activity through a core-known event and replays its projection', () => {
    const session = Session.create(SessionId('fabric-native-persistence'))
    const callId = 'mesh-create-actor' as never
    const value = { id: 'builder', label: 'Builder', createdAt: 100, updatedAt: 100 }
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: JSON.stringify(value) }],
        isError: false,
      }),
      meta: fabricMeshResultMeta({ action: 'create_actor', id: 'builder', label: 'Builder' }, value, 100) as never,
    }, { surfaceOp: 'append' })

    const stored = JSON.parse(JSON.stringify(session.events)) as SessionEvent[]
    expect(stored.every(event => KNOWN_SESSION_EVENT_TYPES.has(String(event.type)))).toBe(true)
    expect(stored.some(event => String(event.type) === 'fabric/activity')).toBe(false)

    const restored = Session.create(SessionId('fabric-native-persistence-restored'), stored)
    const projection = createFabricActivityProjection()
    const state = restored.events.reduce((current, event) => projection.apply(current, event), projection.init())
    expect(projection.view(state)).toMatchObject({
      activities: [expect.objectContaining({ kind: 'actor', action: 'created' })],
      nodes: [expect.objectContaining({ id: 'actor:builder', status: 'idle' })],
      edges: [expect.objectContaining({ source: '$session', target: 'actor:builder' })],
    })
  })
})
