import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
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

  it('renders the reported header and shared labels in the active language', () => {
    const english = translator(en)
    const chinese = translator(zh)
    expect(english('header.title')).toBe('Fabric overview')
    expect(chinese('header.title')).toBe('Fabric 概览')
    expect(english('header.summary.one', { count: 1, running: 0 })).toBe('1 related node · 0 running')
    expect(english('header.summary.many', { count: 2, running: 1 })).toBe('2 related nodes · 1 running')
    expect(chinese('header.summary.many', { count: 2, running: 1 })).toBe('2 个相关节点 · 1 个运行中')
    expect(statusLabel('running', english)).toBe('Running')
    expect(kindLabel('compaction', english)).toBe('Context compaction')
    expect(activityKindLabel('workflow', chinese)).toBe('工作流')
    expect(actionLabel('started', chinese)).toBe('已开始')
    expect(actionLabel('running', chinese)).toBe('运行中')
    expect(actionLabel('idle', chinese)).toBe('非活动')
    expect(actionLabel('error', chinese)).toBe('错误')
    expect(actionLabel('extension-action', chinese)).toBe('extension-action')
    expect(formatDuration(3_661_000, english)).toBe('1h 1m')
    expect(formatDuration(90_000, chinese)).toBe('1 分钟')
  })

  it('keeps translated copy out of component and registration sources', async () => {
    for (const file of ['FabricView.tsx', 'FabricHeaderAction.tsx', 'index.ts', 'labels.ts']) {
      const source = await readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/\p{Script=Han}/u)
    }
  })
})
