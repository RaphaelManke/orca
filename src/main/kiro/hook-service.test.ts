import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KiroCliVersionStatus } from '../../shared/kiro-cli-version'

const versionMock = vi.hoisted(() => {
  const status: KiroCliVersionStatus = { verdict: 'unknown', version: null }
  return { status }
})

vi.mock('./kiro-cli-version-probe', () => ({
  peekKiroCliVersionStatus: () => versionMock.status,
  readKiroCliVersionStatus: () => Promise.resolve(versionMock.status)
}))

import {
  getKiroManagedCommand,
  getKiroManagedScript,
  getKiroRemoteManagedCommand,
  KiroHookService
} from './hook-service'
import { KIRO_HOOK_EVENTS } from './kiro-hook-config-json'

// Why: homedir() follows HOME/USERPROFILE, so the install cycle never touches the real ~/.kiro or ~/.orca.
let home: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kiro-hook-'))
  for (const key of ['HOME', 'USERPROFILE']) {
    saved[key] = process.env[key]
    process.env[key] = home
  }
  versionMock.status = { verdict: 'unknown', version: null }
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.kiro', 'hooks', 'orca-status.json')
const posixOnly = process.platform === 'win32' ? it.skip : it

function triggers(): string[] {
  const parsed: { hooks: { trigger: string }[] } = JSON.parse(readFileSync(configPath(), 'utf-8'))
  return parsed.hooks.map((hook) => hook.trigger)
}

describe('KiroHookService', () => {
  it('installs every V3 event into the dedicated file', () => {
    const service = new KiroHookService()
    expect(service.getStatus().state).toBe('not_installed')
    expect(service.install().state).toBe('installed')
    expect(triggers()).toEqual([...KIRO_HOOK_EVENTS])
    expect(service.remove().state).toBe('not_installed')
  })

  it('migrates an older managed AgentSpawn entry to SessionStart', () => {
    mkdirSync(join(home, '.kiro', 'hooks'), { recursive: true })
    const legacy = (trigger: string) => ({
      name: `orca-status-${trigger}`,
      trigger,
      action: { type: 'command', command: `/bin/sh '${home}/.orca/agent-hooks/kiro-hook.sh'` }
    })
    writeFileSync(
      configPath(),
      JSON.stringify({
        version: 'v1',
        hooks: ['AgentSpawn', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map(legacy)
      })
    )
    const service = new KiroHookService()
    const before = service.getStatus()
    expect(before.state).toBe('partial')
    expect(before.detail).toContain('SessionStart, SessionEnd')

    expect(service.install().state).toBe('installed')
    expect(triggers()).not.toContain('AgentSpawn')
    expect(triggers()).toEqual([...KIRO_HOOK_EVENTS])
  })

  it('never reports installed for a kiro-cli older than 2.13 (D11)', () => {
    const service = new KiroHookService()
    service.install()
    versionMock.status = { verdict: 'too-old', version: '2.12.0' }
    const status = service.getStatus()
    expect(status.state).toBe('not_installed')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain('2.12.0')
    expect(status.detail).toContain('2.13')
  })

  it('uses a cmd-valid command and .cmd script on Windows, POSIX for remote', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const path = 'C:\\Users\\u\\.orca\\agent-hooks\\kiro-hook.cmd'
    expect(getKiroManagedCommand(path)).toBe(path)
    expect(getKiroManagedCommand(path)).not.toContain('/bin/sh')
    const script = getKiroManagedScript()
    expect(script.startsWith('@echo off\r\n')).toBe(true)
    expect(script).toContain('/hook/kiro')
    expect(script).toContain('--max-time 1.5')
    expect(getKiroManagedScript('posix').startsWith('#!/bin/sh\n')).toBe(true)
    expect(getKiroRemoteManagedCommand('/home/u/.orca/agent-hooks/kiro-hook.sh')).toContain(
      "/bin/sh '/home/u/.orca/agent-hooks/kiro-hook.sh'"
    )
  })

  posixOnly('exits 0 without disk or network work outside an Orca pane', () => {
    const scriptPath = join(home, 'kiro-hook.sh')
    writeFileSync(scriptPath, getKiroManagedScript('posix'), { mode: 0o755 })
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }
    const result = spawnSync('/bin/sh', [scriptPath], {
      env,
      input: '{"hook_event_name":"Stop","session_id":"sess_x"}',
      encoding: 'utf-8'
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(existsSync(join(home, '.orca'))).toBe(false)
  })
})
