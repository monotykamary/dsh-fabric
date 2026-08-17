import { describe, expect, it } from 'vitest'
import {
  buildParticipantDirectory,
  type FabricSessionInput,
} from '../src/index.ts'

function sessions(): FabricSessionInput[] {
  return [
    {
      id: 'root',
      label: 'Main conversation',
      running: true,
      updatedAt: 10,
      cwd: '/workspace',
      preset: 'researcher',
      activity: {
        nodes: [
          { id: 'actor:owned', kind: 'actor', label: 'Archivist', status: 'idle', updatedAt: 8 },
        ],
        edges: [
          { id: 'owns-actor', source: '$session', target: 'actor:owned', kind: 'contains' },
        ],
        activities: [],
      },
    },
    {
      id: 'fork',
      label: 'Forked session',
      parentId: 'root',
      running: false,
      completed: true,
      updatedAt: 7,
    },
    {
      id: 'agent',
      label: 'Design agent',
      parentId: 'root',
      origin: 'subagent',
      running: false,
      blocked: true,
      updatedAt: 9,
      activity: {
        nodes: [
          { id: 'actor:owned', kind: 'actor', label: 'Observed alias', status: 'running', updatedAt: 12 },
        ],
        edges: [
          { id: 'observes-actor', source: '$session', target: 'actor:owned', kind: 'route' },
        ],
        activities: [],
      },
    },
  ]
}

describe('buildParticipantDirectory', () => {
  it('projects roots, peer sessions, delegated agents, and durable actors', () => {
    const directory = buildParticipantDirectory(sessions(), 'agent')

    expect(directory?.rootId).toBe('session:root')
    expect(directory?.selectedId).toBe('session:agent')
    expect(directory?.participants.every(participant => participant.format === 1)).toBe(true)
    expect(directory?.participants.map(participant => [
      participant.id,
      participant.kind,
      participant.parentId,
      participant.residency,
      participant.status,
    ])).toEqual([
      ['session:root', 'root', undefined, 'session', 'running'],
      ['session:agent', 'agent', 'session:root', 'session', 'blocked'],
      ['session:fork', 'session', 'session:root', 'session', 'completed'],
      ['actor:owned', 'actor', 'session:root', 'durable', 'idle'],
    ])
    expect(directory?.participants[0]).toMatchObject({
      cwd: '/workspace',
      preset: 'researcher',
      capabilities: ['open-session'],
      source: 'session-mirror',
    })
    expect(directory?.participants.at(-1)).toMatchObject({
      name: 'Archivist',
      capabilities: ['send-message'],
      source: 'fabric-actor',
    })
  })

  it('returns null for an unknown selected session', () => {
    expect(buildParticipantDirectory(sessions(), 'missing')).toBeNull()
  })
})
