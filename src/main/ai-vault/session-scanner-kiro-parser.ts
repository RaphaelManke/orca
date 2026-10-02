import { createInterface } from 'node:readline'
import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  accumulatorFoldResumeState,
  addPreviewMessage,
  createAccumulator,
  updateTimeline
} from './session-scanner-accumulator'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import {
  applyKiroSessionMetadata,
  mergeKiroSessionMetadata,
  readKiroSessionMetadata,
  readLocalKiroSessionMetadata
} from './session-scanner-kiro-metadata'
import { kiroSessionIdFromMessagesPath } from './session-scanner-kiro-paths'
import {
  asRecord,
  extractContentText,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

function kiroRecordText(content: unknown): string | null {
  return typeof content === 'string' ? content : extractContentText(content)
}

// Kiro injects steering and session context as `user` records tagged with this reason.
function isInjectedKiroUserRecord(payload: Record<string, unknown>, text: string | null): boolean {
  const kiroMeta = asRecord(asRecord(payload._meta)?.kiro)
  return (
    extractString(kiroMeta?.syntheticUserMessageReason) !== null ||
    (text !== null && isKnownHarnessInjectedUserTurnText(text))
  )
}

/**
 * Folds messages.jsonl only. session.json (title, cwd, model, target) is merged on top by
 * the caller, so a rename re-merges without re-reading the transcript.
 */
export function consumeKiroSessionLine(accumulator: SessionAccumulator, line: string): void {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  if (!record || !payload) {
    return
  }
  updateTimeline(accumulator, record.timestamp)
  const type = extractString(payload.type) ?? extractString(payload.kind)
  if (type === 'user') {
    const text = kiroRecordText(payload.content)
    if (!text?.trim() || isInjectedKiroUserRecord(payload, text)) {
      return
    }
    accumulator.messageCount++
    addPreviewMessage(accumulator, {
      role: 'user',
      text,
      timestamp: record.timestamp,
      seedFirstUserPrompt: true
    })
    accumulator.fallbackTitle ??= normalizeTitleText(text)
    return
  }
  // Only `Say` is the reply; `Reasoning` is thinking and `Summary` is a compaction digest.
  const operationType = extractString(payload.operationType)
  if (type === 'assistant' && (operationType === null || operationType === 'Say')) {
    const text = kiroRecordText(payload.content)
    if (!text?.trim()) {
      return
    }
    accumulator.messageCount++
    addPreviewMessage(accumulator, { role: 'assistant', text, timestamp: record.timestamp })
  }
}

export function createKiroSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return accumulatorFoldResumeState(
    createAccumulator({
      agent: 'kiro',
      file,
      // The session dir name is the `sess_` id `--resume-id` takes (and session.json's `id`).
      sessionId: kiroSessionIdFromMessagesPath(file.path),
      messages
    }),
    consumeKiroSessionLine
  )
}

/**
 * The local list/index fold. Why session.json is merged into the fold here: the search index
 * commits the fold itself, and without the workspace cwd (and the cloud hide) Kiro hits drop
 * out of a workspace-scoped search. The parse cache still re-merges it on a rename.
 */
export function createLocalKiroSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return withLocalKiroMetadata(createKiroSessionResumeState(file, messages), file.path)
}

function withLocalKiroMetadata(
  state: ResumableSessionParseState,
  messagesPath: string
): ResumableSessionParseState {
  let invalidMetadata = false
  return {
    ...state,
    clone: () => withLocalKiroMetadata(state.clone(), messagesPath),
    excludedFromSearchIndex: () => invalidMetadata,
    finalize: async (platform, options) => {
      invalidMetadata = false
      const session = await state.finalize(platform, options)
      if (!session) {
        return null
      }
      let read
      try {
        read = await readLocalKiroSessionMetadata(messagesPath)
      } catch (error) {
        if (error instanceof WslTranscriptFsError) {
          // Sidecar enrichment reports the refusal and retries it next scan.
          return session
        }
        throw error
      }
      if (read.kind === 'hidden') {
        return null
      }
      if (read.kind !== 'listed') {
        // Invalid stays unmerged so the sidecar step hides and reports it, and a later fix
        // re-lists; search drops it, since it would match only the All scope with no cwd.
        invalidMetadata = true
        return session
      }
      return mergeKiroSessionMetadata(session, read.metadata, platform)
    }
  }
}

async function foldKiroSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createKiroSessionResumeState(args.file, args.messages)
  for await (const line of args.lines) {
    state.consumeLine(line)
  }
  return state.finalize(args.platform, args.options)
}

/** One-shot local parse, metadata merged; the list's cached path merges via sidecar enrichment. */
export async function parseKiroSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const metadata = await readLocalKiroSessionMetadata(file.path)
  if (metadata.kind !== 'listed') {
    return null
  }
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })
  const session = await foldKiroSessionLines({ file, lines, platform, messages })
  return applyKiroSessionMetadata(session, metadata, platform)
}

/** Remote parse: the caller reads session.json beside the transcript on the execution host. */
export async function parseKiroSessionContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  metadataContent: string | null,
  platform: NodeJS.Platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const metadata = readKiroSessionMetadata(metadataContent)
  if (metadata.kind !== 'listed') {
    return null
  }
  const session = await foldKiroSessionLines({
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options
  })
  return applyKiroSessionMetadata(session, metadata, platform)
}
