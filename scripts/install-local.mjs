#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
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

  await verifyCheckout()
  if (options.skipBuild) {
    await verifyArtifacts()
  } else {
    await runPnpm(['install', '--frozen-lockfile'])
    await runPnpm(['run', 'build'])
  }

  const links = LINK_PATHS.map(path => `link:${resolve(ROOT, path)}`)
  await runPnpm([
    'dlx', DSH_PACKAGE,
    'plugin', '--profile', options.profile,
    'add', ...links,
  ])

  const config = await runPnpm([
    'dlx', DSH_PACKAGE,
    '--profile', options.profile,
    '--dump-config',
  ], true)
  verifyComposition(config, options.profile)

  console.log(`Installed dsh-fabric into profile ${JSON.stringify(options.profile)}.`)
  console.log('Validated all 5 Fabric rows and the inherited DSH compaction row.')
  console.log('No server was started or restarted; load the profile again to activate newly added rows.')
}

function parseArgs(args) {
  let profile = 'web'
  let skipBuild = false
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
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`)
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw new Error(`invalid profile name ${JSON.stringify(profile)}`)
  }
  return { profile, skipBuild, help }
}

async function verifyCheckout() {
  for (const path of LINK_PATHS) await access(resolve(ROOT, path, 'package.json'))
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

function verifyComposition(config, profile) {
  for (const row of EXPECTED_ROWS) {
    if (!config.includes(`name: '${row}'`) && !config.includes(`name: "${row}"`) && !config.includes(`name: ${row}`)) {
      throw new Error(`profile ${JSON.stringify(profile)} is missing composed row ${row}`)
    }
  }
  if (!/\bid:\s+compaction\b/.test(config)) {
    throw new Error(`profile ${JSON.stringify(profile)} does not retain DSH compaction`)
  }
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
  console.log(`Usage: pnpm run install:local -- [options]

Build and link this source checkout into a DSH profile without starting it.

Options:
  --profile <name>  Target profile (default: web)
  --skip-build      Reuse existing lib artifacts
  -h, --help        Show this help

DSH_HOME is inherited when you need a non-default profile root.`)
}
