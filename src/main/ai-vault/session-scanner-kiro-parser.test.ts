import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { AI_VAULT_AGENT_SOURCES, isDiscoverableSessionFile } from './session-scanner-agent-sources'
import { discoverFiles } from './session-scanner-discovery'
import {
  KIRO_FIXTURE_PROMPT,
  KIRO_FIXTURE_REPLY,
  kiroFixtureMetadata,
  kiroFixtureRecords,
  writeKiroFixtureSession
} from './session-scanner-kiro-fixtures'
import { readKiroSessionMetadata } from './session-scanner-kiro-metadata'
import { parseKiroSessionFile } from './session-scanner-kiro-parser'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { registerTranscriptConsumer } from './session-transcript-consumers'
import { jsonlBody } from './session-scanner-vault-roots'

const BUCKET = '0123456789abcdef'
const SESSION_ID = 'sess_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
let tempRoots: string[] = []

afterEach(async () => {
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function kiroRoots() {
  const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-kiro-'))
  tempRoots.push(root)
  return isolatedScanRoots(root)
}

async function scanKiro(roots: ReturnType<typeof isolatedScanRoots>) {
  const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 10 })
  return {
    sessions: result.sessions.filter((session) => session.agent === 'kiro'),
    issues: result.issues.filter((issue) => issue.agent === 'kiro')
  }
}

describe('Kiro session metadata', () => {
  it('replaces the default title with null and reads root 0, model and createdAt', () => {
    const read = readKiroSessionMetadata(
      JSON.stringify(
        kiroFixtureMetadata({ id: SESSION_ID, workspacePaths: ['/repo', '/other'], modelId: 'm' })
      )
    )
    expect(read).toEqual({
      kind: 'listed',
      metadata: {
        title: null,
        cwd: '/repo',
        model: 'm',
        createdAt: '2026-05-01T10:09:59.000Z'
      }
    })
  })

  it.each([
    [null, 'invalid'],
    ['{not json', 'invalid'],
    ['[]', 'invalid'],
    [JSON.stringify({ schemaVersion: '2.0.0', workspacePaths: ['/r'] }), 'invalid'],
    [JSON.stringify({ workspacePaths: ['/r'] }), 'invalid'],
    [
      JSON.stringify({
        schemaVersion: '1.0.0',
        workspacePaths: ['/r'],
        _meta: { kiro: { executionTarget: { kind: 'cloud' } } }
      }),
      'hidden'
    ]
  ])('classifies %s as %s', (content, kind) => {
    expect(readKiroSessionMetadata(content).kind).toBe(kind)
  })
})

describe('Kiro session parsing', () => {
  it('lists title, cwd, model, previews and resume command without injected records', async () => {
    const roots = await kiroRoots()
    await writeKiroFixtureSession({
      sessionsDir: roots.kiroSessionsDir,
      bucket: BUCKET,
      id: SESSION_ID,
      metadata: kiroFixtureMetadata({
        id: SESSION_ID,
        title: 'Generated title',
        workspacePaths: ['/repo'],
        modelId: 'claude-sonnet'
      })
    })

    const { sessions, issues } = await scanKiro(roots)

    expect(issues).toEqual([])
    expect(sessions).toHaveLength(1)
    const [session] = sessions
    expect(session).toMatchObject({
      sessionId: SESSION_ID,
      title: 'Generated title',
      cwd: '/repo',
      model: 'claude-sonnet',
      messageCount: 2,
      createdAt: '2026-05-01T10:09:59.000Z',
      updatedAt: '2026-05-01T10:10:03.000Z',
      resumeCommand: `cd '/repo' && kiro-cli chat --tui --v3 --resume-id '${SESSION_ID}'`
    })
    expect(session.previewMessages.map((message) => [message.role, message.text])).toEqual([
      ['user', KIRO_FIXTURE_PROMPT],
      ['assistant', KIRO_FIXTURE_REPLY]
    ])
    const previewText = session.previewMessages.map((message) => message.text).join('\n')
    expect(previewText).not.toContain('session_context')
    expect(previewText).not.toContain('steering')
    expect(previewText).not.toContain('Thinking')
  })

  it('falls back to the first real prompt when Kiro has not titled the session', async () => {
    const roots = await kiroRoots()
    await writeKiroFixtureSession({
      sessionsDir: roots.kiroSessionsDir,
      bucket: BUCKET,
      id: SESSION_ID,
      metadata: kiroFixtureMetadata({ id: SESSION_ID, workspacePaths: ['/repo'] })
    })
    const { sessions } = await scanKiro(roots)
    expect(sessions[0]?.title).toBe(KIRO_FIXTURE_PROMPT)
    expect(sessions[0]?.model).toBeNull()
  })

  it('skips malformed and partial lines', async () => {
    const roots = await kiroRoots()
    const path = await writeKiroFixtureSession({
      sessionsDir: roots.kiroSessionsDir,
      bucket: BUCKET,
      id: SESSION_ID,
      metadata: kiroFixtureMetadata({ id: SESSION_ID, workspacePaths: ['/repo'] })
    })
    await appendFile(path, '{"id":"x","payload":\nnot json\n{"id":"half","timestamp":')
    const { sessions, issues } = await scanKiro(roots)
    expect(issues).toEqual([])
    expect(sessions[0]?.messageCount).toBe(2)
  })

  it.each([
    ['missing', null],
    ['garbled', '{"schemaVersion":'],
    ['unknown schema', JSON.stringify({ schemaVersion: '2.0.0', workspacePaths: ['/repo'] })]
  ])('hides a session with %s session.json and reports it', async (_label, metadata) => {
    const roots = await kiroRoots()
    await writeKiroFixtureSession({
      sessionsDir: roots.kiroSessionsDir,
      bucket: BUCKET,
      id: SESSION_ID,
      metadata
    })
    const first = await scanKiro(roots)
    expect(first.sessions).toEqual([])
    expect(first.issues).toHaveLength(1)
    expect(first.issues[0]?.path.endsWith('session.json')).toBe(true)
    // Still reported on a warm scan, so the problem never silently disappears.
    expect((await scanKiro(roots)).issues).toHaveLength(1)
  })

  it('hides a non-local execution target without an issue', async () => {
    const roots = await kiroRoots()
    await writeKiroFixtureSession({
      sessionsDir: roots.kiroSessionsDir,
      bucket: BUCKET,
      id: SESSION_ID,
      metadata: kiroFixtureMetadata({
        id: SESSION_ID,
        workspacePaths: ['/repo'],
        _meta: { kiro: { executionTarget: { kind: 'sandbox' } } }
      })
    })
    expect(await scanKiro(roots)).toEqual({ sessions: [], issues: [] })
  })

  it('hands the search index a fold with the workspace cwd, and none for a cloud or unknown-schema session', async () => {
    const roots = await kiroRoots()
    const outcomes: (string | null)[] = []
    const unregister = registerTranscriptConsumer({
      beginRead: () => ({
        message: () => {},
        finish: (outcome) =>
          outcomes.push(outcome.session ? (outcome.session.cwd ?? 'indexed-without-cwd') : null)
      })
    })
    try {
      await writeKiroFixtureSession({
        sessionsDir: roots.kiroSessionsDir,
        bucket: BUCKET,
        id: SESSION_ID,
        metadata: kiroFixtureMetadata({ id: SESSION_ID, workspacePaths: ['/repo'] })
      })
      const cloudId = 'sess_cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      await writeKiroFixtureSession({
        sessionsDir: roots.kiroSessionsDir,
        bucket: BUCKET,
        id: cloudId,
        metadata: kiroFixtureMetadata({
          id: cloudId,
          workspacePaths: ['/repo'],
          _meta: { kiro: { executionTarget: { kind: 'sandbox' } } }
        })
      })
      const futureId = 'sess_dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      await writeKiroFixtureSession({
        sessionsDir: roots.kiroSessionsDir,
        bucket: BUCKET,
        id: futureId,
        metadata: JSON.stringify({ schemaVersion: '2.0.0', workspacePaths: ['/repo'] })
      })
      for (const file of await discoverKiro(roots.kiroSessionsDir)) {
        await parseAgentSessionFileCached({ agent: 'kiro', file, codexHome: null }, 'darwin')
      }
    } finally {
      unregister()
    }
    expect(outcomes.sort()).toEqual(['/repo', null, null].sort())
  })

  it('re-merges a rename from session.json without re-reading the transcript', async () => {
    const roots = await kiroRoots()
    const path = await writeKiroFixtureSession({
      sessionsDir: roots.kiroSessionsDir,
      bucket: BUCKET,
      id: SESSION_ID,
      metadata: kiroFixtureMetadata({ id: SESSION_ID, workspacePaths: ['/repo'] })
    })
    const candidate = async () => ({
      agent: 'kiro' as const,
      file: (await discoverKiro(roots.kiroSessionsDir))[0],
      codexHome: null
    })
    const stats = createSessionParseStats()
    expect((await parseAgentSessionFileCached(await candidate(), 'darwin', stats))?.title).toBe(
      KIRO_FIXTURE_PROMPT
    )
    await writeFile(
      join(path, '..', 'session.json'),
      JSON.stringify(
        kiroFixtureMetadata({ id: SESSION_ID, title: 'Renamed', workspacePaths: ['/repo'] })
      )
    )
    const renamed = await parseAgentSessionFileCached(await candidate(), 'darwin', stats)
    expect(renamed?.title).toBe('Renamed')
    expect(stats.fullParses).toBe(1)
    expect(stats.reused).toBe(1)
  })

  it('resumes an appended transcript to the same result as a full parse', async () => {
    const roots = await kiroRoots()
    const path = await writeKiroFixtureSession({
      sessionsDir: roots.kiroSessionsDir,
      bucket: BUCKET,
      id: SESSION_ID,
      metadata: kiroFixtureMetadata({ id: SESSION_ID, workspacePaths: ['/repo'] }),
      records: kiroFixtureRecords().slice(0, 5)
    })
    const stats = createSessionParseStats()
    const candidate = async () => ({
      agent: 'kiro' as const,
      file: (await discoverKiro(roots.kiroSessionsDir))[0],
      codexHome: null
    })
    await parseAgentSessionFileCached(await candidate(), 'darwin', stats)
    await appendFile(path, jsonlBody(kiroFixtureRecords().slice(5)))
    const grown = await candidate()
    const resumed = await parseAgentSessionFileCached(grown, 'darwin', stats)
    expect(stats.incremental).toBe(1)
    expect(resumed).toEqual(await parseKiroSessionFile(grown.file, 'darwin'))
    expect(resumed?.messageCount).toBe(2)
  })

  it('does not discover cli/, _global/, .index or sub-execution transcripts', async () => {
    const roots = await kiroRoots()
    const dir = roots.kiroSessionsDir
    const listed = await writeKiroFixtureSession({
      sessionsDir: dir,
      bucket: BUCKET,
      id: SESSION_ID,
      metadata: kiroFixtureMetadata({ id: SESSION_ID, workspacePaths: ['/repo'] })
    })
    for (const bucket of ['cli', '_global', 'not-a-hash']) {
      await writeKiroFixtureSession({
        sessionsDir: dir,
        bucket,
        id: 'sess_hidden',
        metadata: kiroFixtureMetadata({ id: 'sess_hidden', workspacePaths: ['/repo'] })
      })
    }
    await mkdir(join(dir, BUCKET, '.index'), { recursive: true })
    await writeFile(join(dir, BUCKET, '.index', 'messages.jsonl'), '{}\n')
    await mkdir(join(dir, BUCKET, SESSION_ID, 'sub-executions', 'sess_child'), { recursive: true })
    await writeFile(
      join(dir, BUCKET, SESSION_ID, 'sub-executions', 'sess_child', 'messages.jsonl'),
      jsonlBody(kiroFixtureRecords())
    )
    await writeFile(join(dir, 'cli', 'history.jsonl'), '{}\n')

    expect((await discoverKiro(dir)).map((file) => file.path)).toEqual([listed])
    const source = AI_VAULT_AGENT_SOURCES.kiro!
    expect(isDiscoverableSessionFile(source, dir, listed)).toBe(true)
    expect(
      isDiscoverableSessionFile(source, dir, join(dir, 'cli', 'sess_hidden', 'messages.jsonl'))
    ).toBe(false)
    expect(
      isDiscoverableSessionFile(
        source,
        dir,
        join(dir, BUCKET, SESSION_ID, 'sub-executions', 'sess_child', 'messages.jsonl')
      )
    ).toBe(false)
  })
})

async function discoverKiro(rootDir: string) {
  const source = AI_VAULT_AGENT_SOURCES.kiro!
  const discovery = await discoverFiles({
    rootDir,
    limit: 50,
    agent: 'kiro',
    issues: [],
    extensions: [...source.extensions],
    filePredicate: source.filePredicate,
    contentDependencyPath: source.contentDependencyPath,
    directoryPredicate: source.directoryPredicate
  })
  return discovery.files
}
