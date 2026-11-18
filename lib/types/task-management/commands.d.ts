import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import type { ProjectConfig } from '../dsh-integration/config.ts';
import type { ProjectReader, ProjectView } from '../dsh-integration/types.ts';
import type { MutationProgress, RunView } from '../step-execution/types.ts';
import type { CreateTaskRequest, TaskChangeConfirmation, TaskCreationConfirmation } from './types.ts';
/**
 * START_METHOD_createTask
 * Create one task after rechecking project restrictions under a writer lock.
 * @param fs - DSH filesystem.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical local project directory.
 * @param request - Developer requirements and selected process.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Confirmation of the published task, without a second read.
 */
export declare function createTask(fs: FileSystem, subprocess: Subprocess, cwd: string, request: CreateTaskRequest, config: ProjectConfig, signal: AbortSignal, readProject: ProjectReader): Promise<TaskCreationConfirmation>;
/**
 * START_METHOD_updateTask
 * Apply one explicit task command; preserve process and all stage materials.
 * @param fs - DSH filesystem provider.
 * @param subprocess - Git command provider.
 * @param cwd - Canonical project directory.
 * @param taskId - Exact open task identity from the caller's view.
 * @param operation - Stage selection, completion, or separate task closure.
 * @param stepId - Stage identity for goto/return/complete/skip; null for closure.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @param fromStepId - Source stage for an explicit return.
 * @param isActive - Shared executor check including live native chat continuations.
 * @returns Updated project state.
 */
export declare function updateTask(fs: FileSystem, subprocess: Subprocess, cwd: string, taskId: string, operation: 'goto' | 'return' | 'complete' | 'skip' | 'close' | 'reopen', stepId: string | null, config: ProjectConfig, signal: AbortSignal, fromStepId: string | undefined, isActive: (run: RunView) => boolean | Promise<boolean>, readProject: ProjectReader, progress?: MutationProgress<TaskChangeConfirmation>, callerActivity?: () => Promise<boolean>, expected?: {
    expectedStep: string | null;
}): Promise<ProjectView>;
