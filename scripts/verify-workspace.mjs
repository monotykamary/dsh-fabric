import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = JSON.parse(await readFile('package.json', 'utf8'))
const patch = await readFile('cordis.patch.yml', 'utf8')
const references = [...patch.matchAll(/^\s+name:\s+['"]([^'"]+)['"]\s*$/gm)].map(match => match[1])
const expectedReferences = [
  '@dsh-fabric/client-ui',
  '@dsh-fabric/code-runtime-quickjs',
  '@dsh-fabric/host',
  '@dsh-fabric/mesh/provider',
  '@dsh-fabric/mesh/tool',
]
if (references.toSorted().join('\n') !== expectedReferences.join('\n')) {
  throw new Error('cordis.patch.yml does not contain the exact Fabric composition rows')
}
for (const reference of references) {
  const packageName = packageNameFromSpecifier(reference)
  if (packageName !== root.name && root.dependencies?.[packageName] === undefined) {
    throw new Error(`cordis.patch.yml names ${reference}, but root dependencies omit ${packageName}`)
  }
}

const packageDirs = ['protocol', 'host', 'mesh', 'code-runtime-quickjs', 'client-ui']
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
}

const artifacts = [
  'packages/protocol/lib/index.js',
  'packages/host/lib/index.js',
  'packages/host/lib/invariant.js',
  'packages/mesh/lib/provider.js',
  'packages/mesh/lib/tool.js',
  'packages/mesh/lib/invariant.js',
  'packages/code-runtime-quickjs/lib/index.js',
  'packages/code-runtime-quickjs/lib/invariant.js',
  'packages/client-ui/lib/index.js',
  'packages/client-ui/lib/invariant.js',
  'packages/client-ui/lib/client.js',
]
for (const artifact of artifacts) await access(resolve(artifact))

await access(resolve('ADAPTATION_SWEEP.md'))

const clientBundle = await readFile('packages/client-ui/lib/client.js', 'utf8')
if (!clientBundle.startsWith('window.__ModuleLoader__.load(')) {
  throw new Error('client bundle is missing the DSH module-loader wrapper')
}
if (/require\(["']@dsh-fabric\//.test(clientBundle)) {
  throw new Error('client bundle contains an unresolved @dsh-fabric value import')
}
if (!/else\s+existing\.textContent\s*=\s*css/.test(clientBundle)) {
  throw new Error('client bundle does not hot-replace existing package CSS')
}

console.log(`verified ${references.length} composition rows, ${packageDirs.length} packages, and ${artifacts.length} artifacts`)

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}
