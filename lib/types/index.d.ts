/**
 * FILE: plugin/src/index.ts
 * DESCRIPTION: Compose and install the plugin entry points
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './dsh-integration/config.ts';
export { Config } from './dsh-integration/config.ts';
export { AicraftService } from './dsh-integration/service.ts';
export type { CreateTaskRequest, TaskCreationConfirmation, TaskCreationCheck, ProcessView, ProjectView, StepView, TaskSnapshot, TaskView } from './types.ts';
/** Stable AICraft server plugin name. */
export declare const name: string;
/**
 * START_METHOD_apply
 * Install the AICraft server service.
 * @param ctx - Owning Cordis plugin context.
 * @param config - Validated deployment limits.
 */
export declare function apply(ctx: Context, config: Config): void;
export { diagnosticContext, observeDiagnostics } from './dsh-integration/diagnostics.ts';
