import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { RunView } from '../step-execution/types.ts';
/**
 * START_METHOD_deleteStepMaterials
 * Clear only the selected step's files, keeping task state and executor history.
 */
export declare function deleteStepMaterials(fs: FileSystem, waitMs: number, isActive: (run: RunView) => boolean | Promise<boolean>, cwd: string, taskId: string, stepId: string, signal: AbortSignal): Promise<void>;
