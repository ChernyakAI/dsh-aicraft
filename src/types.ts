/** Shared explanation for a merged branch with more than one open task. */
export const AMBIGUOUS_TASKS_MESSAGE = 'Only one open task is allowed per branch. Currently:'

/** One process step projected for the panel. */
export interface StepView {
  id: string
  title: string
  role: string
  artifactCount: number | null
  artifactIssue: string | null
  model: RunModel
  status: 'pending' | 'current' | 'done' | 'skipped' | 'cancelled'
}

/** A task read from its project directory. */
export interface TaskView {
  id: string
  title: string
  status: 'open' | 'completed' | 'cancelled'
  updatedAt: string | null
  processName: string
  createdBranch: string | null
  currentStep: string | null
  steps: StepView[]
  runs: RunView[]
}

/** A model route for one run, independent of DSH's global default. */
export interface RunModel {
  provider: string
  model: string
  reasoningEffort: string | null
}

/** Durable task/stage linkage to a separate DSH session. */
export interface RunView {
  id: string
  stepId: string
  sessionId: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted'
  startedAt: string
  finishedAt: string | null
  outputPath: string
  model: RunModel
  error: string | null
}

/** Read result; invalid or ambiguous data is never selected as a current task. */
export interface TaskSnapshot {
  kind: 'empty' | 'task' | 'ambiguous' | 'invalid'
  tasks: TaskView[]
  allTasks: TaskView[]
  issues: string[]
}

/** One available process definition. */
export interface ProcessView {
  id: string
  name: string
}

/** Presence of the AICraft directory in a registered DSH workspace. */
export interface ProjectPresence {
  workspaceId: string
  hasAicraft: boolean
}

/** Project readiness and task state displayed together. */
export interface ProjectView {
  prepared: boolean
  needsPreparation: boolean
  branch: string | null
  creationIssue: string | null
  executionIssue: string | null
  processes: ProcessView[]
  task: TaskSnapshot
  requestTemplate: string
}

/** Developer-supplied task requirements. */
export interface CreateTaskRequest {
  taskIdentifier: string
  title: string
  processId: string
  requestText: string
}

/** A workspace-relative document listed in a material group. */
export interface MaterialFile { path: string; name: string }
/** Documents grouped by task stage or project purpose. */
export interface MaterialGroup { id: string; title: string; files: MaterialFile[]; issue: string | null }

/** Native execution observation; no custom records are written to chat logs. */
export interface SessionActivity { id: string; running: boolean; revision: string }
/** Project-scoped invalidations, with targeted count and branch updates. */
export interface ProjectChange {
  kind: 'ready' | 'change'
  paths: string[]
  counts: { taskId: string; stepId: string; count: number | null; issue: string | null }[]
  sessions: SessionActivity[]
  branch?: string | null
}
/** Bounded read-only document content for the panel. */
export interface MaterialDocument { path: string; text: string; version: string; format: 'markdown' | 'text'; readOnly?: boolean }

/** Editable project process template; task snapshots are separate. */
export interface ProcessDefinition {
  language?: ProcessTemplateLanguage
  name: string
  steps: { id: string; title: string; role: string; model?: RunModel | null }[]
}
export interface ProcessDocument { id: string; definition: ProcessDefinition; version: string }
export interface RoleDocument { id: string; text: string; version: string }
export interface ProjectSettings { processes: ProcessDocument[]; roles: string[]; roleDocuments: RoleDocument[] }

export type ProcessTemplateLanguage = 'ru' | 'en'

export interface InitializeProjectRequest {
  template: ProcessTemplateLanguage | 'manual'
  processId: string
  definition: ProcessDefinition | null
}

export interface StatisticsBucket {
  provider: string; model: string; period: 'peak' | 'off-peak' | 'unavailable'
  totals: Pick<ExecutionStatistics, 'input' | 'output' | 'total' | 'cacheRead' | 'requests' | 'unknownUsage' | 'unknownCache' | 'unknownPrice' | 'priced' | 'local' | 'uncachedCost' | 'cacheCost' | 'outputCost'>
}

/** Read-only derived statistics; unknown usage/prices never imply a zero bill. */
export interface ExecutionStatistics {
  input: number; output: number; total: number; cacheRead: number
  requests: number; unknownUsage: number; unknownCache: number; unknownPrice: number
  priced: number; local: number; uncachedCost: number; cacheCost: number; outputCost: number
  elapsedMs: number; llmMs: number; toolMs: number; running: boolean
  buckets: StatisticsBucket[]
  sessions: number; coverageIncomplete: boolean; incomplete: string[]
}
