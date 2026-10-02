import { rm, mkdtemp, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { kiroCwdHash } from '../../shared/kiro-session-log'
import * as fsAccess from '../native-chat/wsl-transcript-fs-access'
import { scanAiVaultSessions } from './session-scanner'
import { kiroFixtureMetadata, writeKiroFixtureSession } from './session-scanner-kiro-fixtures'
import {
  discoverInScopeKiroSessionFiles,
  resetKiroBucketRootsCacheForTests
} from './session-scanner-kiro-scope-discovery'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetKiroBucketRootsCacheForTests()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

const WORKSPACE = '/home/ada/orca/workspaces/orca/feature'

async function writeSession(args: {
  sessionsDir: string
  cwd: string
  id: string
  timestamp: string
  bucket?: string
}): Promise<string> {
  const path = await writeKiroFixtureSession({
    sessionsDir: args.sessionsDir,
    bucket: args.bucket ?? kiroCwdHash(args.cwd, 'linux'),
    id: args.id,
    metadata: kiroFixtureMetadata({ id: args.id, title: args.id, workspacePaths: [args.cwd] })
  })
  const time = new Date(args.timestamp)
  await utimes(path, time, time)
  return path
}

async function rootsFor(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return isolatedScanRoots(root)
}

describe('Kiro scope discovery', () => {
  it('lists older exact-hash and subfolder sessions the recency cap would drop', async () => {
    const roots = await rootsFor('orca-kiro-scope-')
    await writeSession({
      sessionsDir: roots.kiroSessionsDir,
      cwd: WORKSPACE,
      id: 'sess_exact',
      timestamp: '2026-04-01T10:00:00.000Z'
    })
    // A subfolder hashes to its own bucket; only its recorded root proves membership.
    await writeSession({
      sessionsDir: roots.kiroSessionsDir,
      cwd: `${WORKSPACE}/packages/app`,
      id: 'sess_sub',
      timestamp: '2026-04-02T10:00:00.000Z'
    })
    await writeSession({
      sessionsDir: roots.kiroSessionsDir,
      cwd: `${WORKSPACE}-sibling`,
      id: 'sess_sibling',
      timestamp: '2026-04-03T10:00:00.000Z'
    })
    await writeSession({
      sessionsDir: roots.kiroSessionsDir,
      cwd: '/home/ada/elsewhere',
      id: 'sess_recent',
      timestamp: '2026-06-01T10:00:00.000Z'
    })
    await writeSession({
      sessionsDir: roots.kiroSessionsDir,
      cwd: '/home/ada/elsewhere-too',
      id: 'sess_recent_too',
      timestamp: '2026-06-02T10:00:00.000Z'
    })

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'linux',
      limit: 2,
      scopePaths: [WORKSPACE]
    })
    const ids = result.sessions.map((session) => session.sessionId)

    expect(result.issues).toEqual([])
    expect(ids).toEqual(expect.arrayContaining(['sess_exact', 'sess_sub', 'sess_recent_too']))
    expect(ids).not.toContain('sess_sibling')
  })

  it('matches a WSL UNC scope against the Linux workspace root', async () => {
    const roots = await rootsFor('orca-kiro-scope-wsl-')
    const path = await writeSession({
      sessionsDir: roots.kiroSessionsDir,
      cwd: '/home/ada/repo',
      id: 'sess_wsl',
      timestamp: '2026-04-01T10:00:00.000Z'
    })
    const files = await discoverInScopeKiroSessionFiles({
      rootDirs: [roots.kiroSessionsDir],
      scopePaths: ['\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'],
      limit: 10,
      excludedFilePaths: new Set(),
      issues: []
    })
    expect(files.map((file) => file.path)).toEqual([path])
    expect(files[0]?.sidecar).toMatchObject({ path: join(path, '..', 'session.json') })
  })

  it('resolves a non-matching bucket once, then serves its roots from cache', async () => {
    const roots = await rootsFor('orca-kiro-scope-cache-')
    await writeSession({
      sessionsDir: roots.kiroSessionsDir,
      cwd: '/home/ada/elsewhere',
      id: 'sess_out',
      timestamp: '2026-04-01T10:00:00.000Z'
    })
    const readFile = vi.spyOn(fsAccess, 'wslGatedReadFile')
    const discover = () =>
      discoverInScopeKiroSessionFiles({
        rootDirs: [roots.kiroSessionsDir],
        scopePaths: [WORKSPACE],
        limit: 10,
        excludedFilePaths: new Set(),
        issues: []
      })

    expect(await discover()).toEqual([])
    const coldReads = readFile.mock.calls.length
    expect(coldReads).toBeGreaterThan(0)
    expect(await discover()).toEqual([])
    expect(readFile.mock.calls.length).toBe(coldReads)
  })

  it('prefers the bucket index over session.json reads', async () => {
    const roots = await rootsFor('orca-kiro-scope-index-')
    const bucket = kiroCwdHash(`${WORKSPACE}/sub`, 'linux')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(roots.kiroSessionsDir, bucket, '.index'), { recursive: true })
    await writeFile(
      join(roots.kiroSessionsDir, bucket, '.index', 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ id: 'sess_x', workspacePaths: [`${WORKSPACE}/sub`] }]
      })
    )
    const path = await writeSession({
      sessionsDir: roots.kiroSessionsDir,
      cwd: `${WORKSPACE}/sub`,
      id: 'sess_x',
      bucket,
      timestamp: '2026-04-01T10:00:00.000Z'
    })
    const readFile = vi.spyOn(fsAccess, 'wslGatedReadFile')
    const files = await discoverInScopeKiroSessionFiles({
      rootDirs: [roots.kiroSessionsDir],
      scopePaths: [WORKSPACE],
      limit: 10,
      excludedFilePaths: new Set(),
      issues: []
    })
    expect(files.map((file) => file.path)).toEqual([path])
    expect(readFile.mock.calls.map(([readPath]) => String(readPath))).toEqual([
      join(roots.kiroSessionsDir, bucket, '.index', 'index.json')
    ])
  })
})
