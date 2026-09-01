import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  discloseSdkSection,
  DISCLOSURE_CORE_TOOLS,
  renderSdkRoster,
  SDK_CATALOG_MARKER,
  SDK_ROSTER_MARKER,
  sdkBlockEntryNames,
  spliceSdkBlock,
} from '../src/disclosure.ts'

// The real rendered tools:sdk section captured from a live DSH session.
const section = readFileSync(fileURLToPath(new URL('./fixtures/tools-sdk-section.txt', import.meta.url)), 'utf8')

const fencedBlock = (text: string): string => {
  const open = text.indexOf('```')
  const start = text.indexOf('\n', open)
  const close = text.indexOf('```', start)
  return text.slice(start + 1, close)
}

const parses = (text: string): boolean => {
  const result = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  })
  return (result.diagnostics?.length ?? 0) === 0
}

describe('discloseSdkSection', () => {
  const originalNames = sdkBlockEntryNames(fencedBlock(section))

  it('covers the real block (the fixture must still be representative)', () => {
    expect(originalNames).toContain('bash')
    expect(originalNames).toContain('subagent')
    expect(originalNames).toContain('fabric_mesh')
    expect(section).toContain('provider?: string;')
    expect(section).toContain('describe(name: string')
    expect(originalNames.length).toBeGreaterThan(20)
  })

  it('keeps only core schemas and appends every removed name in deterministic order', () => {
    const disclosed = discloseSdkSection(section, DISCLOSURE_CORE_TOOLS)
    const intro = section.slice(0, section.indexOf(SDK_CATALOG_MARKER))
    expect(disclosed.startsWith(intro)).toBe(true)
    expect((disclosed.match(/```/g) ?? []).length).toBe(2)
    expect(disclosed).toContain(SDK_CATALOG_MARKER)
    expect(disclosed).toContain(SDK_ROSTER_MARKER)
    expect(disclosed).toContain('interface ToolDescriptor {\n  name: string;\n  description: string;\n  parameters: JsonValue;\n}')

    const names = sdkBlockEntryNames(fencedBlock(disclosed))
    const removed = originalNames.filter(name => !DISCLOSURE_CORE_TOOLS.has(name)).sort()
    const rosterLine = disclosed.slice(disclosed.indexOf(SDK_ROSTER_MARKER)).split('\n')[1]
    expect(JSON.parse(rosterLine ?? 'null')).toEqual(removed)
    expect(names.length).toBeLessThan(originalNames.length)
    for (const name of names) expect(DISCLOSURE_CORE_TOOLS.has(name)).toBe(true)
    for (const name of originalNames) {
      if (DISCLOSURE_CORE_TOOLS.has(name)) expect(names).toContain(name)
      else expect(names).not.toContain(name)
    }
  })

  it('removes optional schemas while retaining their bare names and discovery instructions', () => {
    const disclosed = discloseSdkSection(section, DISCLOSURE_CORE_TOOLS)
    const names = sdkBlockEntryNames(fencedBlock(disclosed))
    for (const removed of ['subagent', 'subagent_fork', 'workflow', 'ralph', 'fabric_mesh', 'web_search', 'imagegen', 'skill', 'read_image', 'fovea_focus', 'fovea_sketch', 'send_message', 'list_agents', 'interrupt_agent']) {
      expect(names).not.toContain(removed)
      expect(disclosed).toContain(`"${removed}"`)
    }
    expect(disclosed).toContain("await tools.describe('<name>')")
    expect(disclosed).toContain('await tools.call({ name, args })')
  })

  it('produces a block that still parses as TypeScript', () => {
    const disclosed = discloseSdkSection(section, DISCLOSURE_CORE_TOOLS)
    expect(parses(fencedBlock(disclosed))).toBe(true)
  })

  it('is idempotent and passes already-disclosed sections through', () => {
    const disclosed = discloseSdkSection(section, DISCLOSURE_CORE_TOOLS)
    expect(discloseSdkSection(disclosed, DISCLOSURE_CORE_TOOLS)).toBe(disclosed)
    expect(discloseSdkSection('sdk body without a catalog', DISCLOSURE_CORE_TOOLS)).toBe('sdk body without a catalog')
  })

  it('splices single entries on demand', () => {
    const block = fencedBlock(section)
    const spliced = spliceSdkBlock(block, new Set(['subagent']))
    expect(sdkBlockEntryNames(spliced)).not.toContain('subagent')
    expect(sdkBlockEntryNames(spliced)).toContain('workflow')
    expect(parses(spliced)).toBe(true)
    expect(spliceSdkBlock(block, new Set())).toBe(block)
  })

  it('renders unique names as compact JSON so hostile punctuation cannot inject prose', () => {
    const roster = renderSdkRoster(['zeta', 'alpha', 'alpha', 'line\\nbreak'])
    const encoded = roster.split('\n')[1]
    expect(JSON.parse(encoded ?? 'null')).toEqual(['alpha', 'line\\nbreak', 'zeta'])
    expect(roster.split('\n')).toHaveLength(3)
  })
})
