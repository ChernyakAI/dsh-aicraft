import type { FileSystem } from '@deepseek-ai/dsh-fs';
import { type TaskDataSnapshot } from './types.ts';
/**
 * START_METHOD_assertProjectWritable
 * Recheck under the caller's writer lock; a merged task set is view-only.
 */
export declare function assertProjectWritable(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<void>;
/**
 * START_METHOD_readTaskState
 * Read task data without writing or migrating project files.
 */
export declare function readTaskState(fs: FileSystem, cwd: string, taskId: string, signal?: AbortSignal): Promise<{
    taskTitle: string;
    process: {
        [x: string]: unknown;
        name: string;
        steps: {
            [x: string]: unknown;
            id: string;
            title: string;
            role: string;
            model: import("../types.ts").RunModel;
            description?: string | undefined;
        }[];
        language?: "ru" | "en" | undefined;
    };
    title: string;
    taskType: string;
    taskIdentifier: string;
    status: "completed" | "cancelled" | "open";
    stepStates: {
        id: string;
        status: "pending" | "skipped" | "cancelled" | "current" | "done";
    }[];
    updatedAt?: string | undefined;
    createdBranch?: string | undefined;
}>;
/**
 * START_METHOD_readTaskSnapshot
 * Read the current task without modifying project files.
 * @param fs - DSH filesystem provider.
 * @param cwd - Project directory in the provider's execution world.
 * @param signal - Caller cancellation.
 * @returns A task, an empty project, or explicit invalid/ambiguous state.
 */
export declare function readTaskSnapshot(fs: FileSystem, cwd: string, signal: AbortSignal, validateHistory?: boolean): Promise<TaskDataSnapshot>;
