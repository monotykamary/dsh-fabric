import { describe, expect, it } from 'vitest'
import { AdvisoryEngine, renderAdvisoryHints, type AdvisoryEntry } from '../src/advisory.ts'

const catalog: AdvisoryEntry[] = [
  { name: 'web_search', description: 'Search the web for current information. Returns a summary and sources.', kind: 'tool' },
  { name: 'imagegen', description: 'Generate an image. Returns the generated PNG.', kind: 'tool' },
  { name: 'subagent', description: 'Delegate a self-contained task to a subagent. The subagent returns its result.', kind: 'tool' },
  { name: 'workflow', description: 'Run a workflow script that orchestrates subagents at scale.', kind: 'tool' },
  { name: 'bash', description: 'Execute a bash command and return its output.', kind: 'tool', disclosed: true },
]

describe('AdvisoryEngine', () => {
  it('fires instantly on a strong phrase (two words on one entry)', () => {
    const engine = new AdvisoryEngine()
    engine.setCatalog(catalog)
    const fires = engine.scorePrompt('search the web for current information about AI')
    expect(fires.map(fire => fire.name)).toContain('web_search')
    expect(engine.firesRemaining()).toBe(2)
  })

  it('uses the strong band for immediate fire and warms a shared two-term phrase for four turns', () => {
    const engine = new AdvisoryEngine()
    engine.setCatalog([
      { name: 'alpha', description: 'Durable task alpha.', kind: 'tool' },
      { name: 'beta', description: 'Durable task beta.', kind: 'tool' },
    ])

    expect(engine.scorePrompt('durable task')).toEqual([])
    expect(engine.scorePrompt('durable task')).toEqual([])
    expect(engine.scorePrompt('durable task')).toEqual([])
    expect(engine.scorePrompt('durable task').map(fire => fire.name).sort()).toEqual(['alpha', 'beta'])
  })

  it('decays warmth on unrelated turns instead of retaining stale heat', () => {
    const engine = new AdvisoryEngine({ maxFiresPerSession: 1 })
    engine.setCatalog([
      { name: 'alpha', description: 'Durable task alpha.', kind: 'tool' },
      { name: 'beta', description: 'Durable task beta.', kind: 'tool' },
    ])

    for (let turn = 0; turn < 3; turn += 1) expect(engine.scorePrompt('durable task')).toEqual([])
    expect(engine.scorePrompt('unrelated conversation')).toEqual([])
    expect(engine.scorePrompt('durable task')).toEqual([])
  })

  it('ranks inverse-frequency evidence before spending the fire budget', () => {
    const engine = new AdvisoryEngine({ maxFiresPerSession: 1 })
    engine.setCatalog([
      { name: 'early_a', description: 'Handle durable task records.', kind: 'tool' },
      { name: 'early_b', description: 'Handle durable task records.', kind: 'tool' },
      { name: 'late', description: 'Handle durable task with quantum lattice.', kind: 'tool' },
    ])

    expect(engine.scorePrompt('handle durable task quantum lattice').map(fire => fire.name)).toEqual(['late'])
  })

  it('accumulates weak scatter evidence across turns before firing', () => {
    const engine = new AdvisoryEngine()
    engine.setCatalog(catalog)
    // Two matched words, but scattered apart and over the scatter cap lane:
    // effective = min(raw, 1) = 1 feeds warmth with retention 0.5; the first
    // turn must NOT fire ("single-turn collisions cool before they get there").
    const prompt = 'delegate the outer work to an entirely different working group and afterwards maybe use a subagent'
    const first = engine.scorePrompt(prompt)
    expect(first).toEqual([])
    let fired = false
    for (let turn = 0; turn < 8 && !fired; turn += 1) {
      const fires = engine.scorePrompt(prompt)
      if (fires.some(fire => fire.name === 'subagent')) fired = true
    }
    expect(fired).toBe(true)
  })

  it('supplies zero heat for a single written word', () => {
    const engine = new AdvisoryEngine()
    engine.setCatalog(catalog)
    for (let turn = 0; turn < 6; turn += 1) expect(engine.scorePrompt('subagent')).toEqual([])
    expect(engine.firesRemaining()).toBe(3)
  })

  it('burns a fired namespace and never re-fires it', () => {
    const engine = new AdvisoryEngine()
    engine.setCatalog(catalog)
    expect(engine.scorePrompt('search the web now').map(fire => fire.name)).toContain('web_search')
    for (let turn = 0; turn < 4; turn += 1) {
      const fires = engine.scorePrompt('search the web again')
      expect(fires.map(fire => fire.name)).not.toContain('web_search')
    }
  })

  it('never suggests already-disclosed tools and respects the fire budget', () => {
    const engine = new AdvisoryEngine({ maxFiresPerSession: 2 })
    engine.setCatalog(catalog)
    const names = new Set<string>()
    for (const prompt of ['search the web now', 'delegate then subagent', 'orchestrate subagents at scale', 'generate an image file']) {
      for (const fire of engine.scorePrompt(prompt)) names.add(fire.name)
    }
    expect(names.has('bash')).toBe(false)
    expect(names.size).toBeLessThanOrEqual(2)
    expect(engine.firesRemaining()).toBe(0)
  })

  it('caps the rendered hint text at the configured budget', () => {
    const fires = [
      { name: 'web_search', kind: 'tool' as const, description: 'Search the web for current information.', score: 1, matchedTerms: ['web'] },
      { name: 'subagent', kind: 'tool' as const, description: 'Delegate a self-contained task to a subagent.', score: 0.9, matchedTerms: ['subagent'] },
      { name: 'workflow', kind: 'tool' as const, description: 'Run a workflow script that orchestrates subagents at scale.', score: 0.8, matchedTerms: ['workflow'] },
    ]
    // A budget below the header itself degrades to no injection.
    expect(renderAdvisoryHints(fires, 60)).toBe('')
    const generous = renderAdvisoryHints(fires, 10_000)
    expect(generous).toContain('web_search')
    expect(generous).toContain('tools.describe')
    expect(renderAdvisoryHints(fires, generous.length)).toBe(generous)
    expect(renderAdvisoryHints(fires, generous.length - 1).length).toBeLessThanOrEqual(generous.length - 1)
    expect(renderAdvisoryHints([], 1000)).toBe('')
    expect(new AdvisoryEngine({ budgetChars: 60 }).render(fires)).toBe('')
  })
})
