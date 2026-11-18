import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { RunView } from './types.ts';
import type { RunStore } from './ports.ts';
/**
 * START_METHOD_readRuns
 * Executor history is independent of the task state schema.
 */
export declare function readRuns(fs: FileSystem, cwd: string, taskId: string, signal?: AbortSignal): Promise<RunView[]>;
/**
 * Persist only established facts under the existing project lock.
 */
export declare function createRunStore(fs: FileSystem, waitMs: number): RunStore;
