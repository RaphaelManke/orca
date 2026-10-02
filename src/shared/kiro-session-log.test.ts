import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createKiroSessionLogState,
  kiroCwdHash,
  kiroSessionDir,
  normalizeKiroWorkspaceRoot,
  readKiroSessionLog,
  type KiroSessionLogState
} from './kiro-session-log'

const SESSION_ID = 'sess_test-1'
const CWD = '/tmp/kiro-s0-scratch/approve'

function fixtureLines(name: string): string[] {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

function indexOfType(lines: string[], type: string, from = 0): number {
  const index = lines.findIndex((line, i) => i >= from && line.includes(`"type":"${type}"`))
  if (index === -1) {
    throw new Error(`fixture has no ${type} after line ${from}`)
  }
  return index
}

describe('kiroCwdHash', () => {
  it('matches the macOS store directory recorded in Stage 0 (realpath of a symlinked cwd)', () => {
    expect(kiroCwdHash('/private/tmp/kiro-s0-scratch/real', 'darwin')).toBe('7afb1a0dc1580158')
  })

  it('strips trailing slashes but keeps the root', () => {
    expect(normalizeKiroWorkspaceRoot('/a/b//', 'linux')).toBe('/a/b')
    expect(normalizeKiroWorkspaceRoot('/a/./c/../b', 'linux')).toBe('/a/b')
    expect(normalizeKiroWorkspaceRoot('/', 'linux')).toBe('/')
  })

  it('lowercases and forward-slashes Windows paths, keeping a drive root and UNC prefix', () => {
    expect(normalizeKiroWorkspaceRoot('C:\\Users\\X\\Proj\\', 'win32')).toBe('c:/users/x/proj')
    expect(kiroCwdHash('C:\\Users\\X\\Proj', 'win32')).toBe(
      createHash('sha256').update('c:/users/x/proj').digest('hex').slice(0, 16)
    )
    expect(normalizeKiroWorkspaceRoot('C:\\', 'win32')).toBe('c:/')
    expect(normalizeKiroWorkspaceRoot('\\\\Server\\Share\\Dir', 'win32')).toBe('//server/share/dir')
  })
})

describe('kiro session log', () => {
  let homeDir: string
  let sessionDir: string
  let logPath: string
  let log: KiroSessionLogState

  const read = () => readKiroSessionLog(log, { homeDir, platform: 'darwin' })
  const append = (lines: string[]) =>
    appendFileSync(logPath, lines.map((line) => `${line}\n`).join(''))

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kiro-session-log-'))
    sessionDir = kiroSessionDir(SESSION_ID, CWD, { homeDir, platform: 'darwin' })
    mkdirSync(sessionDir, { recursive: true })
    logPath = join(sessionDir, 'messages.jsonl')
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ schemaVersion: '1.0.0' }))
    log = createKiroSessionLogState(SESSION_ID, CWD)
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('reports nothing before the transcript exists', () => {
    expect(read()).toEqual({ pending: undefined, turnEnd: undefined })
  })

  it('reports an unresolved approval, then clears it once resolved (Allow)', () => {
    const lines = fixtureLines('kiro-transcript-approval-resolved.jsonl')
    const pendingAt = indexOfType(lines, 'pending_interaction')
    append(lines.slice(0, pendingAt + 1))
    expect(read().pending).toMatchObject({
      interactionType: 'tool_approval',
      question: 'touch /tmp/kiro-s0-scratch/approve/a.txt',
      options: [
        { optionId: 'accept', name: 'Allow' },
        { optionId: 'always-accept', name: 'Always allow' },
        { optionId: 'reject', name: 'Deny' },
        { optionId: 'always-reject', name: 'Always deny' }
      ]
    })
    const resolvedAt = indexOfType(lines, 'interaction_resolved')
    append(lines.slice(pendingAt + 1, resolvedAt + 1))
    expect(read()).toEqual({ pending: undefined, turnEnd: undefined })
    append(lines.slice(resolvedAt + 1))
    expect(read().turnEnd).toMatchObject({ stopReason: 'end_turn' })
  })

  it('reads a Deny turn as end_turn and a Ctrl+C in the dialog as cancelled', () => {
    const lines = fixtureLines('kiro-transcript-approval-denied-and-dialog-cancelled.jsonl')
    const firstEnd = indexOfType(lines, 'turn_end')
    append(lines.slice(0, firstEnd + 1))
    expect(read()).toMatchObject({ pending: undefined, turnEnd: { stopReason: 'end_turn' } })
    const secondPending = indexOfType(lines, 'pending_interaction', firstEnd)
    append(lines.slice(firstEnd + 1, secondPending + 1))
    // The next turn_start drops the previous turn's end.
    expect(read()).toMatchObject({ turnEnd: undefined, pending: { question: expect.any(String) } })
    append(lines.slice(secondPending + 1))
    expect(read()).toMatchObject({ pending: undefined, turnEnd: { stopReason: 'cancelled' } })
  })

  it('reads a Ctrl+C mid-turn as a cancelled turn', () => {
    append(fixtureLines('kiro-transcript-cancelled-turn.jsonl'))
    expect(read().turnEnd).toMatchObject({ stopReason: 'cancelled' })
  })

  it('drops an approval left pending by a killed process once a new turn starts', () => {
    const lines = fixtureLines('kiro-transcript-approval-pending-killed.jsonl')
    append(lines.slice(0, indexOfType(lines, 'pending_interaction') + 1))
    expect(read().pending).toBeDefined()
    append([
      JSON.stringify({ payload: { type: 'turn_start', executionId: 'next-turn' } }),
      JSON.stringify({ payload: { type: 'user', content: 'x' } })
    ])
    expect(read()).toEqual({ pending: undefined, turnEnd: undefined })
  })

  it('skips malformed lines and keeps a partial trailing line for the next read', () => {
    const pending = JSON.stringify({
      payload: {
        type: 'pending_interaction',
        interactionType: 'tool_approval',
        toolCallId: 't1',
        question: 'q',
        options: []
      }
    })
    append(['{"payload":{"type":"turn_start" not json'])
    appendFileSync(logPath, pending.slice(0, 20))
    expect(read().pending).toBeUndefined()
    appendFileSync(logPath, `${pending.slice(20)}\n`)
    expect(read().pending).toMatchObject({ toolCallId: 't1' })
  })

  it('re-reads from the start when the transcript shrinks', () => {
    append(fixtureLines('kiro-transcript-cancelled-turn.jsonl'))
    expect(read().turnEnd).toBeDefined()
    writeFileSync(
      logPath,
      `${JSON.stringify({ payload: { type: 'turn_start', executionId: 'e2' } })}\n`
    )
    expect(read().turnEnd).toBeUndefined()
  })

  it('fails soft on an unknown schemaVersion', () => {
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ schemaVersion: '2.0.0' }))
    append(fixtureLines('kiro-transcript-cancelled-turn.jsonl'))
    expect(read()).toEqual({})
    expect(log.cursor.offset).toBe(0)
  })

  it('reads before session.json exists and checks the schema once it appears', () => {
    rmSync(join(sessionDir, 'session.json'))
    append(fixtureLines('kiro-transcript-cancelled-turn.jsonl'))
    expect(read().turnEnd).toBeDefined()
    expect(log.schemaOk).toBeUndefined()
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ schemaVersion: '1.2.0' }))
    read()
    expect(log.schemaOk).toBe(true)
  })

  it('a new session id starts a fresh cursor', () => {
    append(fixtureLines('kiro-transcript-cancelled-turn.jsonl'))
    read()
    const next = createKiroSessionLogState('sess_test-2', CWD)
    expect(next.cursor.offset).toBe(0)
    expect(readKiroSessionLog(next, { homeDir, platform: 'darwin' })).toEqual({
      pending: undefined,
      turnEnd: undefined
    })
  })
})
