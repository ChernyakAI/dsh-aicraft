/**
 * FILE: plugin/src/step-execution/runs.ts
 * DESCRIPTION: Retain the execution controller facade while composing application ports in the integration module
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ProjectConfig } from '../dsh-integration/config.ts';
import { ExecutionApplication } from '../dsh-integration/execution/compose.ts';
import type { CallerRef, RunModel, RunView } from './types.ts';
/** Await native activity providers before admitting a task mutation.
 * START_METHOD_hasActiveRun
 */
export declare function hasActiveRun(runs: RunView[], isActive: (run: RunView) => boolean | Promise<boolean>): Promise<boolean>;
/** Compatible construction boundary; execution rules and operations use consumer-owned ports. */
export declare class RunController extends ExecutionApplication {
    constructor(ctx: Context, config: ProjectConfig, track: ((agent: Agent) => Promise<void>) | undefined, resolveModel: (assignment: RunModel, signal: AbortSignal) => Promise<RunModel>, caller?: (ref: CallerRef) => Agent | undefined);
}
