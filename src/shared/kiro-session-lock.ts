import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { kiroSessionDir } from './kiro-session-log'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'

/** `live` is the only verdict that blocks a resume; unknown is never treated as dead. */
export type KiroSessionLockVerdict = 'live' | 'stale' | 'absent' | 'unverifiable'

const LOCK_MAX_BYTES = 4096
const SESSION_SCAN_MAX_ENTRIES = 4096
const NON_WORKSPACE_DIRS: ReadonlySet<string> = new Set(['_global', 'cli'])

/** The `--resume-id` value in a launch command, or null. Stops at `--`. */
export function parseKiroResumeId(command: string): string | null {
  const tokens = tokenizeCommandLine(command)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      return null
    }
    if (token === '--resume-id') {
      const next = tokens[i + 1]
      return next && !next.startsWith('-') ? next : null
    }
    if (token.startsWith('--resume-id=')) {
      return token.slice('--resume-id='.length) || null
    }
  }
  return null
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: EPERM means the pid exists under another user — still a live holder.
    return errorCode(error) === 'EPERM'
  }
}

function realpathOr(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

// Why: a cwd reached through a symlink (macOS /tmp) or since renamed hashes elsewhere.
function scanForSessionDir(sessionsRoot: string, sessionId: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(sessionsRoot).slice(0, SESSION_SCAN_MAX_ENTRIES)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (NON_WORKSPACE_DIRS.has(entry)) {
      continue
    }
    const candidate = join(sessionsRoot, entry, sessionId)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function readKiroSessionLockVerdict(args: {
  sessionId: string
  /** Unknown cwd falls straight through to the sessions/ scan. */
  cwd: string | undefined
  homeDir?: string
  platform?: NodeJS.Platform
  isPidAlive?: (pid: number) => boolean
}): KiroSessionLockVerdict {
  const homeDir = args.homeDir ?? homedir()
  const options = { homeDir, platform: args.platform }
  let sessionDir: string | null = null
  const cwds = args.cwd ? new Set([realpathOr(args.cwd), args.cwd]) : new Set<string>()
  for (const cwd of cwds) {
    const dir = kiroSessionDir(args.sessionId, cwd, options)
    if (existsSync(dir)) {
      sessionDir = dir
      break
    }
  }
  sessionDir ??= scanForSessionDir(join(homeDir, '.kiro', 'sessions'), args.sessionId)
  if (!sessionDir) {
    return 'absent'
  }
  const lockPath = join(sessionDir, '.lock')
  try {
    if (statSync(lockPath).size > LOCK_MAX_BYTES) {
      return 'unverifiable'
    }
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    const pid =
      typeof parsed === 'object' && parsed !== null && 'pid' in parsed ? parsed.pid : undefined
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return 'unverifiable'
    }
    return (args.isPidAlive ?? isPidAlive)(pid) ? 'live' : 'stale'
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unverifiable'
  }
}
