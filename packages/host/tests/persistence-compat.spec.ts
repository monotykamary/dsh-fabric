import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/**
 * This is a compatibility sentinel, not desired behavior. Fabric activity must remain a
 * required event because dropping it would silently erase the durable projection. Remove
 * this test only when DSH exposes an external-event registration seam (or natively knows
 * fabric/activity) and an actual persistence round-trip replaces it.
 */
describe('DSH external session-event compatibility', () => {
  it('pins the rc.6 persistence blocker for required fabric/activity events', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has('fabric/activity')).toBe(false)
  })
})
