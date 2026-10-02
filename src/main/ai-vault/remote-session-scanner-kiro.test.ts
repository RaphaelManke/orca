import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'
import {
  KIRO_FIXTURE_PROMPT,
  kiroFixtureMetadata,
  kiroFixtureRecords
} from './session-scanner-kiro-fixtures'

const BUCKET = '/home/ada/.kiro/sessions/0123456789abcdef'

function addSession(
  provider: MemoryRemoteProvider,
  id: string,
  metadata: Record<string, unknown> | null,
  mtime: number
): void {
  if (metadata) {
    provider.addFile(`${BUCKET}/${id}/session.json`, JSON.stringify(metadata), mtime)
  }
  provider.addFile(`${BUCKET}/${id}/messages.jsonl`, jsonLines(kiroFixtureRecords()), mtime)
}

describe('scanRemoteAiVaultSessions kiro', () => {
  it('lists remote Kiro sessions with session.json metadata and hides the rest', async () => {
    const provider = new MemoryRemoteProvider()
    addSession(
      provider,
      'sess_remote',
      kiroFixtureMetadata({
        id: 'sess_remote',
        title: 'Remote Kiro',
        workspacePaths: ['/home/ada/repo'],
        modelId: 'kiro-model'
      }),
      40
    )
    addSession(
      provider,
      'sess_cloud',
      kiroFixtureMetadata({
        id: 'sess_cloud',
        workspacePaths: ['/home/ada/repo'],
        _meta: { kiro: { executionTarget: { kind: 'sandbox' } } }
      }),
      41
    )
    addSession(provider, 'sess_no_metadata', null, 42)
    // Prompt history beside the buckets is not a session store.
    provider.addFile('/home/ada/.kiro/sessions/cli/history.jsonl', jsonLines([{}]), 43)

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'ssh:dev-box',
      agent: 'kiro',
      sessionId: 'sess_remote',
      title: 'Remote Kiro',
      cwd: '/home/ada/repo',
      model: 'kiro-model',
      messageCount: 2,
      resumeCommand: "cd '/home/ada/repo' && kiro-cli chat --tui --v3 --resume-id 'sess_remote'"
    })
    expect(result.sessions[0]?.previewMessages[0]?.text).toBe(KIRO_FIXTURE_PROMPT)
  })
})
