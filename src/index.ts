/**
 * FILE: plugin/src/index.ts
 * DESCRIPTION: Compose and install the plugin entry points
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerAgentTools } from './dsh-integration/agent-tools.ts'
import type { Config } from './dsh-integration/config.ts'
import { AicraftService } from './dsh-integration/service.ts'
export { Config } from './dsh-integration/config.ts'
export { AicraftService } from './dsh-integration/service.ts'
export type { CreateTaskRequest,ProcessView,ProjectView,StepView,TaskSnapshot,TaskView } from './types.ts'

/** Stable AICraft server plugin name. */
export const name: string = 'dsh-aicraft'
/**
 * START_METHOD_apply
 * Install the AICraft server service.
 * @param ctx - Owning Cordis plugin context.
 * @param config - Validated deployment limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(AicraftService, config)
  ctx.inject(['tools', 'aicraft', 'sandboxPolicy'], registerAgentTools)
  console.log('[dsh-aicraft] plugin loaded')
}
// END_METHOD_apply

// Expose the same diagnostic channel used by the installed server bundle to in-process checking tools.
export { diagnosticContext, observeDiagnostics } from './dsh-integration/diagnostics.ts'
