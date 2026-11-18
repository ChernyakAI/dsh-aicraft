/**
 * FILE: plugin/src/task-management/creation-result.ts
 * DESCRIPTION: Identify a proven refusal before task publication
 */
/** A refusal of this attempt; another writer's task may already exist. */
export declare class TaskCreationRefusal extends Error {
    readonly taskIdentifier: string;
    readonly outcome = "not-created";
    constructor(taskIdentifier: string, cause: unknown);
}
