import { AsyncLocalStorage } from 'node:async_hooks'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { timestampIso } from './session-scanner-accumulator'
import { kiroSessionMetadataPath } from './session-scanner-kiro-paths'
import { arrayValue, asRecord, extractString, normalizeTitleText } from './session-scanner-values'

const KIRO_DEFAULT_SESSION_TITLE = 'New Session'
const KIRO_SUPPORTED_SCHEMA_MAJOR = '1.'

export type KiroSessionMetadata = {
  title: string | null
  cwd: string | null
  model: string | null
  createdAt: string | null
}

export type KiroSessionMetadataRead =
  | { kind: 'listed'; metadata: KiroSessionMetadata }
  /** A cloud-sandbox session: it cannot resume in a local pane (R7.5). */
  | { kind: 'hidden' }
  /** Unreadable or an unknown schema; hidden and reported rather than guessed at (R7.6). */
  | { kind: 'invalid'; message: string }

export function readKiroSessionMetadata(content: string | null): KiroSessionMetadataRead {
  if (content === null) {
    return { kind: 'invalid', message: 'Kiro session.json is missing.' }
  }
  let record: Record<string, unknown> | null
  try {
    const parsed: unknown = JSON.parse(content)
    record = asRecord(parsed)
  } catch {
    record = null
  }
  if (!record) {
    return { kind: 'invalid', message: 'Kiro session.json is not a JSON object.' }
  }
  const schemaVersion = extractString(record.schemaVersion)
  if (!schemaVersion?.startsWith(KIRO_SUPPORTED_SCHEMA_MAJOR)) {
    return {
      kind: 'invalid',
      message: `Unsupported Kiro session schema ${JSON.stringify(record.schemaVersion ?? null)}.`
    }
  }
  const targetKind = extractString(
    asRecord(asRecord(asRecord(record._meta)?.kiro)?.executionTarget)?.kind
  )
  if (targetKind && targetKind !== 'local') {
    return { kind: 'hidden' }
  }
  const title = normalizeTitleText(extractString(record.title) ?? '')
  return {
    kind: 'listed',
    metadata: {
      title: title && title !== KIRO_DEFAULT_SESSION_TITLE ? title : null,
      // Every observed session has exactly one root; the fold keeps a single cwd.
      cwd: arrayValue(record.workspacePaths).map(extractString).find(Boolean) ?? null,
      model: extractString(record.modelId),
      createdAt: timestampIso(record.createdAt)
    }
  }
}

/** session.json owns identity metadata; the transcript fold owns activity. Pure in (fold, metadata). */
export function mergeKiroSessionMetadata(
  session: AiVaultSession,
  metadata: KiroSessionMetadata,
  platform: NodeJS.Platform
): AiVaultSession {
  const cwd = metadata.cwd ?? session.cwd
  const merged: AiVaultSession = {
    ...session,
    title: metadata.title ?? session.title,
    cwd,
    model: metadata.model ?? session.model,
    createdAt: metadata.createdAt ?? session.createdAt
  }
  if (cwd === session.cwd) {
    return merged
  }
  return {
    ...merged,
    resumeCommand: buildAiVaultResumeCommand({
      agent: merged.agent,
      sessionId: merged.sessionId,
      cwd,
      platform
    })
  }
}

export function applyKiroSessionMetadata(
  session: AiVaultSession | null,
  read: KiroSessionMetadataRead,
  platform: NodeJS.Platform
): AiVaultSession | null {
  return session && read.kind === 'listed'
    ? mergeKiroSessionMetadata(session, read.metadata, platform)
    : null
}

/** Reads the transcript's session.json; a WSL gate refusal propagates. */
export async function readLocalKiroSessionMetadata(
  messagesPath: string
): Promise<KiroSessionMetadataRead> {
  let content: string | null = null
  try {
    content = await wslGatedReadFile(kiroSessionMetadataPath(messagesPath), 'utf-8', 'scan')
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
  }
  return readKiroSessionMetadata(content)
}

type KiroMetadataScan = { issues: Map<string, string> }
const kiroMetadataScan = new AsyncLocalStorage<KiroMetadataScan>()

/** Scopes one vault scan so invalid session.json files surface as scan issues. */
export function withKiroSessionMetadataScan<T>(fn: () => Promise<T>): Promise<T> {
  return kiroMetadataScan.run({ issues: new Map() }, fn)
}

export function recordKiroSessionMetadataIssue(messagesPath: string, message: string): void {
  kiroMetadataScan.getStore()?.issues.set(kiroSessionMetadataPath(messagesPath), message)
}

export function kiroSessionMetadataIssues(): { path: string; message: string }[] {
  const scan = kiroMetadataScan.getStore()
  return scan ? [...scan.issues].map(([path, message]) => ({ path, message })) : []
}
