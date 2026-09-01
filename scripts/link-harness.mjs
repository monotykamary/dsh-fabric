#!/usr/bin/env node

import { lstat, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const links = JSON.parse(await readFile(resolve(ROOT, 'scripts/harness-links.json'), 'utf8'))
const targets = new Map()

for (const [name, relativePath] of Object.entries(links)) {
  const target = resolve(ROOT, relativePath)
  const manifest = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'))
  if (manifest.name !== name) {
    throw new Error(`${relativePath}/package.json names ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(name)}`)
  }
  targets.set(name, target)
}

const directories = await workspaceDirectories()
let linked = 0
for (const directory of directories) {
  for (const [name, target] of targets) {
    const destination = resolve(directory, 'node_modules', name)
    if (directory !== ROOT && !(await exists(destination))) continue
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
    if (await realpath(destination) !== await realpath(target)) {
      throw new Error(`failed to link ${name} into ${directory}`)
    }
    linked += 1
  }
}

console.log(`linked ${targets.size} DeepSeek Harness packages across ${directories.length} workspace locations (${linked} overlays)`)

async function workspaceDirectories() {
  const manifest = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  const result = [ROOT]
  for (const pattern of manifest.workspaces ?? []) {
    if (pattern === '.') continue
    if (pattern.endsWith('/*')) {
      const parent = resolve(ROOT, pattern.slice(0, -2))
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && await exists(resolve(parent, entry.name, 'package.json'))) {
          result.push(resolve(parent, entry.name))
        }
      }
    } else {
      const directory = resolve(ROOT, pattern)
      if (await exists(resolve(directory, 'package.json'))) result.push(directory)
    }
  }
  return result
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}
