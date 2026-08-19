#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_PACKAGE = '@monotykamary/dsh@0.1.0-rc.7'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_STATE_FILE = '.dsh-fabric-local-install.json'
const LINK_PATHS = [
  '.',
  'packages/protocol',
  'packages/compaction',
  'packages/host',
  'packages/mesh',
  'packages/system-prompt',
  'packages/code-runtime-quickjs',
  'packages/client-ui',
]
// Host-plane rows only: the mesh Consumer (dsh-fabric-mesh/tool) and the
// system-prompt overlay (dsh-fabric-system-prompt) mount inside the `fabric`
// preset composition, so they are verified against that file instead.
const EXPECTED_ROWS = [
  'dsh-fabric-code-runtime-quickjs',
  'dsh-fabric-compaction',
  'dsh-fabric-compaction/presets',
  'dsh-fabric-host',
  'dsh-fabric-mesh/provider',
  'dsh-fabric-client-ui',
]
const REQUIRED_ARTIFACTS = [
  'packages/protocol/lib/index.js',
  'packages/compaction/lib/index.js',
  'packages/compaction/lib/compiler.js',
  'packages/compaction/lib/presets.js',
  'packages/host/lib/index.js',
  'packages/mesh/lib/provider.js',
  'packages/mesh/lib/tool.js',
  'packages/system-prompt/lib/index.js',
  'packages/code-runtime-quickjs/lib/index.js',
  'packages/client-ui/lib/client.js',
]

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const packages = await localPackages()
  if (options.uninstall) {
    await uninstall(options.profile, packages)
    return
  }

  if (options.skipBuild) {
    await verifyArtifacts()
  } else {
    await runPnpm(['install', '--frozen-lockfile'])
    await runPnpm(['run', 'build'])
  }

  await captureInstallState(options.profile, packages)
  await runPnpm([
    'dlx', DSH_PACKAGE,
    'plugin', '--profile', options.profile,
    'add', ...packages.map(entry => entry.link),
  ])

  const config = await dumpConfig(options.profile)
  verifyInstalled(config, options.profile)

  console.log(`Installed dsh-fabric into profile ${JSON.stringify(options.profile)}.`)
  console.log(`Validated all ${EXPECTED_ROWS.length} Fabric rows and the exclusive Fabric compaction mask.`)
  console.log('No server was started or restarted; load the profile again to activate newly added rows.')
}

async function uninstall(profile, packages) {
  const state = await localInstallState(profile, packages)
  await runPnpm([
    'dlx', DSH_PACKAGE,
    'plugin', '--profile', profile,
    'remove', ...packages.map(entry => entry.name),
  ])

  const restore = packages.flatMap(entry => {
    const spec = state.dependencies[entry.name]
    return spec === null ? [] : [`${entry.name}@${spec}`]
  })
  if (restore.length > 0) {
    await runPnpm(['dlx', DSH_PACKAGE, 'plugin', '--profile', profile, 'add', ...restore])
  }

  await verifyRestoredDependencies(profile, packages, state)
  const config = await dumpConfig(profile)
  const priorBundle = state.dependencies['dsh-fabric'] !== null
  const restoredCodeRuntime = priorBundle ? undefined : verifyUninstalled(config, profile)
  await rm(localStatePath(profile), { force: true })

  console.log(`Removed local dsh-fabric packages from profile ${JSON.stringify(profile)}.`)
  if (priorBundle) {
    console.log(`Restored the pre-existing dsh-fabric dependency ${JSON.stringify(state.dependencies['dsh-fabric'])}; that bundle remains authoritative.`)
  } else {
    console.log(`Inherited code-runtime row ${JSON.stringify(restoredCodeRuntime.name)} is present${restoredCodeRuntime.disabled ? ' and remains disabled by another overlay' : ''}; the inherited DSH preset roster is present.`)
  }
  console.log('No server was started or restarted; load the profile again to activate the recomposed profile.')
}

function parseArgs(args) {
  let profile = 'web'
  let skipBuild = false
  let uninstall = false
  let help = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      continue
    } else if (arg === '--profile') {
      const value = args[index + 1]
      if (value === undefined) throw new Error('--profile requires a value')
      profile = value
      index += 1
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else if (arg === '--skip-build') {
      skipBuild = true
    } else if (arg === '--uninstall') {
      uninstall = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`)
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw new Error(`invalid profile name ${JSON.stringify(profile)}`)
  }
  if (uninstall && skipBuild) throw new Error('--skip-build applies only to installation')
  return { profile, skipBuild, uninstall, help }
}

async function localPackages() {
  const entries = await Promise.all(LINK_PATHS.map(async path => {
    const directory = resolve(ROOT, path)
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      throw new Error(`${path}/package.json has no package name`)
    }
    return { name: manifest.name, link: `link:${directory}` }
  }))
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) {
    throw new Error('local package names are not unique')
  }
  return entries
}

function dshHomeRoot() {
  const configured = process.env.DSH_HOME?.trim()
  const selected = configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
  if (selected === '~') return homedir()
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return resolve(homedir(), selected.slice(2))
  return resolve(selected)
}

function profileDirectory(profile) {
  return join(dshHomeRoot(), 'profiles', profile)
}

function localStatePath(profile) {
  return join(profileDirectory(profile), LOCAL_STATE_FILE)
}

async function profileDependencies(profile) {
  const manifest = JSON.parse(await readFile(join(profileDirectory(profile), 'package.json'), 'utf8'))
  return typeof manifest.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {}
}

async function captureInstallState(profile, packages) {
  const existing = await readLocalState(profile)
  if (existing !== undefined) {
    validateLocalState(existing, packages)
    if (existing.root !== ROOT) throw new Error(`profile ${JSON.stringify(profile)} is already owned by local checkout ${JSON.stringify(existing.root)}`)
    return
  }
  const current = await profileDependencies(profile)
  const dependencies = Object.fromEntries(packages.map(entry => {
    const spec = typeof current[entry.name] === 'string' ? current[entry.name] : null
    return [entry.name, spec === entry.link ? null : spec]
  }))
  const state = { version: 1, root: ROOT, dependencies }
  const path = localStatePath(profile)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, path)
}

async function localInstallState(profile, packages) {
  const saved = await readLocalState(profile)
  if (saved !== undefined) {
    validateLocalState(saved, packages)
    if (saved.root !== ROOT) throw new Error(`profile ${JSON.stringify(profile)} is owned by local checkout ${JSON.stringify(saved.root)}, not this checkout`)
    return saved
  }

  const current = await profileDependencies(profile)
  if (!packages.some(entry => current[entry.name] === entry.link)) {
    throw new Error(`profile ${JSON.stringify(profile)} has no ${LOCAL_STATE_FILE}; refusing to remove packages not proven to belong to this local installer`)
  }
  return {
    version: 1,
    root: ROOT,
    dependencies: Object.fromEntries(packages.map(entry => {
      const spec = typeof current[entry.name] === 'string' ? current[entry.name] : null
      return [entry.name, spec === entry.link ? null : spec]
    })),
  }
}

async function verifyRestoredDependencies(profile, packages, state) {
  const current = await profileDependencies(profile)
  for (const entry of packages) {
    const expected = state.dependencies[entry.name]
    const actual = typeof current[entry.name] === 'string' ? current[entry.name] : null
    if (actual !== expected) {
      throw new Error(`profile ${JSON.stringify(profile)} restored ${entry.name} as ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
  }
}

async function readLocalState(profile) {
  try {
    return JSON.parse(await readFile(localStatePath(profile), 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
}

function validateLocalState(state, packages) {
  if (state === null || typeof state !== 'object' || state.version !== 1 || typeof state.root !== 'string'
    || state.dependencies === null || typeof state.dependencies !== 'object') {
    throw new Error(`invalid ${LOCAL_STATE_FILE}`)
  }
  for (const entry of packages) {
    const spec = state.dependencies[entry.name]
    if (spec !== null && typeof spec !== 'string') throw new Error(`invalid ${LOCAL_STATE_FILE} dependency for ${entry.name}`)
  }
}

async function verifyArtifacts() {
  for (const path of REQUIRED_ARTIFACTS) {
    try {
      await access(resolve(ROOT, path))
    } catch {
      throw new Error(`--skip-build requires ${path}; run without --skip-build first`)
    }
  }
}

async function dumpConfig(profile) {
  return await runPnpm([
    'dlx', DSH_PACKAGE,
    '--profile', profile,
    '--dump-config',
  ], true)
}

function verifyInstalled(config, profile) {
  for (const row of EXPECTED_ROWS) {
    if (!hasNamedRow(config, row)) {
      throw new Error(`profile ${JSON.stringify(profile)} is missing composed row ${row}`)
    }
  }
  const inheritedRows = rowsById(config, 'code-runtime')
  if (inheritedRows.length !== 1 || inheritedRows[0].disabled !== true) {
    throw new Error(`profile ${JSON.stringify(profile)} must contain exactly one disabled inherited code-runtime row`)
  }
  const fabricRows = rowsById(config, 'dsh-fabric-code-runtime')
  if (fabricRows.length !== 1
    || fabricRows[0].name !== 'dsh-fabric-code-runtime-quickjs'
    || fabricRows[0].disabled === true) {
    throw new Error(`profile ${JSON.stringify(profile)} did not activate exactly one Fabric code-runtime row`)
  }
  const toolsRows = rowsById(config, 'tools')
  if (toolsRows.length !== 1 || toolsRows[0].unlimitedCodeSubCalls !== true) {
    throw new Error(`profile ${JSON.stringify(profile)} did not remove the default Code Mode parallel sub-call throttle`)
  }
  verifyInstalledCompactionMask(config, profile)
  verifyInstalledTodoGoalMask(config, profile)
  verifyInstalledFabricPreset(profile)
}

function verifyUninstalled(config, profile) {
  for (const row of EXPECTED_ROWS) {
    if (hasNamedRow(config, row)) {
      throw new Error(`profile ${JSON.stringify(profile)} still contains Fabric row ${row}`)
    }
  }
  if (rowsById(config, 'dsh-fabric-code-runtime').length !== 0) {
    throw new Error(`profile ${JSON.stringify(profile)} still contains the Fabric code-runtime row`)
  }
  const inheritedRows = rowsById(config, 'code-runtime')
  if (inheritedRows.length !== 1
    || inheritedRows[0].name === undefined
    || inheritedRows[0].name === 'dsh-fabric-code-runtime-quickjs') {
    throw new Error(`profile ${JSON.stringify(profile)} did not retain exactly one non-Fabric inherited code-runtime row`)
  }
  verifyRestoredCompaction(config, profile)
  return inheritedRows[0]
}

function verifyInstalledTodoGoalMask(config, profile) {
  for (const id of ['command-goal', 'goal-round-driver', 'ui-goal']) {
    const rows = rowsById(config, id)
    if (rows.length !== 1 || rows[0].disabled !== true) {
      throw new Error('profile ' + JSON.stringify(profile) + ' must contain exactly one disabled inherited ' + id + ' row')
    }
  }
}

function verifyInstalledFabricPreset(profile) {
  const presetPath = resolve(ROOT, 'packages/compaction/presets/fabric/agent.cordis.yml')
  const composition = readFileSync(presetPath, 'utf8')
  for (const row of [
    { id: 'dsh-fabric-mesh-tool', name: 'dsh-fabric-mesh/tool' },
    { id: 'dsh-fabric-system-prompt', name: 'dsh-fabric-system-prompt' },
  ]) {
    const anchored = '- id: ' + row.id + '\n  name: ' + JSON.stringify(row.name)
    if (!composition.includes(anchored)) {
      throw new Error('profile ' + JSON.stringify(profile) + ' fabric preset does not mount ' + row.id + ' (' + row.name + ')')
    }
  }
}

function verifyInstalledCompactionMask(config, profile) {
  for (const id of ['compaction-basic', 'tool-result-pruner', 'agent-presets']) {
    const rows = rowsById(config, id)
    if (rows.length !== 1 || rows[0].disabled !== true) {
      throw new Error(`profile ${JSON.stringify(profile)} must contain exactly one disabled inherited ${id} row`)
    }
  }
  const engine = rowsById(config, 'dsh-fabric-compaction')
  const presetRoot = rowsById(config, 'dsh-fabric-preset-root')
  const presets = rowsById(config, 'dsh-fabric-agent-presets')
  if (engine.length !== 1 || engine[0].name !== 'dsh-fabric-compaction' || engine[0].disabled === true
    || presetRoot.length !== 1 || presetRoot[0].name !== 'dsh-fabric-compaction/presets' || presetRoot[0].disabled === true
    || presets.length !== 1 || presets[0].name !== '@monotykamary/dsh-agent-presets' || presets[0].disabled === true) {
    throw new Error(`profile ${JSON.stringify(profile)} did not activate the exclusive Fabric compaction engine and host-native roster`)
  }
}

function verifyRestoredCompaction(config, profile) {
  if (!hasNamedRow(config, '@monotykamary/dsh-compaction-basic')) {
    throw new Error(`profile ${JSON.stringify(profile)} does not retain the inherited DSH compaction capability`)
  }
  const roster = rowsById(config, 'agent-presets')
  if (roster.length !== 1 || roster[0].name !== '@monotykamary/dsh-agent-presets') {
    throw new Error(`profile ${JSON.stringify(profile)} did not retain the inherited DSH preset roster`)
  }
}

function hasNamedRow(config, name) {
  return config.includes(`name: '${name}'`)
    || config.includes(`name: "${name}"`)
    || config.includes(`name: ${name}`)
}

function rowsById(config, id) {
  const rows = [...config.matchAll(new RegExp(`^- id: ${escapeRegex(id)}\\r?\\n((?: {2}[^\\n]*(?:\\n|$))*)`, 'gm'))]
  return rows.map(row => {
    const rawName = /^  name:\s+(.+)$/m.exec(row[1])?.[1]?.trim()
    return {
      name: rawName?.replace(/^(['"])(.*)\1$/, '$2'),
      disabled: /^  disabled:\s+true\s*$/m.test(row[1]),
      unlimitedCodeSubCalls: /^    maxParallelSubCalls:\s+!!js Number\.MAX_SAFE_INTEGER\s*$/m.test(row[1]),
    }
  })
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runPnpm(args, capture = false) {
  const invocation = pnpmInvocation(args)
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: ROOT,
      env: process.env,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    })
    let stdout = ''
    if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new Error(`pnpm ${args.join(' ')} failed${signal === null ? ` with exit code ${code}` : ` from signal ${signal}`}`))
    })
  })
}

function pnpmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'pnpm', args }
  const entry = process.env.npm_execpath
  if (entry === undefined || !/\.[cm]?js$/i.test(entry)) {
    throw new Error('on Windows, invoke this installer through pnpm run so npm_execpath identifies pnpm without a shell')
  }
  return { command: process.execPath, args: [entry, ...args] }
}

function printHelp() {
  console.log(`Usage:
  pnpm run install:local -- [options]
  pnpm run uninstall:local -- [options]

Link or remove this source checkout in a DSH profile without starting it.

Options:
  --profile <name>  Target profile (default: web)
  --skip-build      Reuse existing lib artifacts during installation
  -h, --help        Show this help

DSH_HOME is inherited when you need a non-default profile root.`)
}
