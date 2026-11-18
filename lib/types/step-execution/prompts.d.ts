import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { MaterialDocument } from '../work-materials/types.ts';
import type { MutationProgress } from './types.ts';
/**
 * Validate and read the same executor inputs for the panel and dispatch.
 * @param fs - DSH filesystem provider.
 * @param cwd - Registered project directory.
 * @param taskId - Task identity obtained from the current snapshot.
 * @param roleId - Role identity from the saved process.
 * @param signal - Caller cancellation.
 * @returns Current rules, role and task requirements.
 */
export declare function readExecutionInputs(fs: FileSystem, cwd: string, taskId: string, roleId: string, signal: AbortSignal): Promise<{
    rules: string;
    role: string;
    request: string;
}>;
/**
 * START_METHOD_openStepPrompt
 * Open or create the editable prompt without creating a run.
 */
export declare function openStepPrompt(fs: FileSystem, waitMs: number, cwd: string, taskId: string, stepId: string, signal: AbortSignal, beforeCreate?: () => Promise<void>, progress?: MutationProgress<MaterialDocument>): Promise<string>;
/**
 * START_METHOD_defaultStepPrompt
 * Generate editor defaults without changing the saved prompt or its version.
 */
export declare function defaultStepPrompt(fs: FileSystem, waitMs: number, cwd: string, taskId: string, stepId: string, version: string, signal: AbortSignal): Promise<MaterialDocument>;
/** Read the saved assignment or prepare it from the current stage inputs.
 */
export declare function inputPrompt(fs: FileSystem, cwd: string, taskId: string, stepId: string, signal: AbortSignal, previewVersion?: string, beforeCreate?: () => Promise<void>, progress?: MutationProgress<MaterialDocument>): Promise<string>;
