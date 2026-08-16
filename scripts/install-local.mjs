#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.6'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const LINK_PATHS = [
  '.',
  'packages/protocol',
  'packages/host',
  'packages/mesh',
  'packages/code-runtime-quickjs',
  'packages/client-ui',
]
const EXPECTED_ROWS = [
  '@dsh-fabric/code-runtime-quickjs',
  '@dsh-fabric/host',
  '@dsh-fabric/mesh/provider',
  '@dsh-fabric/mesh/tool',
  '@dsh-fabric/client-ui',
]
const REQUIRED_ARTIFACTS = [
  'packages/protocol/lib/index.js',
  'packages/host/lib/index.js',
  'packages/mesh/lib/provider.js',
  'packages/mesh/lib/tool.js',
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

  await runPnpm([
    'dlx', DSH_PACKAGE,
    'plugin', '--profile', options.profile,
    'add', ...packages.map(entry => entry.link),
  ])

  const config = await dumpConfig(options.profile)
  verifyInstalled(config, options.profile)

  console.log(`Installed dsh-fabric into profile ${JSON.stringify(options.profile)}.`)
  console.log('Validated all 5 Fabric rows and unchanged DSH compaction capability configuration.')
  console.log('No server was started or restarted; load the profile again to activate newly added rows.')
}

async function uninstall(profile, packages) {
  await runPnpm([
    'dlx', DSH_PACKAGE,
    'plugin', '--profile', profile,
    'remove', ...packages.map(entry => entry.name),
  ])

  const config = await dumpConfig(profile)
  const restoredCodeRuntime = verifyUninstalled(config, profile)

  console.log(`Removed local dsh-fabric packages from profile ${JSON.stringify(profile)}.`)
  console.log(`Restored inherited code-runtime row ${JSON.stringify(restoredCodeRuntime)} and retained DSH compaction configuration.`)
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
    || fabricRows[0].name !== '@dsh-fabric/code-runtime-quickjs'
    || fabricRows[0].disabled === true) {
    throw new Error(`profile ${JSON.stringify(profile)} did not activate exactly one Fabric code-runtime row`)
  }
  verifyCompactionConfiguration(config, profile)
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
    || inheritedRows[0].name === '@dsh-fabric/code-runtime-quickjs'
    || inheritedRows[0].disabled === true) {
    throw new Error(`profile ${JSON.stringify(profile)} did not restore exactly one enabled inherited code-runtime row`)
  }
  verifyCompactionConfiguration(config, profile)
  return inheritedRows[0].name
}

function verifyCompactionConfiguration(config, profile) {
  if (!hasNamedRow(config, '@deepseek-ai/dsh-compaction-basic')) {
    throw new Error(`profile ${JSON.stringify(profile)} does not retain DSH compaction capability configuration`)
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
    }
  })
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runPnpm(args, capture = false) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(PNPM, args, {
      cwd: ROOT,
      env: process.env,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    })
    let stdout = ''
    if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new Error(`${PNPM} ${args.join(' ')} failed${signal === null ? ` with exit code ${code}` : ` from signal ${signal}`}`))
    })
  })
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
