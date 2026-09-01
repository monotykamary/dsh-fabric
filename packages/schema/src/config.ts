import z from '@monotykamary/schemastery'
import { DEFAULT_SCHEMA_CONFIG, type FabricSchemaConfig, type FabricSchemaMode } from './controller.ts'

export const FABRIC_SCHEMA_SETTINGS_NAMESPACE = 'fabric-schema'
export const FABRIC_SCHEMA_MODES = ['off', 'audit', 'enforce'] as const
export const MIN_CERTIFICATE_TTL_MS = 1_000
export const MAX_CERTIFICATE_TTL_MS = 10 * 60_000
export const MAX_SCHEMA_FILES = 1_000
export const MIN_SCHEMA_BYTES = 1_024
export const MAX_SCHEMA_BYTES = 100 * 1024 * 1024

export interface Config {
  mode?: FabricSchemaMode
  certificateTtlMs?: number
  maxFiles?: number
  maxBytes?: number
  trustedCommands?: Record<string, { command: string; args: string[]; shell: boolean; timeoutMs: number }>
}

export const Config: z<Config> = z.object({
  mode: z.union([z.const('off'), z.const('audit'), z.const('enforce')]).default(DEFAULT_SCHEMA_CONFIG.mode),
  certificateTtlMs: z.number().step(1).min(MIN_CERTIFICATE_TTL_MS).max(MAX_CERTIFICATE_TTL_MS)
    .default(DEFAULT_SCHEMA_CONFIG.certificateTtlMs),
  maxFiles: z.number().step(1).min(1).max(MAX_SCHEMA_FILES).default(DEFAULT_SCHEMA_CONFIG.maxFiles),
  maxBytes: z.number().step(1).min(MIN_SCHEMA_BYTES).max(MAX_SCHEMA_BYTES).default(DEFAULT_SCHEMA_CONFIG.maxBytes),
  trustedCommands: z.dict(z.object({
    command: z.string(),
    args: z.array(z.string()),
    shell: z.boolean(),
    timeoutMs: z.number().step(1).min(1),
  })).default({}),
})

export function resolveFabricSchemaConfig(config: Config = {}): FabricSchemaConfig {
  return {
    mode: config.mode ?? DEFAULT_SCHEMA_CONFIG.mode,
    certificateTtlMs: config.certificateTtlMs ?? DEFAULT_SCHEMA_CONFIG.certificateTtlMs,
    maxFiles: config.maxFiles ?? DEFAULT_SCHEMA_CONFIG.maxFiles,
    maxBytes: config.maxBytes ?? DEFAULT_SCHEMA_CONFIG.maxBytes,
    trustedCommands: structuredClone(config.trustedCommands ?? DEFAULT_SCHEMA_CONFIG.trustedCommands),
  }
}
