import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const nl = '\n'

const root = JSON.parse(await readFile('package.json', 'utf8'))
if (root.scripts?.['install:local'] !== 'node scripts/install-local.mjs') {
  throw new Error('package.json does not expose the local installer')
}
if (root.scripts?.['uninstall:local'] !== 'node scripts/install-local.mjs --uninstall') {
  throw new Error('package.json does not expose the local uninstaller')
}
await access(resolve('scripts/install-local.mjs'))

const patch = await readFile('cordis.patch.yml', 'utf8')
const references = [...patch.matchAll(/^\s+name:\s+['"]([^'"]+)['"]\s*$/gm)].map(match => match[1])
const expectedReferences = [
  'dsh-fabric-client-ui',
  'dsh-fabric-code-runtime-quickjs',
  'dsh-fabric-compaction',
  'dsh-fabric-compaction/presets',
  'dsh-fabric-host',
  'dsh-fabric-mesh/provider',
  '@monotykamary/dsh-agent-presets',
]
if (references.toSorted().join('\n') !== expectedReferences.toSorted().join('\n')) {
  throw new Error('cordis.patch.yml does not contain the exact Fabric composition rows')
}
if (!/^- id: code-runtime\r?\n  disabled: true$/m.test(patch)) {
  throw new Error('cordis.patch.yml must disable the inherited code-runtime row')
}
if (!/^- id: tools\r?\n  config:\r?\n    maxParallelSubCalls: !!js Number\.MAX_SAFE_INTEGER$/m.test(patch)) {
  throw new Error('cordis.patch.yml must remove the default Code Mode parallel sub-call throttle')
}
for (const id of ['compaction-basic', 'tool-result-pruner', 'agent-presets']) {
  if (!new RegExp(`^- id: ${id}\\r?\\n  disabled: true$`, 'm').test(patch)) {
    throw new Error(`cordis.patch.yml must disable the inherited ${id} row`)
  }
}
for (const id of ['command-goal', 'goal-round-driver', 'ui-goal']) {
  if (!patch.includes('- id: ' + id + nl + '  disabled: true')) {
    throw new Error('cordis.patch.yml must disable the inherited ' + id + ' row')
  }
}
if (!/^- id: session-query-sqlite\r?\n  config:\r?\n    path: !!js dshHomePath\('session-query'\)\r?\n    openAt: first-search$/m.test(patch)) {
  throw new Error('cordis.patch.yml must enable full-text session search with a durable index for Fabric memory/recall')
}
const fabricPreset = await readFile('packages/compaction/presets/fabric/agent.cordis.yml', 'utf8')
if (!fabricPreset.includes('- id: dsh-fabric-mesh-tool' + nl + "  name: 'dsh-fabric-mesh/tool'")) {
  throw new Error('fabric preset must mount the Fabric mesh Consumer')
}
if (!fabricPreset.includes('- id: dsh-fabric-system-prompt' + nl + "  name: 'dsh-fabric-system-prompt'")) {
  throw new Error('fabric preset must mount the Fabric system-prompt overlay')
}
if (!fabricPreset.includes('- id: tool-session-query' + nl + "  name: '@monotykamary/dsh-tool-session-query'")) {
  throw new Error('fabric preset must mount the DSH session-query toolset for Fabric memory/recall')
}
if (!/^    - id: dsh-fabric-compaction\r?\n      name: ['"]dsh-fabric-compaction['"]$/m.test(patch)) {
  throw new Error('cordis.patch.yml must insert the Fabric compaction engine')
}
if (!/^    - id: dsh-fabric-preset-root\r?\n      name: ['"]dsh-fabric-compaction\/presets['"]$/m.test(patch)) {
  throw new Error('cordis.patch.yml must insert the Fabric preset-root provider')
}
if (!/^    - id: dsh-fabric-agent-presets\r?\n      name: ['"]@monotykamary\/dsh-agent-presets['"]$/m.test(patch)
  || !/^          - path: !!js ctx\.fabricPresetRoot\r?\n            trust: system$/m.test(patch)) {
  throw new Error('cordis.patch.yml must insert the host-native Fabric preset roster with a system-trusted package root')
}
if (!/^    - id: dsh-fabric-code-runtime\r?\n      name: ['"]dsh-fabric-code-runtime-quickjs['"]$/m.test(patch)) {
  throw new Error('cordis.patch.yml must insert QuickJS under its distinct Fabric loader id')
}
for (const reference of references) {
  const packageName = packageNameFromSpecifier(reference)
  if (packageName !== root.name && root.dependencies?.[packageName] === undefined) {
    throw new Error(`cordis.patch.yml names ${reference}, but root dependencies omit ${packageName}`)
  }
}

const packageDirs = ['protocol', 'compaction', 'host', 'mesh', 'system-prompt', 'code-runtime-quickjs', 'client-ui']
for (const directory of packageDirs) {
  const manifestPath = `packages/${directory}/package.json`
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.private === true) throw new Error(`${manifest.name} is still private`)
  if (manifest.name.startsWith('@') && manifest.publishConfig?.access !== 'public') {
    throw new Error(`${manifest.name} must publish with public access`)
  }
  await access(resolve(`packages/${directory}/LICENSE`))
  if (directory !== 'protocol' && manifest.exports?.['./invariant'] === undefined) {
    throw new Error(`${manifest.name} omits its invariant companion export`)
  }
  const hasClientExport = manifest.exports?.['./client'] !== undefined
  const hasClientDeclaration = manifest.dsh?.client !== undefined
  if (hasClientExport !== hasClientDeclaration) {
    throw new Error(`${manifest.name} must declare both exports["./client"] and dsh.client, or neither`)
  }
  if (directory === 'client-ui' && !manifest.dsh.client.inject.includes('@monotykamary/dsh-client-locale')) {
    throw new Error(`${manifest.name} must inject the DSH client locale service`)
  }
  if ((directory === 'host' || directory === 'client-ui') && !manifest.files.includes('THIRD_PARTY_NOTICES.md')) {
    throw new Error(`${manifest.name} must publish its DeepSeek third-party notice`)
  }
}

const artifacts = [
  'packages/protocol/lib/index.js',
  'packages/compaction/lib/index.js',
  'packages/compaction/lib/compiler.js',
  'packages/compaction/lib/presets.js',
  'packages/compaction/lib/invariant.js',
  'packages/host/lib/index.js',
  'packages/host/lib/invariant.js',
  'packages/mesh/lib/provider.js',
  'packages/mesh/lib/tool.js',
  'packages/mesh/lib/invariant.js',
  'packages/system-prompt/lib/index.js',
  'packages/system-prompt/lib/invariant.js',
  'packages/code-runtime-quickjs/lib/index.js',
  'packages/code-runtime-quickjs/lib/invariant.js',
  'packages/client-ui/lib/index.js',
  'packages/client-ui/lib/invariant.js',
  'packages/client-ui/lib/client.js',
]
for (const artifact of artifacts) await access(resolve(artifact))

for (const artifact of [
  'packages/code-runtime-quickjs/lib/index.js',
  'packages/compaction/lib/index.js',
  'packages/compaction/lib/presets.js',
  'packages/host/lib/index.js',
  'packages/mesh/lib/provider.js',
  'packages/mesh/lib/tool.js',
  'packages/system-prompt/lib/index.js',
  'packages/client-ui/lib/index.js',
]) {
  const module = await import(pathToFileURL(resolve(artifact)).href)
  const plugin = module.default ?? module
  if (typeof plugin !== 'function' && (typeof plugin !== 'object' || plugin === null || typeof plugin.apply !== 'function')) {
    throw new Error(`${artifact} does not expose a loader-valid Cordis plugin`)
  }
}

for (const preset of ['standard', 'code', 'fabric', 'cordis', 'minimal']) {
  const composition = await readFile(`packages/compaction/presets/${preset}/agent.cordis.yml`, 'utf8')
  if ((composition.match(/name: ['"]dsh-fabric-compaction['"]/g) ?? []).length !== 1
    || !composition.includes('@monotykamary/dsh-command-compact')
    || composition.includes('@monotykamary/dsh-compaction-basic')
    || composition.includes('@monotykamary/dsh-compaction-tool-result-pruner')
    || /name: ['"]dsh-fabric-compaction['"][\s\S]{0,120}auto:\s*false/.test(composition)) {
    throw new Error(`Fabric preset ${preset} does not exclusively compose Fabric compaction`)
  }
}

for (const preset of ['standard', 'code', 'fabric', 'cordis', 'minimal']) {
  const composition = await readFile('packages/compaction/presets/' + preset + '/agent.cordis.yml', 'utf8')
  const todoMasked = composition.includes('- id: tool-todo' + nl + "  name: '@monotykamary/dsh-tool-todo'" + nl + '  disabled: true')
  const goalMasked = composition.includes('- id: tool-goal' + nl + "  name: '@monotykamary/dsh-tool-goal'" + nl + '  disabled: true')
  if (composition.includes('@monotykamary/dsh-tool-todo') && !todoMasked) {
    throw new Error('Fabric preset ' + preset + ' composes the DSH todo tool without masking it')
  }
  if (composition.includes('@monotykamary/dsh-tool-goal') && !goalMasked) {
    throw new Error('Fabric preset ' + preset + ' composes the DSH goal tool without masking it')
  }
}
for (const asset of [
  'packages/host/THIRD_PARTY_NOTICES.md',
  'packages/client-ui/THIRD_PARTY_NOTICES.md',
  'packages/compaction/presets/cordis/skills/cordis-plugin-development/SKILL.md',
  'packages/compaction/presets/cordis/skills/editing-cordis-compositions/SKILL.md',
]) await access(resolve(asset))

await access(resolve('ADAPTATION_SWEEP.md'))

const clientBundle = await readFile('packages/client-ui/lib/client.js', 'utf8')
if (!clientBundle.startsWith('window.__ModuleLoader__.load(')) {
  throw new Error('client bundle is missing the DSH module-loader wrapper')
}
if (/require\(["']dsh-fabric-/.test(clientBundle)) {
  throw new Error('client bundle contains an unresolved dsh-fabric value import')
}
if (!clientBundle.includes('Fabric overview') || !clientBundle.includes('view.summary')) {
  throw new Error('client bundle is missing the informative English Fabric overview dictionary')
}
if (!clientBundle.includes('data-conversation-composer-overlay')
  || !clientBundle.includes('--dsh-composer-height')
  || !clientBundle.includes('--dsh-fabric-bottom-clearance')) {
  throw new Error('client bundle is missing the bounded, pane-blended host composer-overlay contract')
}
if (!clientBundle.includes('--dsw-font-xs-13')) {
  throw new Error('client bundle is missing normalized compact host typography for Fabric surfaces')
}
if (!clientBundle.includes('conversation session did not expose its shared Chat store')
  || !clientBundle.includes('actions.setView("chat")')) {
  throw new Error('client bundle is missing same-session navigation back to the host Chat view')
}
if (!/else\s+existing\.textContent\s*=\s*css/.test(clientBundle)) {
  throw new Error('client bundle does not hot-replace existing package CSS')
}

console.log(`verified ${references.length} composition rows, ${packageDirs.length} packages, and ${artifacts.length} artifacts`)

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}
