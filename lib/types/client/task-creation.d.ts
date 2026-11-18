/**
 * FILE: plugin/src/client/task-creation.ts
 * DESCRIPTION: Retain each creation attempt independently of project snapshots
 */
import type { Notice } from './messages.ts';
import type { CreateTaskRequest, TaskCreationConfirmation, TaskCreationCheck } from 'dsh-aicraft/types';
/** Local attempt identity and its separately read result. */
export interface TaskCreationAttempt {
    workspaceId: string;
    taskIdentifier: string;
    request: CreateTaskRequest;
    sequence: number;
    outcome: 'sending' | 'created' | 'not-created' | 'unknown';
    confirmation: TaskCreationConfirmation | null;
    reason: Notice | null;
    check: TaskCreationCheck | null;
}
/** Preserve the Remote failure code and payload supplied by the generated adapter. */
export declare function isCreationRefusal(error: unknown, taskIdentifier: string): boolean;
/** Find the most recent attempt without discarding earlier project/task pairs. */
export declare function latestCreation(attempts: Record<string, TaskCreationAttempt>, workspaceId: string): TaskCreationAttempt | undefined;
