import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import type { ProjectConfig } from './config.ts';
import type { ProjectView, TaskSnapshot } from './types.ts';
/**
 * START_METHOD_readProject
 * Read preparation, current branch, process choices and the current task.
 * @param fs - DSH filesystem.
 * @param subprocess - DSH process provider for read-only Git commands.
 * @param cwd - Canonical local project directory.
 * @param config - Operation limits.
 * @param signal - Caller cancellation.
 * @returns Project readiness and task state.
 */
export declare function readProject(fs: FileSystem, subprocess: Subprocess, cwd: string, config: ProjectConfig, signal: AbortSignal): Promise<ProjectView>;
/**
 * Add history and material counts, projecting owner-reported issues to the panel's text format.
 */
export declare function readTaskView(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<TaskSnapshot>;
