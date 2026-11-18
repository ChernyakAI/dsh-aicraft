/**
 * FILE: plugin/src/dsh-integration/creation-result.ts
 * DESCRIPTION: Interpret creation checks from fresh project reads
 */
import { type UiMessage } from '../ui-message.ts';
import type { ProjectView, TaskCreationCheck } from './types.ts';
/**
 * Interpret an explicit fresh read in its original workspace, including closed tasks.
 */
export declare function checkTaskCreation(workspaceId: string, taskIdentifier: string, project: ProjectView | null, reason?: string | null, reasonMessage?: UiMessage): TaskCreationCheck;
