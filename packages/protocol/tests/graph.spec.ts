import { describe, expect, it } from 'vitest'
import { buildLineageGraph } from '../src/index.ts'
import type { FabricActivityProjection } from '../src/index.ts'

const session = (id: string, parentId?: string) => ({
  id,
  label: id,
  ...(parentId === undefined ? {} : { parentId, origin: 'subagent' as const }),
  running: id === 'child',
  completed: id === 'done',
  updatedAt: id.length,
})

describe('buildLineageGraph', () => {
  it('roots the selected descendant at its oldest known ancestor', () => {
    const graph = buildLineageGraph([
      session('main'),
      session('child', 'main'),
      session('done', 'child'),
      session('other'),
    ], 'done')

    expect(graph?.nodes.map(node => [node.sessionId, node.kind, node.status])).toEqual([
      ['main', 'main', 'idle'],
      ['child', 'subagent', 'running'],
      ['done', 'subagent', 'completed'],
    ])
    expect(graph?.edges).toHaveLength(2)
    expect(graph?.activities).toHaveLength(3)
  })

  it('terminates malformed parent cycles deterministically', () => {
    const graph = buildLineageGraph([
      session('b', 'a'),
      session('a', 'b'),
    ], 'b')

    expect(graph?.nodes.map(node => node.sessionId).sort()).toEqual(['a', 'b'])
  })

  it('merges projected workflow nodes and resolves the owner endpoint', () => {
    const activity: FabricActivityProjection = {
      activities: [{ id: 'start', kind: 'workflow', action: 'started', label: 'audit', status: 'running', updatedAt: 10, nodeId: 'workflow:1' }],
      nodes: [{ id: 'workflow:1', kind: 'workflow', label: 'audit', status: 'running', updatedAt: 10 }],
      edges: [{ id: 'owns', source: '$session', target: 'workflow:1', kind: 'contains' }],
    }
    const graph = buildLineageGraph([{ ...session('main'), activity }], 'main')

    expect(graph?.nodes.map(node => node.id)).toContain('workflow:1')
    expect(graph?.edges).toContainEqual(expect.objectContaining({ source: 'session:main', target: 'workflow:1', kind: 'contains' }))
    expect(graph?.activities.at(-1)?.nodeId).toBe('workflow:1')
  })

  it('returns null when the selected session is absent', () => {
    expect(buildLineageGraph([session('main')], 'missing')).toBeNull()
  })
})
