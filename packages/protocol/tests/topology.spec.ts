import { describe, expect, it } from 'vitest'
import {
  buildFabricTopology,
  type FabricSessionInput,
} from '../src/index.ts'

function fixture(): FabricSessionInput[] {
  return [
    {
      id: 'root',
      label: 'Main',
      running: true,
      updatedAt: 100,
      activity: {
        nodes: [
          { id: 'workflow:w1', kind: 'workflow', label: 'Migration', status: 'running', updatedAt: 90 },
          { id: 'message:m1', kind: 'message', label: 'fabric.control', status: 'completed', updatedAt: 91 },
          { id: 'topic:fabric.control', kind: 'topic', label: 'fabric.control', status: 'idle', updatedAt: 92 },
          { id: 'state:state/complexity/payments/score', kind: 'state', label: 'state/complexity/payments/score', status: 'idle', updatedAt: 93 },
          { id: 'actor:reviewer', kind: 'actor', label: 'Reviewer', status: 'idle', updatedAt: 94 },
        ],
        edges: [
          { id: 'workflow-owner', source: '$session', target: 'workflow:w1', kind: 'contains' },
          { id: 'actor-owner', source: '$session', target: 'actor:reviewer', kind: 'contains' },
          { id: 'actor-route', source: '$session', target: 'actor:reviewer', kind: 'route', updatedAt: 94 },
          { id: 'topic-publish', source: 'topic:fabric.control', target: 'message:m1', kind: 'publish', updatedAt: 91 },
          { id: 'state-access', source: '$session', target: 'state:state/complexity/payments/score', kind: 'state', updatedAt: 93 },
        ],
        activities: [
          { id: 'workflow-start', kind: 'workflow', action: 'started', label: 'Migration', status: 'running', updatedAt: 90, nodeId: 'workflow:w1' },
          { id: 'published', kind: 'topic', action: 'published', label: 'fabric.control', status: 'completed', updatedAt: 91, nodeId: 'message:m1' },
        ],
      },
    },
    {
      id: 'fork',
      label: 'Peer session',
      parentId: 'root',
      running: false,
      blocked: true,
      updatedAt: 80,
    },
    {
      id: 'agent',
      label: 'Worker',
      parentId: 'root',
      origin: 'subagent',
      running: true,
      updatedAt: 95,
    },
    {
      id: 'nested',
      label: 'Nested worker',
      parentId: 'agent',
      origin: 'subagent',
      running: false,
      completed: true,
      updatedAt: 70,
    },
  ]
}

describe('buildFabricTopology', () => {
  it('separates participants and mesh resources from operational activity', () => {
    const snapshot = buildFabricTopology(fixture(), 'nested')
    const graph = snapshot?.graph
    expect(graph).toBeDefined()

    expect(graph?.nodes.map(node => node.id)).toEqual(expect.arrayContaining([
      'session:root',
      'group:participants',
      'group:participants:sessions',
      'group:participants:agents',
      'session:fork',
      'session:agent',
      'session:nested',
      'actor:reviewer',
      'group:mesh',
      'group:mesh:topics',
      'group:mesh:state',
      'topic:fabric.control',
      'state:state/complexity/payments/score',
    ]))
    expect(graph?.nodes.some(node => node.kind === 'workflow' || node.kind === 'message')).toBe(false)
    expect(graph?.activities.map(activity => activity.id)).toEqual(expect.arrayContaining([
      'projected:root:workflow-start',
      'projected:root:published',
    ]))
    expect(graph?.activities.find(activity => activity.id === 'projected:root:workflow-start')?.nodeId).toBe('session:root')
    expect(graph?.activities.find(activity => activity.id === 'projected:root:published')?.nodeId).toBe('topic:fabric.control')
    expect(graph?.activities.find(activity => activity.id === 'session-summary:fork')).toMatchObject({ action: 'blocked', status: 'blocked' })
  })

  it('builds deeply nested participant lineages without recursive overflow', () => {
    const depth = 3_000
    const sessions = Array.from({ length: depth }, (_, index): FabricSessionInput => ({
      id: 'deep-' + index,
      label: 'Deep ' + index,
      ...(index === 0 ? {} : { parentId: 'deep-' + (index - 1) }),
      running: false,
      updatedAt: index,
    }))
    const snapshot = buildFabricTopology(sessions, 'deep-' + (depth - 1))
    expect(snapshot?.directory.participants).toHaveLength(depth)
    expect(snapshot?.graph.edges.filter(edge => edge.role === 'structure')).toHaveLength((snapshot?.graph.nodes.length ?? 0) - 1)
  })

  it('gives every non-root node one structural parent and keeps traffic separate', () => {
    const graph = buildFabricTopology(fixture(), 'root')?.graph
    expect(graph).toBeDefined()
    const structural = graph?.edges.filter(edge => edge.role === 'structure') ?? []
    const incoming = new Map<string, number>()
    for (const edge of structural) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    for (const node of graph?.nodes ?? []) {
      expect(incoming.get(node.id) ?? 0).toBe(node.id === graph?.rootId ? 0 : 1)
    }

    expect(structural).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'group:participants:agents', target: 'session:agent' }),
      expect.objectContaining({ source: 'session:agent', target: 'session:nested' }),
    ]))
    expect(graph?.edges.filter(edge => edge.role === 'traffic')).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'session:root', target: 'actor:reviewer', kind: 'route' }),
      expect.objectContaining({ source: 'session:root', target: 'topic:fabric.control', kind: 'publish' }),
      expect.objectContaining({ source: 'session:root', target: 'state:state/complexity/payments/score', kind: 'state' }),
    ]))
  })
})
