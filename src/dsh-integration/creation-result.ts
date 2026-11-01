/**
 * FILE: plugin/src/dsh-integration/creation-result.ts
 * DESCRIPTION: Interpret creation checks from fresh project reads
 */
import type { ProjectView,TaskCreationCheck } from './types.ts'

/** Interpret an explicit fresh read in its original workspace, including closed tasks. */
export function checkTaskCreation(workspaceId: string, taskIdentifier: string, project: ProjectView | null,
  reason: string | null = null): TaskCreationCheck {
  if (!project || project.task.kind === 'invalid' || project.task.kind === 'ambiguous') return {
    outcome: 'unavailable', workspaceId, taskIdentifier, task: null,
    reason: reason ?? (project?.task.issues.join('; ') || 'Project state is unavailable'),
  }
  const task = project.task.allTasks.find(item => item.id === taskIdentifier) ?? null
  return { outcome: task ? 'found' : 'not-found', workspaceId, taskIdentifier, task, reason: null }
}
