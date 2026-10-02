import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { kiroSessionDir } from './kiro-session-log'
import { isPidAlive, parseKiroResumeId, readKiroSessionLockVerdict } from './kiro-session-lock'

const SID = 'sess_fb23f185-e144-4fdb-b729-bd5f8da28feb'

describe('parseKiroResumeId', () => {
  it.each([
    [`kiro-cli chat --tui --v3 '--trust-all-tools' '--resume-id' '${SID}'`, SID],
    [`kiro-cli chat --tui --v3 "--resume-id" "${SID}"`, SID],
    [`kiro-cli chat --tui --v3 --resume-id=${SID}`, SID],
    ['kiro-cli chat --tui --v3', null],
    [`kiro-cli chat --tui --v3 -- --resume-id ${SID}`, null],
    ['kiro-cli chat --tui --v3 --resume-id --other', null]
  ])('parses %s', (command, expected) => {
    expect(parseKiroResumeId(command)).toBe(expected)
  })
})

describe('readKiroSessionLockVerdict', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kiro-lock-home-'))
    cwd = mkdtempSync(join(tmpdir(), 'kiro-lock-cwd-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  function writeLock(dir: string, body: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.lock'), body)
  }

  const read = (alive: boolean, cwdArg: string | undefined = cwd) =>
    readKiroSessionLockVerdict({
      sessionId: SID,
      cwd: cwdArg,
      homeDir: home,
      isPidAlive: () => alive
    })

  it('is absent with no session dir and with no lock', () => {
    expect(read(true)).toBe('absent')
    mkdirSync(kiroSessionDir(SID, cwd, { homeDir: home }), { recursive: true })
    expect(read(true)).toBe('absent')
  })

  it('is live or stale by the holder pid', () => {
    writeLock(kiroSessionDir(SID, cwd, { homeDir: home }), '{"pid":4242,"started_at":"x"}')
    expect(read(true)).toBe('live')
    expect(read(false)).toBe('stale')
  })

  it('is unverifiable for a garbage or pid-less lock, never live', () => {
    const dir = kiroSessionDir(SID, cwd, { homeDir: home })
    writeLock(dir, 'not json')
    expect(read(true)).toBe('unverifiable')
    writeLock(dir, '{"pid":"12"}')
    expect(read(true)).toBe('unverifiable')
  })

  it('finds the session through a symlinked cwd', () => {
    const link = join(tmpdir(), `kiro-lock-link-${process.pid}-${Date.now()}`)
    symlinkSync(cwd, link)
    try {
      writeLock(kiroSessionDir(SID, cwd, { homeDir: home }), '{"pid":1}')
      expect(read(true, link)).toBe('live')
    } finally {
      rmSync(link, { force: true })
    }
  })

  it('falls back to scanning sessions/ for a moved or unknown cwd', () => {
    writeLock(join(home, '.kiro', 'sessions', '0123456789abcdef', SID), '{"pid":1}')
    expect(read(true, join(cwd, 'elsewhere'))).toBe('live')
    expect(read(true, undefined)).toBe('live')
  })

  it('skips the non-workspace dirs while scanning', () => {
    writeLock(join(home, '.kiro', 'sessions', '_global', SID), '{"pid":1}')
    expect(read(true, undefined)).toBe('absent')
  })
})

describe('isPidAlive', () => {
  it('sees this process and not a free pid', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false)
  })
})
