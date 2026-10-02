import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { jsonlBody } from './session-scanner-vault-roots'

// Synthetic records in the shapes of the scrubbed kiro-cli 2.26.1 captures
// (.kiro/specs/kiro-cli-v3/fixtures/kiro-transcript-*.jsonl); no real session content.

export const KIRO_FIXTURE_PROMPT = 'Kiro title prompt zephyrquartz'
export const KIRO_FIXTURE_REPLY = 'Done.'

function record(id: string, second: number, payload: Record<string, unknown>): unknown {
  return { id, timestamp: `2026-05-01T10:10:0${second}.000Z`, payload }
}

export function kiroFixtureRecords(options: { prompt?: string } = {}): unknown[] {
  return [
    record('ctx-1', 0, {
      type: 'agent_note',
      content: '<session_context>\nThe current model is Auto.\n</session_context>'
    }),
    record('start-1', 0, { type: 'session_start', content: 'system prompt', forcedRole: 'system' }),
    record('user-1', 1, {
      type: 'user',
      content: options.prompt ?? KIRO_FIXTURE_PROMPT,
      documents: [],
      images: [],
      _meta: { kiro: { userMessageTag: 'prompt_1' } }
    }),
    record('exec-1-turn-start', 1, { type: 'turn_start', executionId: 'exec-1' }),
    record('steer-1', 1, { type: 'steering_inclusion', documents: ['file:///steering.md'] }),
    record('user-injected', 1, {
      type: 'user',
      content: '<steering>Always answer briefly.</steering>',
      _meta: { kiro: { syntheticUserMessageReason: 'steering-injection' } }
    }),
    record('reason-1', 2, {
      type: 'assistant',
      content: 'Thinking about the request.',
      operationType: 'Reasoning',
      _meta: { kiro: { agentMode: 'vibe' } }
    }),
    record('say-1', 2, {
      type: 'assistant',
      content: KIRO_FIXTURE_REPLY,
      operationType: 'Say',
      _meta: { kiro: { agentMode: 'vibe' } }
    }),
    record('usage-1', 3, { type: 'usage_summary', credits: 0.01 }),
    record('summary-1', 3, {
      type: 'assistant',
      content: 'Conversation summary for compaction.',
      operationType: 'Summary'
    }),
    record('exec-1-turn-end', 3, {
      type: 'turn_end',
      executionId: 'exec-1',
      stopReason: 'end_turn'
    })
  ]
}

export function kiroFixtureMetadata(
  overrides: Record<string, unknown> & { id: string; workspacePaths: string[] }
): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    dataModelVersion: 1,
    title: 'New Session',
    createdAt: '2026-05-01T10:09:59.000Z',
    lastModifiedAt: '2026-05-01T10:10:03.000Z',
    agentMode: 'vibe',
    ...overrides
  }
}

/** Writes one Kiro session dir; `metadata: null` writes no session.json, a string writes it raw. */
export async function writeKiroFixtureSession(args: {
  sessionsDir: string
  bucket: string
  id: string
  metadata: Record<string, unknown> | string | null
  records?: unknown[]
}): Promise<string> {
  const sessionDir = join(args.sessionsDir, args.bucket, args.id)
  await mkdir(sessionDir, { recursive: true })
  if (args.metadata !== null) {
    await writeFile(
      join(sessionDir, 'session.json'),
      typeof args.metadata === 'string' ? args.metadata : JSON.stringify(args.metadata)
    )
  }
  const messagesPath = join(sessionDir, 'messages.jsonl')
  await writeFile(messagesPath, jsonlBody(args.records ?? kiroFixtureRecords()))
  return messagesPath
}
