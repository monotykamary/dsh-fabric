/** Deterministic Fabric compaction provider for DeepSeek Harness. */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  compileFabricSummary,
  FABRIC_COMPACTION_MODEL,
  FABRIC_COMPACTION_PROVIDER,
  readLatestFabricSnapshot,
} from './compiler.ts'
import { selectFabricCompactionSource } from './source.ts'

interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

interface SummaryResult {
  summary: ContentBlock[]
  rawOutput?: ContentBlock[]
  llmStreamCall?: never
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
}

/** DSH-native transaction policy with pi-fabric's deterministic projection compiler. */
export class FabricCompactionEngine extends BasicCompactionEngine {
  static override inject = BasicCompactionEngine.inject
  static override Config = BasicCompactionEngine.Config

  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    signal?.throwIfAborted()
    const source = selectFabricCompactionSource(agent.session, input.messages)
    const compiled = compileFabricSummary(source.messages, {
      ...(source.lastTime === undefined ? {} : { lastTimestamp: new Date(source.lastTime).toISOString() }),
      activityEvents: source.activityEvents,
      budgetMessages: input.messages,
      ...(source.sourceTruncated ? { sourceTruncated: true } : {}),
    })
    signal?.throwIfAborted()
    return {
      summary: [{ type: 'text', text: compiled.summary }],
      rawOutput: compiled.rawOutput,
      provider: FABRIC_COMPACTION_PROVIDER,
      model: FABRIC_COMPACTION_MODEL,
    }
  }
}

export { compileFabricSummary, readLatestFabricSnapshot } from './compiler.ts'
export { selectFabricCompactionSource } from './source.ts'
export type { FabricCompactionSource, FabricCompactionSourceOptions } from './source.ts'
export type {
  CompiledFabricSummary,
  CompileFabricSummaryOptions,
  FabricCompactionSnapshotV1,
} from './compiler.ts'

export default FabricCompactionEngine
