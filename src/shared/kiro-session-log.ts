import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import {
  readJsonlCursor,
  record,
  type JsonlCursor,
  type JsonRecord
} from './codex-rollout-jsonl-cursor'

export type KiroInteractionOption = { optionId: string; name: string; kind?: string }

export type KiroPendingInteraction = {
  toolCallId: string
  executionId?: string
  interactionType: string
  question: string
  options: KiroInteractionOption[]
}

export type KiroTurnEnd = { executionId?: string; stopReason: string }

export type KiroSessionLogState = {
  sessionId: string
  cwd: string
  cursor: JsonlCursor
  pending: Map<string, KiroPendingInteraction>
  /** Execution of the newest `turn_start`; a pending interaction or turn_end of another one is stale. */
  executionId?: string
  turnEnd?: KiroTurnEnd
  /** undefined until session.json is read; false disables the reader (unknown schema, R7.6). */
  schemaOk?: boolean
}

/** Per-pane listener state for a Kiro V3 pane. */
export type KiroPaneState = {
  log?: KiroSessionLogState
  /** Between PreToolUse and PostToolUse/Stop; the transcript poll runs faster while set. */
  inTool: boolean
}

export type KiroSessionLogRead = {
  pending?: KiroPendingInteraction
  turnEnd?: KiroTurnEnd
}

const MAX_PENDING_INTERACTIONS = 16
const SESSION_JSON_MAX_BYTES = 256 * 1024
const KNOWN_SCHEMA_MAJOR = '1'
// Why: transcripts are dominated by large assistant/tool records; parse only the four kinds we read.
const RECORD_MARKERS = [
  '"pending_interaction"',
  '"interaction_resolved"',
  '"turn_start"',
  '"turn_end"'
]

/** Port of KAS 2.26.1 `_0()`: absolute, `/`-separated, posix-normalized, no trailing `/`, lowercased on win32. */
export function normalizeKiroWorkspaceRoot(cwd: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix
  const slashed = (path.isAbsolute(cwd) ? cwd : path.resolve(cwd)).replace(/\\/g, '/')
  const unc = platform === 'win32' && slashed.startsWith('//')
  let normalized = posix.normalize(slashed)
  if (unc && !normalized.startsWith('//')) {
    normalized = `/${normalized}`
  }
  if (normalized.length > 1) {
    const trimmed = normalized.replace(/\/+$/, '')
    if (trimmed.length > 0 && !/^[A-Za-z]:$/.test(trimmed)) {
      normalized = trimmed
    }
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function kiroCwdHash(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256')
    .update(normalizeKiroWorkspaceRoot(cwd, platform))
    .digest('hex')
    .slice(0, 16)
}

// Why: V3 ignores KIRO_HOME (Stage 0), so the store is always under the real ~/.kiro.
export function kiroSessionDir(
  sessionId: string,
  cwd: string,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {}
): string {
  return join(
    options.homeDir ?? homedir(),
    '.kiro',
    'sessions',
    kiroCwdHash(cwd, options.platform),
    sessionId
  )
}

export function createKiroSessionLogState(sessionId: string, cwd: string): KiroSessionLogState {
  return { sessionId, cwd, cursor: { offset: 0, carry: '' }, pending: new Map() }
}

function readString(value: JsonRecord | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

/** True for a known (or absent) schemaVersion, false for an unknown one, undefined when unreadable yet. */
function readSchemaOk(sessionDir: string): boolean | undefined {
  const path = join(sessionDir, 'session.json')
  try {
    if (statSync(path).size > SESSION_JSON_MAX_BYTES) {
      return false
    }
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const parsed = record(raw)
    if (!parsed) {
      return false
    }
    const version = parsed.schemaVersion
    if (version === undefined) {
      return true
    }
    return typeof version === 'string' && version.split('.')[0] === KNOWN_SCHEMA_MAJOR
  } catch {
    return undefined
  }
}

function readOptions(value: unknown): KiroInteractionOption[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item: unknown) => {
    const option = record(item)
    const optionId = readString(option, 'optionId')
    const name = readString(option, 'name')
    return optionId && name ? [{ optionId, name, kind: readString(option, 'kind') }] : []
  })
}

function applyRecord(log: KiroSessionLogState, line: JsonRecord): void {
  const payload = record(line.payload)
  const type = readString(payload, 'type') ?? ''
  const executionId = readString(payload, 'executionId')
  switch (type) {
    case 'turn_start':
      log.executionId = executionId
      log.turnEnd = undefined
      for (const [id, pending] of log.pending) {
        if (pending.executionId !== executionId) {
          log.pending.delete(id)
        }
      }
      return
    case 'turn_end': {
      const stopReason = readString(payload, 'stopReason')
      if (!stopReason) {
        return
      }
      log.turnEnd = { executionId, stopReason }
      for (const [id, pending] of log.pending) {
        if (!executionId || pending.executionId === executionId) {
          log.pending.delete(id)
        }
      }
      return
    }
    case 'pending_interaction': {
      const toolCallId = readString(payload, 'toolCallId')
      if (!toolCallId) {
        return
      }
      log.pending.delete(toolCallId)
      log.pending.set(toolCallId, {
        toolCallId,
        executionId,
        interactionType: readString(payload, 'interactionType') ?? 'unknown',
        question: readString(payload, 'question') ?? '',
        options: readOptions(payload?.options)
      })
      if (log.pending.size > MAX_PENDING_INTERACTIONS) {
        const oldest = log.pending.keys().next().value
        if (oldest !== undefined) {
          log.pending.delete(oldest)
        }
      }
      return
    }
    case 'interaction_resolved': {
      const toolCallId = readString(payload, 'toolCallId')
      if (toolCallId) {
        log.pending.delete(toolCallId)
      }
      break
    }
    default:
      // Other record kinds (assistant, tool_call, …) carry no wait or cancel state.
      break
  }
}

/** Advances the transcript; returns the newest unresolved interaction and the live turn's end, if any. */
export function readKiroSessionLog(
  log: KiroSessionLogState,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {}
): KiroSessionLogRead {
  if (log.schemaOk === false) {
    return {}
  }
  const sessionDir = kiroSessionDir(log.sessionId, log.cwd, options)
  log.cursor.filePath ??= join(sessionDir, 'messages.jsonl')
  if (log.schemaOk === undefined) {
    // Why: session.json can land after the first hook; until then the record-shape checks guard alone.
    log.schemaOk = readSchemaOk(sessionDir)
    if (log.schemaOk === false) {
      log.pending.clear()
      log.turnEnd = undefined
      return {}
    }
  }
  const lines = readJsonlCursor(log.cursor, (line) =>
    RECORD_MARKERS.some((marker) => line.includes(marker))
  )
  for (const line of lines ?? []) {
    applyRecord(log, line)
  }
  const live = (executionId: string | undefined): boolean =>
    !log.executionId || !executionId || executionId === log.executionId
  const pending = Array.from(log.pending.values()).findLast((entry) => live(entry.executionId))
  const turnEnd = log.turnEnd && live(log.turnEnd.executionId) ? log.turnEnd : undefined
  return { pending, turnEnd }
}
