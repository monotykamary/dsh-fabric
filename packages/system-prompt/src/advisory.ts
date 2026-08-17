/**
 * Capability advisory with combustion dynamics — the pi-fabric hint engine,
 * ported to DSH. (See pi-fabric's docs/capability-combustion.md for the math
 * this v1 subset follows.)
 *
 * The advisor scores the current user prompt against the tool and skill
 * catalog (name + first sentence of description) and, when the evidence is
 * strong enough, fires short hint lines naming the matched capabilities. A
 * fired namespace BURNS for the rest of the session branch: the advisory is a
 * finite battery (default three fires), so false fires cost later turns.
 *
 * v1 subset (documented divergences from pi):
 *  - scores the current user messages only, not the assembled prompt;
 *  - no habituation episode damping and no script-boundary exception;
 *  - no smoke feedback (tool-use observation) — the threshold is static;
 *  - path/URL terms earn half a quantum, matching pi's path discount.
 *
 * State is per-agent, held by the plugin in a Map keyed by agent id.
 * @module @dsh-fabric/system-prompt/src/advisory
 */

/** One capability the advisor may hint at. */
export interface AdvisoryEntry {
  readonly name: string
  readonly description: string
  readonly kind: 'tool' | 'skill'
  /** Names the advisor must never re-suggest (burned or always-disclosed). */
  readonly disclosed?: boolean
}

/** One fired hint, carried in the injected message source for replay. */
export interface AdvisoryFire {
  readonly name: string
  readonly kind: 'tool' | 'skill'
  readonly description: string
  readonly score: number
  readonly matchedTerms: readonly string[]
}

export interface AdvisoryConfig {
  /** Raw-score ignition point (pi default). */
  threshold?: number
  /** Total fires per session branch before the battery is empty (pi default 3). */
  maxFiresPerSession?: number
  /** Approximate char ceiling for one rendered hint message (≈512 tokens at chars/4). */
  budgetChars?: number
  /** Patience/memory scale τ: warmth retention and the phrase window (pi default 2). */
  tau?: number
}

type ResolvedConfig = Required<AdvisoryConfig>

/** One written prompt word at its position, with its effective weight. */
interface ScoredWord {
  readonly word: string
  readonly position: number
  readonly weight: number
}

const DEFAULTS: ResolvedConfig = {
  threshold: 0.9,
  maxFiresPerSession: 3,
  budgetChars: 2048,
  tau: 2,
}

/** Score quantum: the weight of a source-unique term (df = 1 → 1/df = 1). */
const SCORE_QUANTUM = 1
/** Path/URL/filename terms earn half a quantum (pi's path discount). */
const PATH_DISCOUNT = SCORE_QUANTUM / 2

/** A word that names a file/URL artifact rather than capability intent. */
const PATH_TERM = /(?:\.[A-Za-z0-9]+$)|(?:^\/)|(?:\/)/

/**
 * English stopwords plus prose fillers common in tool descriptions — ported
 * 1:1 from pi-fabric's CAPABILITY_STOPWORDS, the same list that keeps
 * function words from dominating fingerprints and prompt matching.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'or', 'as',
  'by', 'at', 'from', 'into', 'one', 'this', 'that', 'it', 'its', 'their',
  'your', 'you', 'we', 'i', 'me', 'my', 'mine', 'us', 'is', 'are', 'be', 'been', 'current', 'existing',
  'please', 'thanks',
  'what', 'how', 'who', 'whom', 'whose', 'why', 'where', 'which',
  'new', 'use', 'used', 'using', 'via', 'per', 'each', 'all', 'any', 'can',
  'will', 'also', 'not', 'no', 'if', 'when', 'then', 'else', 'than', 'so',
  'such', 'over', 'under', 'out', 'up', 'down', 'off', 'through', 'during',
  'about', 'between', 'same', 'many', 'much', 'more', 'most', 'other',
  'some', 'only',
])

/**
 * Latin-alphanumeric tokenization with CamelCase atomization and the
 * stopword filter — pi's tokenizeCapabilityText, ported.
 */
function tokenize(text: string): string[] {
  const matches = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .match(/[a-z][a-z0-9]{1,}/g)
  if (matches === null) return []
  return matches.filter(token => !STOPWORDS.has(token))
}

/** The first sentence of a description — the identity sentence pi indexes. */
function firstSentence(description: string): string {
  const end = description.search(/(?<=[a-z0-9)])[.!?]\s/)
  return end < 0 ? description : description.slice(0, end)
}

/** Build the per-entry term sets and the document frequency per term. */
function buildIndex(entries: readonly AdvisoryEntry[]): {
  terms: Map<string, Set<string>>
  df: Map<string, number>
} {
  const terms = new Map<string, Set<string>>()
  const df = new Map<string, number>()
  for (const entry of entries) {
    const set = new Set([...tokenize(entry.name), ...tokenize(firstSentence(entry.description))])
    terms.set(entry.name, set)
    for (const term of set) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return { terms, df }
}

/**
 * Score one prompt against the catalog with pi's combustion dynamics.
 * Mutates per-branch state (warmth, ash, fires).
 */
export class AdvisoryEngine {
  private readonly config: ResolvedConfig
  private readonly state: {
    warmth: Map<string, number>
    ash: Set<string>
    fires: number
  } = { warmth: new Map(), ash: new Set(), fires: 0 }

  private entries: readonly AdvisoryEntry[] = []
  private index: { terms: Map<string, Set<string>>; df: Map<string, number> } = { terms: new Map(), df: new Map() }

  constructor(config: AdvisoryConfig = {}) {
    this.config = { ...DEFAULTS, ...config }
  }

  /** Replace the catalog (tools + skills) and rebuild the index. */
  setCatalog(entries: readonly AdvisoryEntry[]): void {
    this.entries = entries
    this.index = buildIndex(entries)
  }

  /** Names burned or always-disclosed — never hinted again. */
  exhausted(): ReadonlySet<string> {
    const set = new Set(this.state.ash)
    for (const entry of this.entries) if (entry.disclosed === true) set.add(entry.name)
    return set
  }

  firesRemaining(): number {
    return Math.max(0, this.config.maxFiresPerSession - this.state.fires)
  }

  /**
   * Score one user prompt and fire any hints it justifies. Strong evidence
   * (a phrase on one entry clearing the threshold) ignites instantly; weak
   * evidence accumulates in an EWMA with retention 1 − 1/τ and fires only
   * when that warmth breaches the ignition point.
   * @param prompt - the concatenated user-message text of the current turn.
   * @returns the fires this call produced, in descending score order.
   */
  scorePrompt(prompt: string): AdvisoryFire[] {
    const words = this.scoredWords(prompt)
    if (words.length === 0 || this.firesRemaining() === 0) return []

    const { terms, df } = this.index
    const eligible = this.entries.filter(entry => !this.state.ash.has(entry.name) && entry.disclosed !== true)
    const fires: AdvisoryFire[] = []

    for (const entry of eligible) {
      const set = terms.get(entry.name) ?? new Set<string>()
      let raw = 0
      let matched = 0
      for (const word of words) {
        if (!set.has(word.word)) continue
        raw += word.weight * (df.get(word.word) ?? 1)
        matched += 1
      }
      // pi's two-word gate: one written word supplies zero heat.
      if (matched < 2) continue
      const phrased = this.phrasedEvidence(words, set)
      const effective = phrased ? raw : Math.min(raw, SCORE_QUANTUM)
      const warm = (this.state.warmth.get(entry.name) ?? 0) * (1 - 1 / this.config.tau) + effective * (1 / this.config.tau)

      // Strong band (phrased evidence over the threshold) ignites instantly;
      // weak/scatter evidence only fires once its warmth survives τ turns.
      if ((phrased && effective >= this.config.threshold) || warm >= this.config.threshold) {
        this.state.ash.add(entry.name)
        this.state.fires += 1
        this.state.warmth.delete(entry.name)
        fires.push({
          name: entry.name,
          kind: entry.kind,
          description: firstSentence(entry.description),
          score: Math.max(effective, warm),
          matchedTerms: [...set].filter(term => words.some(word => word.word === term)),
        })
      } else {
        this.state.warmth.set(entry.name, warm)
      }
      if (this.firesRemaining() === 0) break
    }

    return fires.sort((a, b) => b.score - a.score)
  }

  /** The prompt's unique written words with positions and discounted weights. */
  private scoredWords(prompt: string): ScoredWord[] {
    const seen = new Set<string>()
    const out: ScoredWord[] = []
    let position = 0
    for (const raw of prompt.split(/[^A-Za-z0-9_./-]+/)) {
      if (raw.length === 0) continue
      const discounted = PATH_TERM.test(raw) ? PATH_DISCOUNT : SCORE_QUANTUM
      for (const reading of tokenize(raw)) {
        if (seen.has(reading)) continue
        seen.add(reading)
        out.push({ word: reading, position, weight: discounted })
        position += 1
      }
    }
    return out
  }

  /**
   * Phrased evidence: two matched written words within 2τ survivors of each
   * other that both sit on THIS entry (pi's MRF sequential-dependence
   * clause). Anything else is scatter and feeds the capped lane.
   */
  private phrasedEvidence(words: readonly ScoredWord[], set: ReadonlySet<string>): boolean {
    const hits = words.filter(word => set.has(word.word))
    if (hits.length < 2) return false
    for (let index = 1; index < hits.length; index += 1) {
      const position = hits[index]?.position ?? Number.MAX_SAFE_INTEGER
      const previous = hits[index - 1]?.position ?? Number.MAX_SAFE_INTEGER
      if (position - previous <= 2 * this.config.tau) return true
    }
    return false
  }
}

/**
 * Render one bounded hint message. The budget bounds the WHOLE message
 * (header included); hints that no longer fit are dropped, so a tiny budget
 * degrades to no injection rather than an oversized one.
 */
export function renderAdvisoryHints(fires: readonly AdvisoryFire[], budgetChars: number): string {
  const header = [
    '<system-reminder>',
    'Capabilities matched for this task. These are hints, not contracts: before using one, call',
    "\`tools.describe('<name>')\` inside run_code for its exact arguments, or the \`skill\` tool for a skill.",
    '',
  ].join('\n')
  let used = header.length
  const lines: string[] = []
  for (const fire of fires) {
    const line = `- ${fire.name} (${fire.kind}) — ${fire.description}`
    if (used + line.length > budgetChars) break
    lines.push(line)
    used += line.length
  }
  if (lines.length === 0) return ''
  return [header, lines.join('\n'), '</system-reminder>'].join('\n')
}
