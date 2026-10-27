/**
 * FILE: plugin/src/step-execution/types.ts
 * DESCRIPTION: Expose the owner-defined data contracts
 */
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
