import { describe, expect, it } from 'vitest'
import { delegationGuidance, resolveWorkerRoute, routeForTier } from '../src/policy.ts'

const config = {
  aliases: {
    cheap: ['cursor/composer-2.5-fast', 'openrouter/backup'],
    strong: 'cursor/grok-4.6-fast',
  },
  cheapModel: 'cheap',
  defaultModel: 'deepseek/deepseek-chat',
  strongModel: 'strong',
  autoPolicy: 'prefer' as const,
}

describe('delegation routing policy', () => {
  it('resolves exact selectors and shared model aliases', () => {
    expect(resolveWorkerRoute('anthropic/claude-sonnet-4', {})).toEqual({
      provider: 'anthropic', model: 'claude-sonnet-4',
    })
    expect(resolveWorkerRoute('CHEAP', config.aliases)).toEqual({
      provider: 'cursor', model: 'composer-2.5-fast',
    })
  })

  it('maps every worker tier independently', () => {
    expect(routeForTier('cheap', config)).toEqual({ provider: 'cursor', model: 'composer-2.5-fast' })
    expect(routeForTier('default', config)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(routeForTier('strong', config)).toEqual({ provider: 'cursor', model: 'grok-4.6-fast' })
  })

  it('fails loudly for selectors that cannot identify a provider and model', () => {
    expect(() => resolveWorkerRoute('missing-alias', config.aliases)).toThrow('must be provider/model')
    expect(() => resolveWorkerRoute('/missing-provider', config.aliases)).toThrow(/did not resolve/)
  })

  it('keeps trivial work on Main and requires verification after delegation', () => {
    const guidance = delegationGuidance(config)
    expect(guidance).toContain('Do not delegate trivial or tightly coupled work')
    expect(guidance).toContain('routingVerified')
    expect(guidance).toContain('verify material claims')
  })
})
