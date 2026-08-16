import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@dsh-fabric/host/types'
import { buildFabricClientModel, layoutFabricTree } from '../src/client/model.ts'

function summary(id: string, parentId?: string): SessionSummary {
  return {
    id: id as SessionSummary['id'],
    displayTitle: id,
    ...(parentId === undefined ? {} : { parentId: parentId as SessionSummary['id'], origin: 'subagent' as const }),
    running: id === 'child',
    blank: false,
    updatedAt: id.length,
  }
}

function state(): SessionListState {
  const main = summary('main')
  const child = summary('child', 'main')
  main.projectionValues = {
    fabricActivity: {
      activities: [{ id: 'run-start', kind: 'workflow', action: 'started', label: 'audit', status: 'running', updatedAt: 10, nodeId: 'workflow:1' }],
      nodes: [{ id: 'workflow:1', kind: 'workflow', label: 'audit', status: 'running', updatedAt: 10 }],
      edges: [{ id: 'owner', source: '$session', target: 'workflow:1', kind: 'contains' }],
    },
  }
  return {
    ids: [main.id, child.id],
    byId: { [main.id]: main, [child.id]: child },
    current: child.id,
    state: 'idle',
    phase: 'ready',
    error: null,
    subagentsByParent: {},
    jobsBySession: { [child.id]: [{} as never] },
    currentAddress: undefined,
  }
}

describe('buildFabricClientModel', () => {
  it('projects lineage and host activity into one deterministic layout', () => {
    const model = buildFabricClientModel(state(), 'child', 1_000)
    expect(model?.graph.nodes.map(node => node.id)).toEqual(['session:main', 'session:child', 'workflow:1'])
    expect(model?.active.map(node => node.id)).toEqual(['workflow:1', 'session:child'])
    expect(model?.activity[0]?.label).toBe('audit')
    expect(model?.layout.nodes.find(node => node.node.id === 'session:main')?.y)
      .toBeLessThan(model?.layout.nodes.find(node => node.node.id === 'session:child')?.y ?? 0)
  })

  it('lays out cyclic traffic without recursive traversal', () => {
    const model = buildFabricClientModel(state(), 'child', 1_000)
    const graph = model?.graph
    if (graph === undefined) throw new Error('missing graph')
    const layout = layoutFabricTree({
      ...graph,
      edges: [...graph.edges, { id: 'cycle' as never, source: 'workflow:1' as never, target: 'session:main' as never, kind: 'route' }],
    })
    expect(layout.nodes).toHaveLength(graph.nodes.length)
  })
})
