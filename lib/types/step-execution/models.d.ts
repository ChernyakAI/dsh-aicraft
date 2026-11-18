import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { RunModel, RunView } from '../step-execution/types.ts';
/**
 * START_METHOD_setStepModel
 * Persist a task-specific model assignment without changing project templates.
 */
export declare function setStepModel(fs: FileSystem, waitMs: number, isActive: (run: RunView) => boolean | Promise<boolean>, cwd: string, taskId: string, stepId: string, input: RunModel, signal: AbortSignal, resolveModel: (model: RunModel, signal: AbortSignal) => Promise<RunModel>): Promise<void>;
