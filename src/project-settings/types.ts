/**
 * FILE: plugin/src/project-settings/types.ts
 * DESCRIPTION: Expose the owner-defined data contracts
 */
import type { RunModel } from '../step-execution/types.ts'
/** One available process definition. */
export interface ProcessView {
  id: string
  name: string
}

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

/** Readiness without task, executor or material projections. */
export interface ProjectReadiness {
  prepared: boolean
  needsPreparation: boolean
  creationIssue: string | null
  processes: ProcessView[]
  requestTemplate: string
}
