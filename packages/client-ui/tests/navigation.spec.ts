import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createFabricControls } from '../src/client/index.ts'

describe('Fabric client navigation', () => {
  it('refreshes projected child catalogs before choosing an authoritative route', async () => {
    const gate = Promise.withResolvers<void>()
    const child = 'child' as SessionId
    const root = 'root' as SessionId
    let address: { parentSessionId: SessionId; childSessionId: SessionId; mode: 'continuable' } | undefined
    const open = vi.fn()
    const openSubagent = vi.fn()
    const refreshSubagents = vi.fn(async () => {
      await gate.promise
      address = { parentSessionId: root, childSessionId: child, mode: 'continuable' }
    })
    const sessions = {
      subagentAddress: (id: SessionId) => id === child ? address : undefined,
      refreshSubagents,
      open,
      openSubagent,
      list: { getSnapshot: () => ({ ids: [root] }) },
    } as unknown as ClientContext['sessions']
    const controls = createFabricControls(sessions)

    const preload = controls.refreshCatalogs([root])
    const opening = controls.openNode(child)
    gate.resolve()
    await Promise.all([preload, opening])

    expect(openSubagent).toHaveBeenCalledWith(address)
    expect(open).not.toHaveBeenCalled()
    await expect(controls.openNode('unknown')).resolves.toBeUndefined()
    expect(open).not.toHaveBeenCalled()
    await controls.openNode(root)
    expect(open).toHaveBeenCalledWith(root)
  })
})
