/**
 * FILE: plugin/src/dsh-integration/types.ts
 * DESCRIPTION: Expose the owner-defined data contracts
 */
import type { UiMessage } from '../ui-message.ts'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type Subprocess from '@deepseek-ai/dsh-subprocess'
import type { ProjectConfig } from './config.ts'

import type { StepData, TaskData } from '../task-management/types.ts'
import type { ProcessView } from '../project-settings/types.ts'
import type { OperationResult, RunView } from '../step-execution/types.ts'
/**
 * A process step with its material projection for the panel.
 */
export interface StepView extends StepData {
  artifactCount: number | null
  artifactIssue: string | null
  artifactIssueMessage?: UiMessage
}
/**
 * A task with its executor and material projections for the panel.
 */
export interface TaskView extends Omit<TaskData, 'steps'> {
  steps: StepView[]
  runs: RunView[]
}

/**
 * Complete framework help for the actual calling agent, independent of task state.
 */
export interface AgentHelp {
  description: string
  commands: { name: string; signature: string; description: string }[]
  resultNotes: string
}

/**
 * Read result; invalid or ambiguous data is never selected as a current task.
 */
export interface TaskSnapshot {
  kind: 'empty' | 'task' | 'ambiguous' | 'invalid'
  tasks: TaskView[]
  allTasks: TaskView[]
  issues: string[]
  issueMessages?: UiMessage[]
}

/**
 * Presence of the AICraft directory in a registered DSH workspace.
 */
export interface ProjectPresence {
  workspaceId: string
  hasAicraft: boolean
}

/**
 * Project readiness and task state displayed together.
 */
export interface ProjectView {
  prepared: boolean
  needsPreparation: boolean
  branch: string | null
  creationIssue: string | null
  creationIssueMessage?: UiMessage
  executionIssue: string | null
  executionIssueMessage?: UiMessage
  processes: ProcessView[]
  task: TaskSnapshot
  requestTemplate: string
}

/**
 * Native execution observation; no custom records are written to chat logs.
 */
export interface SessionActivity { id: string; running: boolean; revision: string }

/**
 * Project-scoped invalidations, with targeted count and branch updates.
 */
export interface ProjectChange {
  kind: 'ready' | 'change'
  paths: string[]
  counts: { taskId: string; stepId: string; count: number | null; issue: string | null; issueMessage?: UiMessage }[]
  sessions: SessionActivity[]
  branch?: string | null
}

/**
 * Composition callback supplied by the server integration.
 */
export type ProjectReader = (
  fs: FileSystem,
  subprocess: Subprocess,
  cwd: string,
  config: ProjectConfig,
  signal: AbortSignal,
) => Promise<ProjectView>

/**
 * Package-relative source path; current lines are read from the matching saved source revision.
 */
export interface DiagnosticSource {
  path: string
  method?: string
}

/**
 * In-process causal context. The sequence object is private to one action and shared by its operations.
 */
export interface DiagnosticContext {
  correlationId: string
  callId?: string
  callerSessionId?: string | null
  operationId?: string
  parentOperationId?: string
  testRunId?: string
  scenarioId?: string
  workspaceId?: string
  projectPath?: string
  taskId?: string | null
  stepId?: string | null
  runId?: string
  sessionId?: string | null
  source?: DiagnosticSource
  sequence: { value: number }
}

/**
 * Product facts only; collection and criterion results belong to the checking side.
 */
export interface DiagnosticEvent extends Omit<DiagnosticContext, 'sequence' | 'source'> {
  schemaVersion: 2
  type: string
  producer: string
  instanceId: string
  seq: number
  source: DiagnosticSource
  data: Record<string, unknown>
}

/** Result of checking an exact task in a fresh read of its original project.
 */
export interface TaskCreationCheck {
  outcome: 'found' | 'not-found' | 'unavailable'
  workspaceId: string
  taskIdentifier: string
  task: TaskView | null
  reason: string | null
  reasonMessage?: UiMessage
}

/** Stable creation refusal and assignment publication outcomes carried by the standard Remote mechanism.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'aicraft/task-not-created': { taskIdentifier: string; outcome: 'not-created'; uiMessage?: UiMessage }
    'aicraft/prompt-not-confirmed': Exclude<OperationResult<never>, { operationStatus: 'confirmed' }>
  }
}
