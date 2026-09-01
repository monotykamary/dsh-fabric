/**
 * Schema-enforced world state for dsh-fabric.
 *
 * Ports pi-fabric's Schema layer — the world-model heart of the Schema
 * harness: an append-only Timeline of typed, validated state transitions
 * stored as mesh events with a compare-and-swap head, plus a falsifiable
 * hypothesis / certificate transaction gate over the workspace
 * (hypothesize → verify → commit, fail-closed, rollback/quarantine).
 * State and schema records live in the durable mesh; the workspace
 * fingerprint and evidence digests bind every claim to the exact file
 * contents it was certified against.
 * @module dsh-fabric-schema
 */

export type {
  AdvanceHeadInput,
  StateCertificate,
  StateComplexityResult,
  StateComplexitySummary,
  StateGoal,
  StateHead,
  StateTransitionInput,
  StateTransitionKind,
  StateTransitionRecord,
  VerificationReport,
  SchemaEvidence,
  SchemaEvidenceResult,
  SchemaFileOperation,
  SchemaHypothesisRecord,
  SchemaCertificateRecord,
  SchemaStateBinding,
  SchemaWorkspaceRecord,
  StateHeadValue,
  VerifyResult,
} from './types.ts'
export { stateBinding } from './types.ts'
export { StateStore, STATE_TOPIC, CURRENT_KEY, GOAL_KEY, COMPLEXITY_KEY_PREFIX } from './state-store.ts'
export type { SchemaMeshEvent } from './state-store.ts'
export { SchemaController, DEFAULT_SCHEMA_CONFIG } from './controller.ts'
export type { FabricSchemaConfig, FabricSchemaMode, FabricSchemaTrustedCommand } from './controller.ts'
export {
  Config as FabricSchemaSettingsConfigSchema,
  FABRIC_SCHEMA_MODES,
  FABRIC_SCHEMA_SETTINGS_NAMESPACE,
  MAX_CERTIFICATE_TTL_MS,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_FILES,
  MIN_CERTIFICATE_TTL_MS,
  MIN_SCHEMA_BYTES,
  resolveFabricSchemaConfig,
} from './config.ts'
export type { Config as FabricSchemaSettingsConfig } from './config.ts'
export { FabricSchemaSettings } from './settings.ts'
export { snapshotWorkspace, resolveWorkspaceFile, sha256File } from './workspace.ts'
export type { WorkspaceSnapshot } from './workspace.ts'
export { countFileComplexity, typeScriptJavaScriptComplexity } from './complexity.ts'
export { runCommand } from './evidence-runner.ts'
export type { CommandResult, RunCommandOptions } from './evidence-runner.ts'
