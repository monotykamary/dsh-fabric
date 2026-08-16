import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import QuickJsCodeRuntime from '../src/index.ts'

const config = {
  maxWallMs: 2_000,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxStackBytes: 256 * 1024,
  maxOutputBytes: 64 * 1024,
}

describe('QuickJS Code Mode composition', () => {
  it('runs a ToolRuntime sub-dispatch and commits its durable enclosure events', async () => {
    const ctx = new Context()
    const fibers = []
    try {
      fibers.push(await ctx.plugin(SessionStore))
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(QuickJsCodeRuntime, config))
      fibers.push(await ctx.plugin(ToolRuntime, { mode: 'code', maxParallelSubCalls: 2 }))
      fibers.push(await ctx.plugin(Object.assign((inner: Context) => {
        inner.tools.register(defineTool({
          name: 'double',
          description: 'Double one number.',
          parameters: { value: { type: 'number', required: true } },
          output: {
            schema: { type: 'object', additionalProperties: false, properties: { value: { type: 'number', required: true } } },
            render: (_args, value) => [{ type: 'text', text: String(value.value) }],
          },
          execute: async args => ({ value: args.value * 2 }),
          isConcurrencySafe: true,
        }))
      }, { inject: ['tools'] })))

      const session = ctx.sessions.create(SessionId('quickjs-code-mode'))
      const agent = { id: session.id, session, ctx, options: {}, status: 'idle' }
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'run-code-1' as never,
        name: 'run_code',
        arguments: {
          description: 'Double a number',
          code: 'const doubled = await tools.double({ value: 21 }); console.debug("computed"); return doubled.value',
        },
        agent: agent as never,
      })

      expect(result.isError).toBe(false)
      expect(result.value).toEqual({ logs: ['computed'], result: 42 })
      expect(session.events.filter(event => event.type === 'tool/code-dispatch-start')).toHaveLength(1)
      expect(session.events.filter(event => event.type === 'tool/code-dispatch')).toHaveLength(1)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })
})
