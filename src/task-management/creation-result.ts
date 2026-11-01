/**
 * FILE: plugin/src/task-management/creation-result.ts
 * DESCRIPTION: Identify a proven refusal before task publication
 */
/** A refusal of this attempt; another writer's task may already exist. */
export class TaskCreationRefusal extends Error {
  readonly outcome = 'not-created'
  constructor(readonly taskIdentifier: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'TaskCreationRefusal'
  }
}
