/**
 * FILE: plugin/src/dsh-integration/config.ts
 * DESCRIPTION: Define deployment limits for Git reads and project writer locks
 */
import Schema from '@deepseek-ai/schemastery'

/** Execution limits supplied by the plugin configuration. */
export interface ProjectConfig {
  gitTimeoutMs: number
  gitGraceMs: number
  lockWaitMs: number
}
/** Deployment limits for Git reads and project writer locks. */
export interface Config extends ProjectConfig {}
/** Validate operation limits before plugin activation. */
export const Config: Schema<Config> = Schema.object({
  gitTimeoutMs: Schema.natural().min(1).max(2147483647).default(10000),
  gitGraceMs: Schema.natural().min(1).max(2147483647).default(1000),
  lockWaitMs: Schema.natural().min(1).max(2147483647).default(10000),
})
