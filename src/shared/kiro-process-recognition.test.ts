import { describe, expect, it } from 'vitest'
import {
  isExpectedAgentProcess,
  isRecognizedAgentType,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

const KIRO = { agent: 'kiro', processName: 'kiro-cli' }

describe('Kiro process recognition', () => {
  it('recognizes the kiro-cli leader and the kiro-cli-chat child', () => {
    expect(recognizeAgentProcessFromCommandLine('kiro-cli chat --tui --v3')).toEqual(KIRO)
    expect(
      recognizeAgentProcessFromCommandLine('/home/user/.local/bin/kiro-cli-chat chat --tui --v3')
    ).toEqual({ agent: 'kiro', processName: 'kiro-cli-chat' })
    expect(recognizeAgentProcess('kiro-cli-chat')?.agent).toBe('kiro')
    expect(recognizeAgentProcess('C:\\Users\\user\\bin\\kiro-cli-chat.exe')?.agent).toBe('kiro')
    expect(isRecognizedAgentType('kiro-cli-chat')).toBe(true)
  })

  it.each([
    '/home/user/.local/share/kiro-cli/bun --no-env-file /home/user/.local/share/kiro-cli/tui.js chat --tui --v3',
    'bun /opt/kiro-cli/tui.js chat --tui --v3',
    'C:\\Users\\user\\AppData\\Local\\kiro-cli\\bun.exe --no-env-file C:\\Users\\user\\AppData\\Local\\kiro-cli\\tui.js chat --tui --v3',
    '"/Users/user/Library/Application Support/kiro-cli/bun" --no-env-file "/Users/user/Library/Application Support/kiro-cli/tui.js" chat --tui --v3'
  ])('recognizes the bun TUI leaf: %s', (commandLine) => {
    expect(recognizeAgentProcessFromCommandLine(commandLine)).toEqual(KIRO)
  })

  it.each([
    'kiro',
    'kiro chat --tui',
    'bun run kiro',
    'bun /home/user/project/tui.js',
    'bun /home/user/kiro/tui.js',
    'node /home/user/.local/share/kiro-cli-extras/tui.js',
    'claude "compare kiro-cli with orca"',
    'echo kiro-cli chat --tui --v3'
  ])('does not recognize %s as Kiro', (commandLine) => {
    expect(recognizeAgentProcessFromCommandLine(commandLine)?.agent).not.toBe('kiro')
  })

  it('treats one-shot Kiro invocations as non-interactive panes', () => {
    expect(
      recognizeAgentProcessFromCommandLine('kiro-cli chat --no-interactive "summarize"')
    ).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('kiro-cli acp')).toBeNull()
    expect(
      recognizeAgentProcessFromCommandLine('kiro-cli chat --list-sessions', {
        includeHeadlessOneShot: true
      })
    ).toEqual(KIRO)
  })

  it('matches kiro-cli-chat against the configured expected process', () => {
    expect(TUI_AGENT_CONFIG.kiro.expectedProcess).toBe('kiro-cli')
    expect(isExpectedAgentProcess('kiro-cli', 'kiro-cli')).toBe(true)
    expect(isExpectedAgentProcess('kiro-cli-chat', 'kiro-cli')).toBe(true)
    expect(isExpectedAgentProcess('kiro', 'kiro-cli')).toBe(false)
    expect(isExpectedAgentProcess('kiro-cli-chat', 'claude')).toBe(false)
  })
})
