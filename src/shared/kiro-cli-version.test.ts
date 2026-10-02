import { describe, expect, it } from 'vitest'
import { evaluateKiroCliVersionOutput, parseKiroCliVersion } from './kiro-cli-version'

describe('Kiro CLI version gate', () => {
  it('parses the single-line --version output', () => {
    expect(parseKiroCliVersion('kiro-cli 2.26.1\n')).toBe('2.26.1')
    expect(parseKiroCliVersion('\nkiro-cli 2.13.0-beta.1')).toBe('2.13.0')
    expect(parseKiroCliVersion('q 1.2.3')).toBeNull()
    expect(parseKiroCliVersion('version kiro-cli 2.26.1')).toBeNull()
  })

  it.each([
    ['kiro-cli 2.26.1', 'supported'],
    ['kiro-cli 2.13.0', 'supported'],
    ['kiro-cli 3.0.0', 'supported'],
    ['kiro-cli 2.12.9', 'too-old'],
    ['kiro-cli 2.8.0', 'too-old'],
    ['kiro-cli 1.99.99', 'too-old'],
    ['', 'unknown'],
    ['error: unexpected argument', 'unknown']
  ] as const)('%s → %s', (output, verdict) => {
    expect(evaluateKiroCliVersionOutput(output).verdict).toBe(verdict)
  })
})
