/** Localized copy for the Fabric Schema plugin settings card. */

import type { LocaleDictOf } from '@monotykamary/dsh-client-ui-slots'

export type FabricSettingsLocaleKey =
  | 'title' | 'description' | 'expand' | 'collapse' | 'unsaved' | 'readOnly'
  | 'mode' | 'modeHint' | 'ttl' | 'ttlHint' | 'maxFiles' | 'maxFilesHint'
  | 'maxBytes' | 'maxBytesHint' | 'overridden' | 'reset' | 'invalid'
  | 'sessionHint' | 'save' | 'saving' | 'discard' | 'saveFailed'

declare module '@monotykamary/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'fabric.settings': FabricSettingsLocaleKey
  }
}

export const settingsEn: LocaleDictOf<'fabric.settings'> = {
  title: 'Fabric Schema', description: 'Typed evidence and certified workspace transactions',
  expand: 'Expand', collapse: 'Collapse', unsaved: 'Unsaved', readOnly: 'Settings are read-only in this client.',
  mode: 'Mode', modeHint: 'off leaves mutations ungated; audit records would-block events; enforce requires schema_commit.',
  ttl: 'Certificate TTL (ms)', ttlHint: 'Validity window for a schema_verify certificate, from 1,000 to 600,000 ms.',
  maxFiles: 'Maximum files', maxFilesHint: 'Maximum files in one schema_commit transaction, from 1 to 1,000.',
  maxBytes: 'Maximum bytes', maxBytesHint: 'Maximum total bytes written by one transaction, from 1,024 to 104,857,600.',
  overridden: 'Overridden', reset: 'Reset', invalid: 'Enter a value inside the supported range.',
  sessionHint: 'Saved values apply to new sessions. Use /fabric schema [off|audit|enforce] for a session-only override.',
  save: 'Save', saving: 'Saving…', discard: 'Discard',
  saveFailed: 'The Host did not accept every value. Your drafts were kept.',
}

export const settingsZh: LocaleDictOf<'fabric.settings'> = {
  title: 'Fabric Schema', description: '类型化证据与认证工作区事务',
  expand: '展开', collapse: '收起', unsaved: '未保存', readOnly: '此客户端中的设置为只读。',
  mode: '模式', modeHint: 'off 不设门控；audit 记录本应阻止的事件；enforce 要求使用 schema_commit。',
  ttl: '证书有效期（毫秒）', ttlHint: 'schema_verify 证书的有效时间，范围为 1,000 至 600,000 毫秒。',
  maxFiles: '最大文件数', maxFilesHint: '单次 schema_commit 事务的最大文件数，范围为 1 至 1,000。',
  maxBytes: '最大字节数', maxBytesHint: '单次事务写入的最大总字节数，范围为 1,024 至 104,857,600。',
  overridden: '已覆盖', reset: '重置', invalid: '请输入支持范围内的值。',
  sessionHint: '保存的值适用于新会话。使用 /fabric schema [off|audit|enforce] 可仅覆盖当前会话。',
  save: '保存', saving: '正在保存…', discard: '放弃', saveFailed: 'Host 未接受全部值；草稿已保留。',
}


export type FabricSpeculationSettingsLocaleKey =
  | 'title' | 'description' | 'expand' | 'collapse' | 'unsaved' | 'readOnly'
  | 'enabled' | 'enabledHint' | 'on' | 'off'
  | 'maxConcurrent' | 'maxConcurrentHint' | 'maxEntries' | 'maxEntriesHint'
  | 'maxBufferBytes' | 'maxBufferBytesHint' | 'maxRetainedBytes' | 'maxRetainedBytesHint'
  | 'entryTtlMs' | 'entryTtlMsHint'
  | 'overridden' | 'reset' | 'invalid' | 'liveHint'
  | 'save' | 'saving' | 'discard' | 'saveFailed'

declare module '@monotykamary/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'fabric.speculation.settings': FabricSpeculationSettingsLocaleKey
  }
}

export const speculationSettingsEn: LocaleDictOf<'fabric.speculation.settings'> = {
  title: 'Speculative Code Mode', description: 'Hide read latency behind run_code generation',
  expand: 'Expand', collapse: 'Collapse', unsaved: 'Unsaved', readOnly: 'Settings are read-only in this client.',
  enabled: 'Enabled', enabledHint: 'Prefetch literal read, glob, and grep calls while a TypeScript run_code program streams.',
  on: 'On', off: 'Off',
  maxConcurrent: 'Maximum concurrent calls', maxConcurrentHint: 'Maximum hidden calls still running at once, from 1 to 32.',
  maxEntries: 'Maximum retained entries', maxEntriesHint: 'Maximum unserved hidden results retained at once, from 1 to 1,024.',
  maxBufferBytes: 'Stream buffer bytes', maxBufferBytesHint: 'Maximum buffered run_code argument bytes per stream, from 65,536 to 67,108,864.',
  maxRetainedBytes: 'Maximum retained bytes', maxRetainedBytesHint: 'Aggregate estimated bytes retained by unserved hidden results, from 65,536 to 268,435,456.',
  entryTtlMs: 'Entry TTL (ms)', entryTtlMsHint: 'Maximum age of an unserved hidden result, from 5,000 to 1,800,000 ms.',
  overridden: 'Overridden', reset: 'Reset', invalid: 'Enter a value inside the supported range.',
  liveHint: 'Changes apply live. Saving new limits or disabling speculation cancels unserved hidden calls; natural tool policy remains authoritative.',
  save: 'Save', saving: 'Saving…', discard: 'Discard',
  saveFailed: 'The Host did not accept every value. Your drafts were kept.',
}

export const speculationSettingsZh: LocaleDictOf<'fabric.speculation.settings'> = {
  title: '推测式 Code Mode', description: '在生成 run_code 时隐藏读取延迟',
  expand: '展开', collapse: '收起', unsaved: '未保存', readOnly: '此客户端中的设置为只读。',
  enabled: '启用', enabledHint: '在 TypeScript run_code 程序流式生成时，预取参数为字面量的 read、glob 与 grep 调用。',
  on: '开启', off: '关闭',
  maxConcurrent: '最大并发调用数', maxConcurrentHint: '同时运行的隐藏调用上限，范围为 1 至 32。',
  maxEntries: '最大保留条目数', maxEntriesHint: '同时保留但尚未使用的隐藏结果上限，范围为 1 至 1,024。',
  maxBufferBytes: '流缓冲字节数', maxBufferBytesHint: '每个流可缓冲的 run_code 参数上限，范围为 65,536 至 67,108,864 字节。',
  maxRetainedBytes: '最大保留字节数', maxRetainedBytesHint: '尚未使用的隐藏结果估算总字节上限，范围为 65,536 至 268,435,456 字节。',
  entryTtlMs: '条目有效期（毫秒）', entryTtlMsHint: '尚未使用的隐藏结果最长保留时间，范围为 5,000 至 1,800,000 毫秒。',
  overridden: '已覆盖', reset: '重置', invalid: '请输入支持范围内的值。',
  liveHint: '更改会立即生效。保存新上限或关闭推测执行会取消尚未使用的隐藏调用；自然调用的工具策略始终具有最终决定权。',
  save: '保存', saving: '正在保存…', discard: '放弃', saveFailed: 'Host 未接受全部值；草稿已保留。',
}
