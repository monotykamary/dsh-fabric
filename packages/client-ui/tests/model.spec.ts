import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@monotykamary/dsh-client-runtime/client'
import type {} from 'dsh-fabric-host/types'
import { buildFabricClientModel, layoutFabricTree, navigateFabricTopology } from '../src/client/model.ts'

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
  it('projects semantic participants while retaining operational activity', () => {
    const model = buildFabricClientModel(state(), 'child', 1_000)
    expect(model?.graph.nodes.map(node => node.id)).toEqual([
      'session:main',
      'session:child',
      'group:participants',
      'group:participants:agents',
    ])
    expect(model?.participants.map(participant => [participant.id, participant.kind])).toEqual([
      ['session:main', 'root'],
      ['session:child', 'agent'],
    ])
    expect(model?.active.map(participant => participant.id)).toEqual(['session:child'])
    expect(model?.activity[0]).toMatchObject({ label: 'audit', nodeId: 'session:main' })
  })

  it('joins live child provider and model telemetry into running workers', () => {
    const value = state()
    const main = value.byId['main' as keyof typeof value.byId]
    const child = value.byId['child' as keyof typeof value.byId]
    if (main === undefined || child === undefined) throw new Error('missing fixtures')
    main.projectionValues = { fabricActivity: {
      activities: [], nodes: [], edges: [],
      delegations: [{
        id: 'delegation:call', callId: 'call', label: 'Review', status: 'running', parallel: true,
        createdAt: 1, updatedAt: 2, workers: [{ id: 'call:0', index: 0, label: 'Reviewer', task: 'Review', tier: 'default', status: 'running', updatedAt: 2, childSessionId: 'child' }],
      }],
    } }
    child.projectionValues = { fabricActivity: {
      route: { provider: 'cursor', model: 'composer-2.5-fast' },
      activities: [{ id: 'activity', kind: 'agent', action: 'testing', label: 'Run focused tests', status: 'running', updatedAt: 20 }],
      nodes: [], edges: [], delegations: [],
    } }
    expect(buildFabricClientModel(value, 'main', 1_000)?.delegations[0]?.workers[0]).toMatchObject({
      actualProvider: 'cursor', actualModel: 'composer-2.5-fast',
      parentSessionId: 'main', currentActivity: 'Run focused tests · testing',
    })
  })

  it('places hierarchy left-to-right and shares its child order with keyboard navigation', () => {
    const model = buildFabricClientModel(state(), 'child', 1_000)
    if (model === null) throw new Error('missing model')
    const x = (id: string) => model.layout.nodes.find(value => value.node.id === id)?.x ?? 0
    expect(model.layout.nodes.map(value => value.node.id)).toEqual([
      'session:main',
      'group:participants',
      'group:participants:agents',
      'session:child',
    ])
    expect(x('session:main')).toBeLessThan(x('group:participants'))
    expect(x('group:participants')).toBeLessThan(x('group:participants:agents'))
    expect(x('group:participants:agents')).toBeLessThan(x('session:child'))
    expect(navigateFabricTopology(model.layout, 'session:main', 'child')).toBe('group:participants')
    expect(navigateFabricTopology(model.layout, 'session:child', 'parent')).toBe('group:participants:agents')
  })

  it('stacks a wide sibling level vertically instead of expanding canvas width', () => {
    const children = Array.from({ length: 12 }, (_, index) => ({
      id: ('session:child-' + index) as never,
      sessionId: 'child-' + index,
      kind: 'agent' as const,
      label: 'Child ' + index,
      status: 'idle' as const,
      updatedAt: index,
      order: 0,
      jobCount: 0,
    }))
    const root = {
      id: 'session:root' as never,
      sessionId: 'root',
      kind: 'main' as const,
      label: 'Root',
      status: 'idle' as const,
      updatedAt: 0,
      order: 0,
      jobCount: 0,
    }
    const layout = layoutFabricTree({
      rootId: root.id,
      nodes: [root, ...children],
      edges: children.map((child, index) => ({
        id: ('edge:' + index) as never,
        source: root.id,
        target: child.id,
        kind: 'contains' as const,
        role: 'structure' as const,
      })),
      activities: [],
    })
    const positionedChildren = layout.nodes.filter(value => value.node.kind === 'agent')
    expect(new Set(positionedChildren.map(value => value.x))).toHaveLength(1)
    expect(new Set(positionedChildren.map(value => value.y))).toHaveLength(children.length)
    expect(layout.width).toBe(640)
    expect(navigateFabricTopology(layout, positionedChildren[0]?.node.id ?? '', 'next')).toBe(positionedChildren[1]?.node.id)
  })

  it('lays out deeply nested structural trees without recursive overflow', () => {
    const depth = 3_000
    const nodes = Array.from({ length: depth }, (_, index) => ({
      id: ('deep:' + index) as never,
      kind: (index === 0 ? 'main' : 'session') as 'main' | 'session',
      label: 'Deep ' + index,
      status: 'idle' as const,
      updatedAt: index,
      jobCount: 0,
    }))
    const layout = layoutFabricTree({
      rootId: nodes[0]?.id ?? '' as never,
      nodes,
      edges: nodes.slice(1).map((node, index) => ({
        id: ('deep-edge:' + index) as never,
        source: nodes[index]?.id ?? '' as never,
        target: node.id,
        kind: 'parent' as const,
        role: 'structure' as const,
      })),
      activities: [],
    })
    expect(layout.nodes).toHaveLength(depth)
    expect(layout.nodes.find(value => value.node.id === 'deep:' + (depth - 1))?.depth).toBe(depth - 1)
  })

  it('ignores cyclic traffic when laying out the structural tree', () => {
    const model = buildFabricClientModel(state(), 'child', 1_000)
    const graph = model?.graph
    if (graph === undefined) throw new Error('missing graph')
    const layout = layoutFabricTree({
      ...graph,
      edges: [...graph.edges, {
        id: 'cycle' as never,
        source: 'session:child' as never,
        target: 'session:main' as never,
        kind: 'route',
        role: 'traffic',
      }],
    })
    expect(layout.nodes).toHaveLength(graph.nodes.length)
    expect(layout.nodes.find(value => value.node.id === 'session:child')?.depth).toBe(3)
  })
})
