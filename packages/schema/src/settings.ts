import { Service, type Context } from '@monotykamary/cordis'
import { installSettingsSection, settingsNamespace } from '@monotykamary/dsh-settings'
import type { FabricSchemaConfig } from './controller.ts'
import {
  Config as ConfigSchema,
  FABRIC_SCHEMA_SETTINGS_NAMESPACE,
  resolveFabricSchemaConfig,
  type Config as FabricSchemaSettingsConfig,
} from './config.ts'

export const Config = ConfigSchema
export { FABRIC_SCHEMA_SETTINGS_NAMESPACE }
export type { FabricSchemaSettingsConfig }

export const name = 'dsh-fabric-schema/settings'

/** Persistent Schema defaults shared by future Fabric agent sessions. */
export class FabricSchemaSettings extends Service {
  private source: () => FabricSchemaSettingsConfig

  constructor(ctx: Context, config: FabricSchemaSettingsConfig = {}) {
    super(ctx, 'fabricSchemaSettings')
    const base = resolveFabricSchemaConfig(config)
    this.source = () => base
    installSettingsSection(
      ctx,
      settingsNamespace(FABRIC_SCHEMA_SETTINGS_NAMESPACE),
      ConfigSchema,
      base,
      {
        setSource: source => { this.source = source },
        onChange: () => undefined,
      },
    )
  }

  /** Read a detached configured snapshot for a newly mounting agent session. */
  current(): FabricSchemaConfig {
    return resolveFabricSchemaConfig(this.source())
  }
}

declare module '@monotykamary/cordis' {
  interface Context {
    fabricSchemaSettings: FabricSchemaSettings
  }
}

export default FabricSchemaSettings
