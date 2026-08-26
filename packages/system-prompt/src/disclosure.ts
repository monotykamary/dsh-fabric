/**
 * Progressive disclosure for DSH's generated `tools:sdk` prompt section.
 *
 * The full SDK block (intro + "The available tools:" + the generated
 * TypeScript type block) is the single largest system-prompt cost in Code
 * Mode. This module keeps the always-on block to the core tool set and lets
 * the remaining tools stay registered but out of the prompt: they remain
 * callable through the binding map and discoverable through
 * `tools.describe()` / the capability advisory (see `advisory.ts`), the same
 * split pi-fabric uses between ambient guidance and on-demand references.
 *
 * The splice operates on the RENDERED section text, never on DSH internals:
 * DSH's renderer output is deterministic and entry-terminated, and the
 * resulting block is validated to re-parse as TypeScript in tests. The
 * guest-side type checker is built from the binding map, not from this text,
 * so narrowing the prompt never narrows what a program may call.
 * @module dsh-fabric-system-prompt/src/disclosure
 */

/** Tools whose full argument/output contracts stay in the always-on SDK block. */
export const DISCLOSURE_CORE_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'read',
  'grep',
  'glob',
  'edit',
  'write',
  'ask_user_question',
  'job_list',
  'job_output',
  'job_kill',
  'exit_plan_mode',
])

/**
 * Everything else (subagent, workflow, ralph, fabric_mesh, web_search,
 * imagegen, skill, fovea_*, …) is progressively disclosed: omitted from the
 * block, still registered, discoverable via `tools.describe()` and the
 * capability advisory.
 */

/** Marker that opens the generated tool-catalog block inside the SDK section. */
export const SDK_CATALOG_MARKER = 'The available tools:'

/** One top-level catalog entry: `  <name>: {` at two-space indent (quoted or bare). */
const ENTRY_START = /^  ([A-Za-z_$][A-Za-z0-9_$]*|"[^"]*"): \{$/

/** The renderer's one-line JSDoc that precedes an entry — removed with it. */
const ENTRY_DOC = /^  \/\*\* .*\*\/$/

/**
 * One-line inline entries the renderer emits for trivial types
 * (`  fabric_mesh: JsonValue;`, `  job_list: Record<string, JsonValue>;`):
 * the same two-space-indent name slot, but no object body to terminate.
 */
const ENTRY_INLINE = /^  ([A-Za-z_$][A-Za-z0-9_$]*|"[^"]*"): (?!\{).*;$/

/**
 * A generated entry terminates at the first two-space-indent line that closes
 * the entry's own object: `  };` for outputs or `  } & Record<string, JsonValue>;`
 * for args. Nested closes sit at four-space indent or deeper, and union
 * continuations (`  } | {`, `  })[];`) never match either exact form.
 */
const ENTRY_TERMINATOR = /^  \};$|^  \} & Record<string, JsonValue>;$/

/** Strip the quoting off a matched entry name (bare identifiers need none). */
function entryName(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  return raw
}

/** Enumerate the catalog entry names present in a rendered SDK block. */
export function sdkBlockEntryNames(block: string): string[] {
  return block.split('\n').flatMap(line => {
    const braced = ENTRY_START.exec(line)
    const name = braced?.[1] ?? ENTRY_INLINE.exec(line)?.[1]
    return name === undefined ? [] : [entryName(name)]
  })
}

/**
 * Remove one or more catalog entries from a rendered SDK block by name.
 * Entries are located by their two-space-indent start line and removed
 * through their own two-space-indent terminator line (inclusive). Entries
 * whose names are not present are ignored.
 * @param block - the generated TypeScript block (between the code fences).
 * @param remove - entry names to splice out.
 * @returns the block with the named entries removed.
 */
export function spliceSdkBlock(block: string, remove: ReadonlySet<string>): string {
  if (remove.size === 0) return block
  const lines = block.split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const braced = ENTRY_START.exec(line)
    const name = braced?.[1] ?? ENTRY_INLINE.exec(line)?.[1]
    if (name !== undefined && remove.has(entryName(name))) {
      // Drop the renderer's one-line JSDoc that precedes this entry, so no
      // orphaned comment survives a removed tool.
      if (out.length > 0 && ENTRY_DOC.test(out[out.length - 1] ?? '')) out.pop()
      if (braced !== null) {
        index += 1
        while (index < lines.length && !ENTRY_TERMINATOR.test(lines[index] ?? '')) index += 1
        if (index < lines.length) index += 1 // consume the terminator line
      } else {
        index += 1 // the inline entry IS its own line
      }
      continue
    }
    out.push(line)
    index += 1
  }
  return out.join('\n')
}

/**
 * Apply disclosure to a rendered `tools:sdk` section: keep the intro and the
 * code fences byte-identical and splice the catalog block down to `keep`.
 * Sections without the catalog marker (or with no removable entries) pass
 * through untouched.
 * @param text - the section text as assembled (intro + fenced TS block).
 * @param keep - the entry names that remain in the block.
 * @returns the disclosed section text.
 */
export function discloseSdkSection(text: string, keep: ReadonlySet<string>): string {
  const marker = text.indexOf(SDK_CATALOG_MARKER)
  if (marker < 0) return text
  const fenceOpen = text.indexOf('```', marker)
  const blockStart = text.indexOf('\n', fenceOpen + 3)
  const fenceClose = text.indexOf('```', blockStart + 1)
  if (fenceOpen < 0 || blockStart < 0 || fenceClose < 0) return text
  const block = text.slice(blockStart + 1, fenceClose)
  const remove = new Set(sdkBlockEntryNames(block).filter(name => !keep.has(name)))
  if (remove.size === 0) return text
  return text.slice(0, blockStart + 1) + spliceSdkBlock(block, remove) + text.slice(fenceClose)
}

/** One disclosed tool entry: the canonical schema surface DSH projects. */
export interface DisclosureEntry {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown> | undefined
}
