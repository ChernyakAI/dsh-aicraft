import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ProcessTemplateLanguage } from './types.ts'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-fs'
import { readSettings, saveProcess, saveRole, deleteRole } from './settings.ts'
import { listMaterials, readMaterial, saveMaterial } from './materials.ts'
import { readTaskSnapshot } from './task-state.ts'
import type {} from '@deepseek-ai/dsh-subprocess'
import Schema from '@deepseek-ai/schemastery'
import { resolve } from 'node:path'
import { registerAgentTools } from './tools.ts'
import { RunController } from './runs.ts'
import { StatisticsController } from './statistics.ts'
import { ProjectWatch } from './project-watch.ts'
import type { ProjectChange } from './types.ts'
import { createTask, prepareProject, readProject, updateTask, hasAicraftProject, openProjectRules, type ProjectConfig } from './project.ts'
import type { InitializeProjectRequest, CreateTaskRequest, ProjectPresence, ProjectView, TaskSnapshot, RunModel, RunView, MaterialGroup, MaterialDocument, ProjectSettings, ProcessDocument, ProcessDefinition, RoleDocument, ExecutionStatistics } from './types.ts'
export type { CreateTaskRequest, ProjectView, ProcessView, TaskSnapshot, TaskView, StepView } from './types.ts'

/** Deployment limits for Git reads and project writer locks. */
export interface Config extends ProjectConfig {}
/** Validate operation limits before plugin activation. */
export const Config: Schema<Config> = Schema.object({
  gitTimeoutMs: Schema.natural().min(1).max(2147483647).default(10000),
  gitGraceMs: Schema.natural().min(1).max(2147483647).default(1000),
  lockWaitMs: Schema.natural().min(1).max(2147483647).default(10000),
})

/** Stable AICraft server plugin name. */
export const name: string = 'dsh-aicraft'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** AICraft operations shared by the panel and future agent tools. */
    aicraft: AicraftService
  }
}

/** Server operations exposed to the AICraft panel. */
export class AicraftService extends TypertRemoteService {
  /** Project identity and filesystem operations are provided by DSH. */
  static inject: string[] = ['workspaceRegistry', 'fs', 'subprocess', 'agents', 'agentPresets', 'sessionQuery', 'sessionTitle', 'llm', 'sessionProjections']
  private readonly runs: RunController
  private readonly statisticsController: StatisticsController
  private readonly projectWatch: ProjectWatch
  /**
   * @param ctx - Owning Cordis plugin context.
   * @param config - Validated operation limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'aicraft')
    this.statisticsController = new StatisticsController(ctx,config.lockWaitMs)
    this.runs = new RunController(ctx, config, agent => this.statisticsController.track(agent))
    this.projectWatch = new ProjectWatch(ctx, config)
  }

  /** One event-driven project subscription, independent of the selected chat. */
  @Remote({ mode: 'stream' })
  changes(workspaceId: string, taskId: string | null, signal: AbortSignal): AsyncIterable<ProjectChange> {
    return this.projectWatch.follow(this.projectPath(workspaceId), taskId, signal)
  }

  /**
   * Confirm that the AICraft server service is reachable.
   * @returns The stable connection status.
   */
  @Remote
  status(): string {
    return 'connected'
  }

  /**
   * Inspect project directories for icons in the workspace picker.
   * @param signal - Caller cancellation.
   * @returns Presence information for every registered workspace.
   */
  @Remote
  projects(signal: AbortSignal): Promise<ProjectPresence[]> {
    return Promise.all(this.ctx.workspaceRegistry.list().map(async workspace => ({
      workspaceId: workspace.id,
      hasAicraft: await hasAicraftProject(this.ctx.fs, this.projectPath(workspace.id), signal),
    })))
  }

  /**
   * Read task state for an explicitly selected DSH project.
   * @param workspaceId - Registered DSH Workspace identity, never an arbitrary path.
   * @param signal - Caller cancellation injected by Remote API.
   * @returns The project's current task snapshot.
   */
  @Remote
  async task(workspaceId: string, signal: AbortSignal): Promise<TaskSnapshot> {
    return readTaskSnapshot(this.ctx.fs, this.projectPath(workspaceId), signal)
  }

  /** Fetch derived task or executor-tree statistics separately from project/UI loading. */
  @Remote
  statistics(workspaceId: string, taskId: string, sessionId: string | null, signal: AbortSignal): Promise<ExecutionStatistics> {
    return this.statisticsController.read(this.projectPath(workspaceId), taskId, sessionId, signal)
  }

  private projectPath(workspaceId: string): string {
    const workspace = this.ctx.workspaceRegistry.get(brandString<WorkspaceId>(workspaceId))
    if (!workspace) throw new Error('The selected project is no longer registered in DSH')
    const cwd = this.ctx.fs.processPathFromHostPath(workspace.path)
    if (cwd === undefined) throw new Error('The filesystem provider cannot read this project')
    return cwd
  }

  /**
   * Read project readiness, process choices, current branch and task state.
   * @param workspaceId - Registered DSH project identity.
   * @param signal - Caller cancellation.
   * @returns Project state suitable for creation controls.
   */
  @Remote
  async project(workspaceId: string, signal: AbortSignal): Promise<ProjectView> {
    const cwd = this.projectPath(workspaceId)
    await this.runs.reconcile(cwd)
    return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal)
  }

  /** Agent reads must not reconcile or persist executor state. */
  projectForAgent(workspaceId: string, signal: AbortSignal): Promise<ProjectView> {
    return readProject(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), this.config, signal)
  }

  /** List documents in the selected project, independently of the chat session. */
  @Remote
  materials(workspaceId: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]> {
    return listMaterials(this.ctx.fs, this.projectPath(workspaceId), taskId, signal)
  }

  /** Read one project material without modifying it. */
  @Remote
  async material(workspaceId: string, path: string, signal: AbortSignal): Promise<MaterialDocument> {
    const cwd = this.projectPath(workspaceId)
    const document = await readMaterial(this.ctx.fs, cwd, path, signal)
    const snapshot = await readTaskSnapshot(this.ctx.fs, cwd, signal)
    return { ...document, readOnly: snapshot.kind === 'ambiguous' }
  }

  /** Open shared project rules, adopting the current filename on explicit request. */
  @Remote
  projectRules(workspaceId: string, signal: AbortSignal): Promise<MaterialDocument> {
    return openProjectRules(this.ctx.fs, this.projectPath(workspaceId), this.config.lockWaitMs, signal)
  }

  /** Save existing Markdown with an optimistic file version guard. */
  @Remote
  saveMaterial(workspaceId: string, path: string, text: string, version: string, signal: AbortSignal): Promise<MaterialDocument> {
    return saveMaterial(this.ctx.fs, this.projectPath(workspaceId), path, text, version, this.config.lockWaitMs, signal)
  }

  /** Save the model used by subsequent runs of this task step. */
  @Remote
  async setStepModel(workspaceId: string, taskId: string, stepId: string, model: RunModel, signal: AbortSignal): Promise<ProjectView> {
    const cwd = this.projectPath(workspaceId)
    await this.runs.setStepModel(cwd, taskId, stepId, model, signal)
    return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal)
  }

  /** Delete step outputs only after the panel's explicit confirmation. */
  @Remote
  async deleteStepMaterials(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<ProjectView> {
    const cwd = this.projectPath(workspaceId)
    await this.runs.deleteStepMaterials(cwd, taskId, stepId, signal)
    return readProject(this.ctx.fs, this.ctx.subprocess, cwd, this.config, signal)
  }

  /** Read editable project process templates and available roles. */
  @Remote
  settings(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings> {
    return readSettings(this.ctx.fs, this.projectPath(workspaceId), signal)
  }

  /** Persist a project process template without changing existing tasks. */
  @Remote
  saveProcess(workspaceId: string, id: string, definition: ProcessDefinition, version: string | null, templateLanguage: ProcessTemplateLanguage | null, signal: AbortSignal): Promise<ProcessDocument> {
    return saveProcess(this.ctx.fs, this.projectPath(workspaceId), id, definition, version, this.config.lockWaitMs, signal, templateLanguage)
  }

  /** Save project role instructions without replacing stale edits. */
  @Remote
  saveRole(workspaceId: string, id: string, text: string, version: string | null, signal: AbortSignal): Promise<RoleDocument> {
    return saveRole(this.ctx.fs, this.projectPath(workspaceId), id, text, version, this.config.lockWaitMs, signal)
  }

  /** Remove only a role not referenced by any process or saved task. */
  @Remote
  deleteRole(workspaceId: string, id: string, version: string, signal: AbortSignal): Promise<void> {
    return deleteRole(this.ctx.fs, this.projectPath(workspaceId), id, version, this.config.lockWaitMs, signal)
  }

  /** Read or create the editable step prompt without starting a model. */
  @Remote
  stepPrompt(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<string> {
    return this.runs.prompt(this.projectPath(workspaceId), taskId, stepId, signal)
  }

  /** Generate default editor text without saving; preserve the loaded file version. */
  @Remote
  defaultStepPrompt(workspaceId: string, taskId: string, stepId: string, version: string, signal: AbortSignal): Promise<MaterialDocument> {
    return this.runs.defaultPrompt(this.projectPath(workspaceId), taskId, stepId, version, signal)
  }

  /**
   * Launch the current stage in a new independent session.
   * @param workspaceId - Registered project identity.
   * @param taskId - Current task identity.
   * @param stepId - Current running stage.
   * @param model - Optional per-run model override.
   * @param signal - Creation cancellation.
   * @returns Durable executor link, without accepting the stage.
   */
  @Remote
  startStep(workspaceId: string, taskId: string, stepId: string, model: RunModel | null, signal: AbortSignal): Promise<RunView> {
    return this.runs.start(workspaceId, this.projectPath(workspaceId), taskId, stepId, model, signal)
  }

  /** Authorized agent entry; the executor inherits standing permissions, not a one-call grant. */
  startStepForAgent(workspaceId: string, taskId: string, stepId: string, mode: SandboxMode, signal: AbortSignal): Promise<RunView> {
    return this.runs.start(workspaceId, this.projectPath(workspaceId), taskId, stepId, null, signal, mode)
  }

  /**
   * Prepare missing project files without overwriting existing materials.
   * @param workspaceId - Registered DSH project identity.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
  prepare(workspaceId: string, request: InitializeProjectRequest, signal: AbortSignal): Promise<ProjectView> {
    return prepareProject(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), this.config, signal, request)
  }

  /**
   * Create one open task in the selected project.
   * @param workspaceId - Registered DSH project identity.
   * @param request - Task title, selected process and requirements.
   * @param signal - Caller cancellation.
   * @returns Project state with the created task.
   */
  @Remote
  createTask(workspaceId: string, request: CreateTaskRequest, signal: AbortSignal): Promise<ProjectView> {
    return createTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), request, this.config, signal)
  }

  /**
   * Resolve a registered project for an agent's actual working directory.
   * @param cwd - Session-owned directory, never a model argument.
   * @returns The matching Workspace identity.
   */
  workspaceForAgent(cwd: string): string {
    const workspace = this.ctx.workspaceRegistry.list().find(item => resolve(item.path) === resolve(cwd))
    if (!workspace) throw new Error('The session directory is not a registered DSH project')
    return workspace.id
  }

  /**
   * Select any stage; reset later statuses on return.
   * @param workspaceId - Registered project.
   * @param taskId - Current task identity.
   * @param stepId - Step in the task's saved process.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
  moveStep(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'move', stepId, this.config, signal, undefined, this.runs.isActive)
  }

  /**
   * Complete the current step and select the next pending stage without closing the task.
   * @param workspaceId - Registered project.
   * @param taskId - Current task identity.
   * @param stepId - Current running stage.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
  completeStep(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'complete', stepId, this.config, signal, undefined, this.runs.isActive)
  }

  /** Select a step without resetting the other stages; the previous current stage becomes pending. */
  @Remote
  goToStep(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'goto', stepId, this.config, signal, undefined, this.runs.isActive)
  }

  /** Return from a row to an eligible earlier step, preserving excluded stages and materials. */
  @Remote
  returnStep(workspaceId: string, taskId: string, fromStepId: string, stepId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'return', stepId, this.config, signal, fromStepId, this.runs.isActive)
  }

  /** Skip the current step and select the next pending stage, keeping all materials. */
  @Remote
  skipStep(workspaceId: string, taskId: string, stepId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'skip', stepId, this.config, signal, undefined, this.runs.isActive)
  }

  /**
   * Close a task without deleting materials or performing Git mutations.
   * @param workspaceId - Registered project.
   * @param taskId - Current task identity.
   * @param signal - Caller cancellation.
   * @returns Updated project state.
   */
  @Remote
  closeTask(workspaceId: string, taskId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'close', null, this.config, signal, undefined, this.runs.isActive)
  }

  /** Reopen a closed task without resetting stages, artifacts or executor history. */
  @Remote
  reopenTask(workspaceId: string, taskId: string, signal: AbortSignal): Promise<ProjectView> {
    return updateTask(this.ctx.fs, this.ctx.subprocess, this.projectPath(workspaceId), taskId, 'reopen', null, this.config, signal, undefined, this.runs.isActive)
  }
}

/**
 * Install the AICraft server service.
 * @param ctx - Owning Cordis plugin context.
 * @param config - Validated deployment limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(AicraftService, config)
  ctx.inject(['tools', 'aicraft', 'sandboxPolicy'], registerAgentTools)
  console.log('[dsh-aicraft] plugin loaded')
}
