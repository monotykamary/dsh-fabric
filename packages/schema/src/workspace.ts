import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SNAPSHOT_MAX_FILES = 20_000
const SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024
const FALLBACK_SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
])

export interface WorkspaceSnapshot {
  fingerprint: string
  git: boolean
  head: string | null
  indexDigest: string | null
  entries: Record<string, string>
  files: number
  bytes: number
}

const digest = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex')

const git = (cwd: string, args: string[]): Buffer =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

const nulPaths = (buffer: Buffer): string[] =>
  buffer
    .toString('utf8')
    .split('\0')
    .filter((item) => item.length > 0)

const normalizeRelative = (value: string): string => value.split(path.sep).join('/')

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

const excluded = (absolute: string, exclusions: string[]): boolean =>
  exclusions.some((root) => isInside(root, absolute))

const entryDigest = (absolute: string): { marker: string; bytes: number } => {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(absolute)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { marker: 'absent', bytes: 0 }
    }
    throw error
  }
  if (stat.isSymbolicLink()) {
    return { marker: `symlink:${digest(fs.readlinkSync(absolute))}`, bytes: 0 }
  }
  if (!stat.isFile()) {
    throw new Error(`Schema workspace snapshot does not support non-file entry: ${absolute}`)
  }
  return { marker: `file:${stat.mode & 0o777}:${digest(fs.readFileSync(absolute))}`, bytes: stat.size }
}

const buildSnapshot = (
  cwd: string,
  paths: string[],
  metadata: { git: boolean; head: string | null; indexDigest: string | null },
  exclusions: string[],
): WorkspaceSnapshot => {
  const entries: Record<string, string> = {}
  let bytes = 0
  const unique = [...new Set(paths)].sort((left, right) => left.localeCompare(right))
  for (const relativeInput of unique) {
    const absolute = path.resolve(cwd, relativeInput)
    if (!isInside(cwd, absolute) || excluded(absolute, exclusions)) continue
    if (Object.keys(entries).length >= SNAPSHOT_MAX_FILES) {
      throw new Error(`Schema workspace snapshot exceeds ${SNAPSHOT_MAX_FILES} files`)
    }
    const relative = normalizeRelative(path.relative(cwd, absolute))
    const entry = entryDigest(absolute)
    bytes += entry.bytes
    if (bytes > SNAPSHOT_MAX_BYTES) {
      throw new Error(`Schema workspace snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes`)
    }
    entries[relative] = entry.marker
  }
  const fingerprint = `sha256:${digest(JSON.stringify({
    format: 1,
    git: metadata.git,
    head: metadata.head,
    indexDigest: metadata.indexDigest,
    entries,
  }))}`
  return {
    fingerprint,
    ...metadata,
    entries,
    files: Object.keys(entries).length,
    bytes,
  }
}

const fallbackPaths = (cwd: string, exclusions: string[]): string[] => {
  const paths: string[] = []
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (FALLBACK_SKIPPED_DIRECTORIES.has(entry.name)) continue
      const absolute = path.join(directory, entry.name)
      if (excluded(absolute, exclusions)) continue
      const relative = normalizeRelative(path.relative(cwd, absolute))
      if (entry.isDirectory()) visit(absolute)
      else paths.push(relative)
      if (paths.length > SNAPSHOT_MAX_FILES) {
        throw new Error(`Schema workspace snapshot exceeds ${SNAPSHOT_MAX_FILES} files`)
      }
    }
  }
  visit(cwd)
  return paths
}

export const snapshotWorkspace = (cwdInput: string, excludedRoots: string[] = []): WorkspaceSnapshot => {
  const cwd = fs.realpathSync(cwdInput)
  const exclusions = excludedRoots
    .map((root) => {
      const absolute = path.resolve(root)
      try {
        return fs.realpathSync(absolute)
      } catch {
        return absolute
      }
    })
    .filter((root) => isInside(cwd, root))
  let worktreePrefix: string
  try {
    worktreePrefix = git(cwd, ['rev-parse', '--show-prefix'])
      .toString('utf8')
      .trim()
  } catch {
    return buildSnapshot(
      cwd,
      fallbackPaths(cwd, exclusions),
      { git: false, head: null, indexDigest: null },
      exclusions,
    )
  }
  if (worktreePrefix !== '') {
    throw new Error('Schema enforce mode requires cwd to be the Git worktree root')
  }
  let head: string | null = null
  try {
    head = git(cwd, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim() || null
  } catch {
    head = null
  }
  const index = git(cwd, ['ls-files', '--stage', '-z'])
  const tracked = nulPaths(git(cwd, ['ls-files', '-z']))
  const untracked = nulPaths(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
  return buildSnapshot(
    cwd,
    [...tracked, ...untracked],
    { git: true, head, indexDigest: `sha256:${digest(index)}` },
    exclusions,
  )
}

export const resolveWorkspaceFile = (
  cwdInput: string,
  requestedPath: string,
  options: { allowAbsent: boolean },
): { absolute: string; relative: string; exists: boolean } => {
  if (!requestedPath.trim() || path.isAbsolute(requestedPath)) {
    throw new Error(`Schema paths must be non-empty project-relative paths: ${requestedPath}`)
  }
  const cwd = fs.realpathSync(cwdInput)
  const absolute = path.resolve(cwd, requestedPath)
  if (!isInside(cwd, absolute) || absolute === cwd) {
    throw new Error(`Schema path escapes the project workspace: ${requestedPath}`)
  }
  const relativeParts = path.relative(cwd, absolute).split(path.sep)
  let cursor = cwd
  for (let index = 0; index < relativeParts.length; index++) {
    cursor = path.join(cursor, relativeParts[index]!)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(cursor)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        if (index !== relativeParts.length - 1 || !options.allowAbsent) {
          throw new Error(`Schema path does not exist: ${requestedPath}`)
        }
        const parentReal = fs.realpathSync(path.dirname(cursor))
        if (!isInside(cwd, parentReal)) throw new Error(`Schema path parent escapes the workspace: ${requestedPath}`)
        return { absolute, relative: normalizeRelative(path.relative(cwd, absolute)), exists: false }
      }
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Schema path may not traverse a symbolic link: ${requestedPath}`)
    if (index < relativeParts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Schema path parent is not a directory: ${requestedPath}`)
    }
    if (index === relativeParts.length - 1 && !stat.isFile()) {
      throw new Error(`Schema transaction paths must name regular files: ${requestedPath}`)
    }
  }
  return { absolute, relative: normalizeRelative(path.relative(cwd, absolute)), exists: true }
}

export const sha256File = (absolute: string): string =>
  `sha256:${digest(fs.readFileSync(absolute))}`
