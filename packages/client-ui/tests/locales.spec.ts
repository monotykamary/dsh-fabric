import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import { actionLabel, activityKindLabel, formatDuration, kindLabel, statusLabel } from '../src/client/labels.ts'
import { en, zh } from '../src/client/locales.ts'

function translator(bundle: typeof en): TranslateNS<'fabric'> {
  return ((key: keyof typeof en, params?: Record<string, unknown>) => {
    let value = bundle[key]
    for (const [name, replacement] of Object.entries(params ?? {})) {
      value = value.replaceAll(`{${name}}`, String(replacement))
    }
    return value
  }) as TranslateNS<'fabric'>
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1] ?? '').toSorted()
}

describe('Fabric client locales', () => {
  it('keeps English and Chinese dictionaries key- and template-balanced', () => {
    expect(Object.keys(en).toSorted()).toEqual(Object.keys(zh).toSorted())
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(en[key].trim(), key).not.toBe('')
      expect(zh[key].trim(), key).not.toBe('')
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
    }
  })

  it('renders shared labels in the active language', () => {
    const english = translator(en)
    const chinese = translator(zh)
    expect(statusLabel('running', english)).toBe('Running')
    expect(kindLabel('compaction', english)).toBe('Context compaction')
    expect(activityKindLabel('workflow', chinese)).toBe('工作流')
    expect(actionLabel('started', chinese)).toBe('已开始')
    expect(actionLabel('running', chinese)).toBe('运行中')
    expect(actionLabel('blocked', chinese)).toBe('已阻塞')
    expect(actionLabel('idle', chinese)).toBe('非活动')
    expect(actionLabel('error', chinese)).toBe('错误')
    expect(actionLabel('extension-action', chinese)).toBe('extension-action')
    expect(formatDuration(3_661_000, english)).toBe('1h 1m')
    expect(formatDuration(90_000, chinese)).toBe('1 分钟')
  })

  it('keeps translated copy out of component and registration sources', async () => {
    for (const file of ['FabricView.tsx', 'index.ts', 'labels.ts']) {
      const source = await readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/\p{Script=Han}/u)
    }
  })
})
