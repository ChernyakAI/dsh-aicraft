/**
 * FILE: plugin/src/task-management/types.ts
 * DESCRIPTION: Expose the owner-defined data contracts
 */
import type { UiMessage } from '../ui-message.ts';
/** Shared explanation for a merged branch with more than one open task. */
export declare const AMBIGUOUS_TASKS_MESSAGE = "Only one open task is allowed per branch. Currently:";
/**
 * Developer-supplied task requirements.
 */
export interface CreateTaskRequest {
    taskIdentifier: string;
    title: string;
    processId: string;
    requestText: string;
}
import type { RunModel } from '../step-execution/types.ts';
/**
 * Process step state before material projection.
 */
export interface StepData {
    id: string;
    title: string;
    description?: string;
    role: string;
    model: RunModel;
    status: 'pending' | 'current' | 'done' | 'skipped' | 'cancelled';
}
/**
 * Task data before executor and material projections.
 */
export interface TaskData {
    id: string;
    title: string;
    status: 'open' | 'completed' | 'cancelled';
    updatedAt: string | null;
    processName: string;
    createdBranch: string | null;
    currentStep: string | null;
    steps: StepData[];
}
/**
 * Retain task-selection validity and read issues alongside all available task data.
 */
export interface TaskDataSnapshot {
    kind: 'empty' | 'task' | 'ambiguous' | 'invalid';
    tasks: TaskData[];
    allTasks: TaskData[];
    issues: TaskReadIssue[];
}
/**
 * Preserve the owner's distinction between invalid saved data and an unavailable source.
 */
export interface TaskReadIssue {
    code: 'state-conflict' | 'dependency-unavailable' | 'access-denied';
    message: string;
    uiMessage?: UiMessage;
    cause?: unknown;
}
/**
 * Publication-time result, independent of subsequent project reads.
 */
export interface TaskCreationConfirmation {
    taskIdentifier: string;
    title: string;
    initialState: {
        status: 'open';
        stepStates: {
            id: string;
            status: 'current' | 'pending';
        }[];
    };
}
/**
 * Known publication of one task-state command; refreshing the project is separate.
 */
export interface TaskChangeConfirmation {
    taskId: string;
    operation: 'goto' | 'return' | 'complete' | 'skip' | 'close' | 'reopen';
    status: TaskData['status'];
    stepStates: {
        id: string;
        status: StepData['status'];
    }[];
}
