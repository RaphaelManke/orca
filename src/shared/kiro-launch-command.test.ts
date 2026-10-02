import { describe, expect, it } from 'vitest'
import { isHeadlessOneShotAgentCommand } from './agent-headless-command'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'
import { isKiroNonInteractiveCommand } from './kiro-launch-command'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildAgentStartupPlan } from './tui-agent-startup'
import type { TuiAgent } from './tui-agent'

function launch(
  overrides: {
    cmdOverride?: string
    agentArgs?: string
    shell?: 'posix' | 'powershell' | 'cmd'
    platform?: NodeJS.Platform
  } = {}
): string {
  const cmdOverrides: Partial<Record<TuiAgent, string>> = overrides.cmdOverride
    ? { kiro: overrides.cmdOverride }
    : {}
  const result = resolveAgentLaunchCommand({
    agent: 'kiro',
    cmdOverrides,
    platform: overrides.platform ?? 'darwin',
    shell: overrides.shell ?? 'posix',
    agentArgs: overrides.agentArgs ?? null
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.command
}

function countV3(command: string): number {
  return command.split(/\s+/).filter((token) => token.replace(/'/g, '') === '--v3').length
}

describe('Kiro engine flag normalization', () => {
  it('launches the default command with --v3 exactly once', () => {
    expect(launch()).toBe('kiro-cli chat --tui --v3')
  })

  it('appends --v3 to a custom command without an engine flag', () => {
    expect(launch({ cmdOverride: '/opt/kiro/bin/kiro-cli chat --tui' })).toBe(
      '/opt/kiro/bin/kiro-cli chat --tui --v3'
    )
    expect(launch({ cmdOverride: 'kiro-cli' })).toBe('kiro-cli --v3')
  })

  it.each([
    'kiro-cli chat --tui --v3',
    'kiro-cli chat --tui --v2',
    'kiro-cli chat --tui --agent-engine v3',
    'kiro-cli chat --tui --agent-engine=v2'
  ])('leaves a custom command that already picks an engine alone: %s', (cmdOverride) => {
    expect(launch({ cmdOverride })).toBe(cmdOverride)
  })

  it('drops the default --v3 when default args pick the engine', () => {
    expect(launch({ agentArgs: '--agent-engine v2' })).toBe(
      "kiro-cli chat --tui '--agent-engine' 'v2'"
    )
    expect(countV3(launch({ agentArgs: '--v3 --trust-all-tools' }))).toBe(1)
  })

  it('does not read an engine flag after -- as a flag', () => {
    expect(countV3(launch({ agentArgs: '-- --v2' }))).toBe(1)
  })

  it('keeps --v3 once under Windows shells', () => {
    for (const shell of ['powershell', 'cmd'] as const) {
      const command = launch({ shell, platform: 'win32', agentArgs: '--trust-all-tools' })
      expect(command.startsWith('kiro-cli chat --tui --v3 ')).toBe(true)
      expect(command).toContain('--trust-all-tools')
    }
  })

  it('carries --v3 into startup plans and the stored relaunch command', () => {
    const startup = buildAgentStartupPlan({
      agent: 'kiro',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })
    expect(startup?.launchCommand.startsWith('kiro-cli chat --tui --v3')).toBe(true)
    expect(startup?.launchConfig?.agentCommand).toBe('kiro-cli chat --tui --v3')
  })
})

describe('Kiro non-interactive commands', () => {
  it.each([
    'kiro-cli chat --no-interactive "hello"',
    'kiro-cli chat --tui --v3 --no-interactive hello',
    'kiro-cli chat --output-format json hi',
    'kiro-cli chat --list-sessions',
    'kiro-cli chat --list-models',
    'kiro-cli chat --delete-session sess_1',
    'kiro-cli chat --sessions',
    'kiro-cli acp'
  ])('treats %s as non-interactive', (commandLine) => {
    expect(isKiroNonInteractiveCommand(tokenizeCommandLine(commandLine))).toBe(true)
    expect(isHeadlessOneShotAgentCommand('kiro', tokenizeCommandLine(commandLine))).toBe(true)
  })

  it.each([
    'kiro-cli chat --tui --v3',
    'kiro-cli chat --tui --v3 --resume-id sess_1',
    'kiro-cli chat --tui -- --no-interactive',
    'kiro-cli-chat chat --tui --v3',
    '/home/user/.local/share/kiro-cli/bun --no-env-file /home/user/.local/share/kiro-cli/tui.js chat --tui --v3',
    'kiro-cli chat "explain acp"'
  ])('keeps %s interactive', (commandLine) => {
    expect(isKiroNonInteractiveCommand(tokenizeCommandLine(commandLine))).toBe(false)
  })
})
