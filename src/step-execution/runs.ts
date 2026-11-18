/**
 * FILE: plugin/src/step-execution/runs.ts
 * DESCRIPTION: Retain the execution controller facade while composing application ports in the integration module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectConfig } from '../dsh-integration/config.ts'
import { diagnosticOperation } from '../dsh-integration/diagnostics.ts'
import { ExecutionApplication } from '../dsh-integration/execution/compose.ts'
import type { CallerRef, RunModel, RunView } from './types.ts'

/** Await native activity providers before admitting a task mutation.
 * START_METHOD_hasActiveRun
 */
export async function hasActiveRun(runs: RunView[], isActive: (run: RunView) => boolean | Promise<boolean>): Promise<boolean> {
  return diagnosticOperation({ path: 'src/step-execution/runs.ts', method: 'hasActiveRun' }, {}, async () => {
    for (const run of runs) if (await isActive(run)) return true
    return false
  })
}
// END_METHOD_hasActiveRun

/** Compatible construction boundary; execution rules and operations use consumer-owned ports. */
export class RunController extends ExecutionApplication {
  constructor(ctx: Context, config: ProjectConfig, track: ((agent: Agent) => Promise<void>) | undefined,
    resolveModel: (assignment: RunModel, signal: AbortSignal) => Promise<RunModel>,
    caller: (ref: CallerRef) => Agent | undefined = () => undefined) {
    super(ctx, config, track, resolveModel, caller)
  }
}
