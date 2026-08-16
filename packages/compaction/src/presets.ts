import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fabricPresetRoot: string
  }
}

export const name = '@dsh-fabric/compaction/presets'
export const FABRIC_PRESET_ROOT = fileURLToPath(new URL('../presets/', import.meta.url))

/** Publish the package-relative Fabric preset root for the host's AgentPresets row. */
export function apply(ctx: Context): void {
  ctx.provide('fabricPresetRoot', FABRIC_PRESET_ROOT)
}

export default apply
