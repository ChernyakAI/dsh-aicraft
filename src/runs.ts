import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { stepResultInstructions } from './process-templates.ts'
import { createArtifactScanner } from './artifact-files.ts'
import { readMaterial, targetFor } from './materials.ts'
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { installModelSelection, type AgentHandle, type Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-fs'
import { currentStepOf, modelAssignmentSchema } from './schemas.ts'
import { hasActiveRun, readTaskSnapshot, readTaskState, readRuns } from './task-state.ts'
import { readExecutionInputs, type ProjectConfig } from './project.ts'
import type { MaterialDocument, RunModel, RunView } from './types.ts'
import { AMBIGUOUS_TASKS_MESSAGE } from './types.ts'

/** Server-owned executor lifetime, unrelated to the browser panel lifetime. */
export class RunController {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly active = new Set<string>()
  private readonly releasing = new Set<string>()
  private archivedSessions = new Set<SessionId>()
  private releaseRevision = 0
  private stopping = false

  /**
   * @param ctx - Service context with DSH execution and persistence dependencies.
   * @param config - Project operation limits.
   */
  constructor(private readonly ctx: Context, private readonly config: ProjectConfig, private readonly trackStatistics?: (agent: Agent) => Promise<void>) {
    this.archivedSessions = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
    ctx.on('domain/changed', change => {
      if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
      // Read the committed event: the registry's cached state updates after this notification.
      this.archivedSessions = new Set(workspaceDomainState.parse(change.value).archivedSessionIds)
      this.releaseIdleHandles()
    })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const [id, handle] of this.handles) if (handle.agent === agent) {
        this.handles.delete(id)
        this.active.delete(id)
      }
    })
    ctx.on('agent/status', ({ status }) => { if (status === 'idle') this.releaseIdleHandles() })
    ctx.on('agent/inbox/discarded', () => this.releaseIdleHandles())
    const jobs = ctx.get('jobs')
    if (jobs) ctx.effect(() => jobs.events.subscribe({ owners: 'all' }, (event: { type: string }) => {
      if (event.type === 'removed') this.releaseIdleHandles()
    }), 'aicraft: executor job ownership')
    ctx.effect(() => async () => {
      this.stopping = true
      await Promise.all([...this.handles.values()].map(handle => handle.dispose()))
      this.handles.clear()
    }, 'aicraft: executor lifetime')
  }

  /** Ordinary idle chats stay live; archived owners release on lifecycle events, without polling. */
  private releaseIdleHandles(): void {
    this.releaseRevision++
    for (const [id, handle] of this.handles) {
      if (this.stopping || !this.archivedSessions.has(handle.agent.session.id) || this.active.has(id) || this.releasing.has(id) || handle.agent.status !== 'idle') continue
      this.releasing.add(id)
      void this.release(id, handle).catch(error => {
        this.ctx.get('logger')?.warn(`AICraft executor release failed: ${String(error)}`)
      }).finally(() => this.releasing.delete(id))
    }
  }

  private async release(id: string, handle: AgentHandle): Promise<void> {
    const agent = handle.agent
    while (!this.stopping && this.handles.get(id) === handle) {
      await agent.whenIdle()
      if (this.stopping || !this.archivedSessions.has(agent.session.id) || this.active.has(id) || this.handles.get(id) !== handle) return
      const revision = agent.session.seq, generation = this.releaseRevision
      const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: agent.session.id }, () => Promise.resolve([]))
      if (this.stopping || !this.archivedSessions.has(agent.session.id) || this.handles.get(id) !== handle) return
      if (agent.status !== 'idle' || agent.session.seq !== revision || this.releaseRevision !== generation) continue
      // Disposal clears the inbox and owned jobs: preserve queued input and job output.
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length
        || agent.ctx.get('jobs')?.list(agent.session.id).some((job: { owner?: SessionId }) => job.owner === agent.session.id)
        || activity.length) return
      // No await between the final activity check and starting native teardown.
      try {
        await handle.dispose()
        if (this.handles.get(id) === handle) this.handles.delete(id)
      } finally {
        if (this.handles.get(id) === handle && this.ctx.agents.get(agent.session.id) !== agent) this.handles.delete(id)
      }
      return
    }
  }

  private async model(assignment: RunModel, signal: AbortSignal): Promise<RunModel> {
    const selection = { provider: assignment.provider, model: assignment.model, ...(assignment.reasoningEffort === null ? {} : { reasoningEffort: ReasoningEffortId(assignment.reasoningEffort) }) }
    const resolved = await this.ctx.llm.resolveCallConfig(selection, signal)
    return { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort ?? null }
  }

  private async finish(cwd: string, taskId: string, run: RunView, recovery = false): Promise<void> {
    await withFileLock(join(cwd, '.aicraft'), async () => {
      if ((await readTaskSnapshot(this.ctx.fs, cwd, new AbortController().signal)).kind === 'ambiguous') return
      const target = await targetFor(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/runs.json`)
      const info = await this.ctx.fs.stat(target)
      if (!info) throw new Error('Executor history disappeared while the executor was running')
      const runs = await readRuns(this.ctx.fs, cwd, taskId)
      const index = runs.findIndex(item => item.id === run.id)
      if (index < 0) throw new Error('The executor link disappeared from task history')
      if (!['starting', 'running'].includes(runs[index]!.status)) return
      if (recovery) {
        const agent = this.ctx.agents.get(brandString<SessionId>(run.sessionId))
        if (this.active.has(run.id) || (agent && agent.status !== 'idle')) return
        run = await this.settled(runs[index]!)
      }
      runs[index] = run
      await this.ctx.fs.writeText(target, JSON.stringify(runs, null, 2) + '\n', { kind: 'replaceIfVersion', version: info.version }, undefined, { mode: 'workspace-write', workspaceRoot: cwd })
    }, { waitMs: this.config.lockWaitMs })
  }

  private async settled(run: RunView): Promise<RunView> {
    try {
      using observation = await this.ctx.sessionQuery.observeSession(brandString<SessionId>(run.sessionId))
      const end = observation.events.findLast(event => event.type === 'turn/end')
      if (end?.type === 'turn/end') {
        const completed = end.data.reason.kind === 'completed'
        return { ...run, status: completed ? 'completed' : ['interrupted', 'aborted'].includes(end.data.reason.kind) ? 'interrupted' : 'failed', finishedAt: new Date().toISOString(), error: completed ? null : `DSH turn ended: ${end.data.reason.kind}` }
      }
      return { ...run, status: 'interrupted', finishedAt: new Date().toISOString(), error: 'The saved run has no completed DSH turn' }
    } catch (error) {
      return { ...run, status: 'interrupted', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Reconcile durable links after restart without restarting model work.
   * @param cwd - Project directory.
   * @returns Fulfillment after missing live runs have their persisted outcome.
   */
  async reconcile(cwd: string): Promise<void> {
    this.releaseIdleHandles()
    const snapshot = await readTaskSnapshot(this.ctx.fs, cwd, new AbortController().signal)
    if (snapshot.kind !== 'task') return
    for (const task of snapshot.tasks) {
      for (const run of task.runs) {
        if ((run.status === 'starting' || run.status === 'running') && !this.active.has(run.id)) {
          const agent = this.ctx.agents.get(brandString<SessionId>(run.sessionId))
          if (!agent || agent.status === 'idle') await this.finish(cwd, task.id, run, true)
        }
      }
    }
  }

  /** Native activity includes background jobs and descendants after the root turn ends. */
  readonly isActive = async (run: RunView): Promise<boolean> => {
    if (['starting', 'running'].includes(run.status) || this.active.has(run.id)
      || (this.ctx.agents.get(brandString<SessionId>(run.sessionId))?.status ?? 'idle') !== 'idle') return true
    const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: brandString<SessionId>(run.sessionId) }, () => Promise.resolve([]))
    return activity.length > 0
  }

  /** Persist a task-specific model assignment without changing project templates. */
  async setStepModel(cwd: string, taskId: string, stepId: string, input: RunModel, signal: AbortSignal): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId) || !/^[a-z][a-z0-9-]*$/.test(stepId)) throw new Error('Invalid task or step ID')
    const model = modelAssignmentSchema.parse(input)
    await targetFor(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/process.json`, signal)
    await withFileLock(join(cwd, '.aicraft'), async () => {
      const snapshot = await readTaskSnapshot(this.ctx.fs, cwd, signal)
      if (snapshot.kind !== 'task' || snapshot.tasks[0]?.id !== taskId) throw new Error('Only the open, unambiguous task can be changed')
      const path = `.aicraft/tasks/${taskId}/process.json`
      const target = await targetFor(this.ctx.fs, cwd, path, signal)
      const info = await this.ctx.fs.lstat(path, { cwd }, signal)
      if (info && info.type !== 'file') throw new Error('Task process must be a regular file')
      const version = info ? (await this.ctx.fs.stat(target, signal))?.version : undefined
      if (info && !version) throw new Error('Task process changed while loading; refresh before saving')
      const state = await readTaskState(this.ctx.fs, cwd, taskId, signal)
      if (await hasActiveRun(state.runs, this.isActive)) throw new Error('Wait for the task executor before changing its model')
      const step = state.process.steps.find(step => step.id === stepId)
      if (!step) throw new Error('Step is missing from the task process')
      await this.model(model, signal)
      step.model = model
      await this.ctx.fs.writeText(target, JSON.stringify(state.process, null, 2) + '\n', info ? { kind: 'replaceIfVersion', version: version! } : { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
    }, { waitMs: this.config.lockWaitMs })
  }

  /** Clear only the selected step's files, keeping task state and executor history. */
  async deleteStepMaterials(cwd: string, taskId: string, stepId: string, signal: AbortSignal): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId) || !/^[a-z][a-z0-9-]*$/.test(stepId)) throw new Error('Invalid task or step ID')
    await targetFor(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/${stepId}`, signal)
    await withFileLock(join(cwd, '.aicraft'), async () => {
      signal.throwIfAborted()
      const snapshot = await readTaskSnapshot(this.ctx.fs, cwd, signal)
      if (snapshot.kind !== 'task' || snapshot.tasks[0]?.id !== taskId) throw new Error('Only the open, unambiguous task can be changed')
      const state = await readTaskState(this.ctx.fs, cwd, taskId, signal)
      if (!state.process.steps.some(step => step.id === stepId)) throw new Error('Step is missing from the task process')
      if (await hasActiveRun(state.runs, this.isActive)) {
        throw new Error('Stop the task executor before deleting step artifacts')
      }
      const path = `.aicraft/tasks/${taskId}/${stepId}`
      const target = await targetFor(this.ctx.fs, cwd, path, signal)
      const info = await this.ctx.fs.lstat(path, { cwd }, signal)
      if (!info) return
      if (info.type !== 'directory') throw new Error('Step artifacts must be a regular directory')
      // shortcut: DSH has no deletion service; only explicitly host-mapped local files are supported.
      const hostPath = fileURLToPath(this.ctx.fs.fileUrl(target))
      if (this.ctx.fs.processPathFromHostPath(hostPath) !== this.ctx.fs.processPath(target)) throw new Error('This filesystem does not support local artifact deletion')
      for (const name of await readdir(hostPath)) {
        if (name === '.gitkeep' || name === 'input-prompt.md') continue
        signal.throwIfAborted()
        await rm(join(hostPath, name), { recursive: true })
      }
    }, { waitMs: this.config.lockWaitMs })
  }

  /** Open or create the editable prompt without creating a run. */
  async prompt(cwd: string, taskId: string, stepId: string, signal: AbortSignal): Promise<string> {
    return withFileLock(join(cwd, '.aicraft'), () => this.inputPrompt(cwd, taskId, stepId, signal), { waitMs: this.config.lockWaitMs })
  }

  /** Generate editor defaults without changing the saved prompt or its version. */
  async defaultPrompt(cwd: string, taskId: string, stepId: string, version: string, signal: AbortSignal): Promise<MaterialDocument> {
    if (!version) throw new Error('The original file version is required')
    return withFileLock(join(cwd, '.aicraft'), async () => {
      const text = await this.inputPrompt(cwd, taskId, stepId, signal, version)
      return { path: `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`, text, version, format: 'markdown' }
    }, { waitMs: this.config.lockWaitMs })
  }

  private async inputPrompt(cwd: string, taskId: string, stepId: string, signal: AbortSignal, previewVersion?: string): Promise<string> {
    const snapshot = await readTaskSnapshot(this.ctx.fs, cwd, signal)
    if (snapshot.kind === 'ambiguous') throw new Error(AMBIGUOUS_TASKS_MESSAGE)
    if (snapshot.kind === 'invalid' || !snapshot.allTasks.some(task => task.id === taskId)) throw new Error('Task is missing or invalid')
    const state = await readTaskState(this.ctx.fs, cwd, taskId, signal)
    const step = state.process.steps.find(item => item.id === stepId)
    if (!step) throw new Error('Step is missing from the task process')
    const outputPath = `.aicraft/tasks/${taskId}/${stepId}`
    const path = `${outputPath}/input-prompt.md`
    const target = await targetFor(this.ctx.fs, cwd, path, signal)
    if (previewVersion !== undefined) {
      const current = await readMaterial(this.ctx.fs, cwd, path, signal)
      if (current.version !== previewVersion) throw new Error('The file changed outside the editor. Reload it before resetting the prompt.')
    } else if (await this.ctx.fs.lstat(path, { cwd }, signal)) return (await readMaterial(this.ctx.fs, cwd, path, signal)).text
    const { rules, role, request } = await readExecutionInputs(this.ctx.fs, cwd, taskId, step.role, signal)
    const knowledgePath = '.aicraft/knowledge-base'
    const hasKnowledge = (await this.ctx.fs.lstat(knowledgePath, { cwd }, signal))?.type === 'directory'
      && (await createArtifactScanner(this.ctx.fs, cwd, signal, 1, true)(knowledgePath)).length > 0
    const stageDirectories = state.process.steps.slice(0, state.process.steps.indexOf(step) + 1)
    // Legacy and manual processes without language metadata use English scaffolding.
    const language = state.process.language ?? 'en'
    const labels = language === 'ru'
      ? { step: 'Этап', role: 'Роль', rules: 'Общие правила', assignment: 'Постановка', artifacts: 'Артефакты', knowledge: 'База знаний', directories: 'Рабочие каталоги этапов', result: 'Результат этого запуска' }
      : { step: 'Step', role: 'Role', rules: 'Project rules', assignment: 'Task requirements', artifacts: 'Artifacts', knowledge: 'Knowledge base', directories: 'Step working directories', result: 'Result of this run' }
    const text = [
      `# AICraft: ${state.title}\n${labels.step}: ${step.title}\n${labels.role}: ${step.role}`,
      `## ${labels.rules}\n${rules}`, `## ${labels.role}\n${role}`,
      `## ${labels.assignment}\n${request}`,
      `## ${labels.artifacts}\n\n${hasKnowledge ? `${labels.knowledge}: \`.aicraft/knowledge-base/\`\n\n` : ''}${labels.directories}:\n\n${stageDirectories.map(item => `- \`.aicraft/tasks/${taskId}/${item.id}/\``).join('\n')}`,
      `## ${labels.result}\n${stepResultInstructions(outputPath, language)}`,
    ].join('\n\n') + '\n'
    if (text.includes('\0')) throw new Error('The generated prompt must not contain NUL bytes')
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('The generated prompt is too large (limit: 2 MiB)')
    if (previewVersion === undefined) await this.ctx.fs.writeText(target, text, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
    return text
  }

  /**
   * Start the current stage in a fresh DSH session using its editable input prompt.
   * @param workspaceId - Registered project identity.
   * @param cwd - Project directory.
   * @param taskId - Current task identity.
   * @param stepId - Current running stage.
   * @param override - Optional per-run route; never changes global settings.
   * @param signal - Creation-only cancellation.
   * @returns Saved link to the newly started executor.
   */
  async start(workspaceId: string, cwd: string, taskId: string, stepId: string, override: RunModel | null, signal: AbortSignal, sandboxMode?: SandboxMode): Promise<RunView> {
    await this.reconcile(cwd)
    return withFileLock(join(cwd, '.aicraft'), async () => {
      signal.throwIfAborted()
      const snapshot = await readTaskSnapshot(this.ctx.fs, cwd, signal)
      if (snapshot.kind !== 'task' || snapshot.tasks[0]?.id !== taskId) throw new Error('The current task changed or is ambiguous')
      const target = await targetFor(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/runs.json`, signal)
      const info = await this.ctx.fs.stat(target, signal)
      const state = await readTaskState(this.ctx.fs, cwd, taskId, signal)
      const step = state.process.steps.find(item => item.id === stepId)
      if (state.status !== 'open' || !step || currentStepOf(state) !== stepId || state.stepStates.find(item => item.id === stepId)?.status !== 'current') throw new Error('Only the current running stage can start an executor')
      if (await hasActiveRun(state.runs, this.isActive)) throw new Error('An executor is already active for this task')
      const model = await this.model(override ?? step.model, signal)
      const id = `run-${randomUUID()}`
      const outputPath = `.aicraft/tasks/${taskId}/${stepId}`
      const sessionId = `session-${randomUUID()}`
      const prompt = await this.inputPrompt(cwd, taskId, stepId, signal)
      let run: RunView = { id, stepId, sessionId, status: 'starting', startedAt: new Date().toISOString(), finishedAt: null, outputPath, model, error: null }
      const savedProcess = await targetFor(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/process.json`, signal)
      if (!await this.ctx.fs.stat(savedProcess, signal)) await this.ctx.fs.writeText(savedProcess, JSON.stringify(state.process, null, 2) + '\n', { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
      state.runs.push(run)
      await this.ctx.fs.writeText(target, JSON.stringify(state.runs, null, 2) + '\n', info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
      let handle: AgentHandle | undefined
      try {
        const preset = await this.ctx.agentPresets.resolve()
        const selected = { provider: model.provider, model: model.model, ...(model.reasoningEffort === null ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) }
        handle = await this.ctx.agents.create({
          sessionId: brandString<SessionId>(sessionId), meta: { cwd, agentPreset: preset.id }, agentOptions: selected, signal,
          setup: async (agentCtx, agent) => {
            await this.ctx.agentPresets.mount(agentCtx, preset.id)
            if (sandboxMode !== undefined) setSandboxMode(agent.session, sandboxMode)
            installModelSelection(agentCtx, { current: selected, assembled: undefined })
            agent.session.append('model/selection', selected)
            await this.trackStatistics?.(agent)
          },
        })
        const workspace = this.ctx.workspaceRegistry.get(brandString<WorkspaceId>(workspaceId))
        if (!workspace) throw new Error('The project disappeared before session attachment')
        await workspace.attachSession(handle.agent.session.id)
        this.ctx.sessionTitle.rename(handle.agent.session, `AICraft · ${state.title} · ${step.title} · ${state.runs.filter(item => item.stepId === stepId).length}`)
        run = { ...run, status: 'running' }
        state.runs[state.runs.length - 1] = run
        const fresh = await this.ctx.fs.stat(target, signal)
        if (!fresh || fresh.version === undefined) throw new Error('Task state disappeared before dispatch')
        // Preserve unrelated edits and guard the version read before dispatch.
        const current = await readTaskState(this.ctx.fs, cwd, taskId, signal)
        const index = current.runs.findIndex(item => item.id === id)
        if (index < 0 || current.status !== 'open' || currentStepOf(current) !== stepId || current.stepStates.find(item => item.id === stepId)?.status !== 'current') throw new Error('Task state changed before executor dispatch')
        current.runs[index] = run
        await this.ctx.fs.writeText(target, JSON.stringify(current.runs, null, 2) + '\n', { kind: 'replaceIfVersion', version: fresh.version }, signal, { mode: 'workspace-write', workspaceRoot: cwd })
        if (await hasActiveRun(current.runs.filter(item => item.id !== id), this.isActive)) throw new Error('An executor is already active for this task')
        this.handles.set(id, handle)
        this.active.add(id)
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
        const owned = handle
        void owned.agent.whenIdle().then(async () => {
          if (!this.stopping) await this.finish(cwd, taskId, await this.settled(run))
        }).catch(error => {
          if (!this.stopping) this.ctx.get('logger')?.warn(`AICraft run status update failed: ${String(error)}`)
        }).finally(() => { this.active.delete(id); this.releaseIdleHandles() })
        return run
      } catch (error) {
        this.active.delete(id)
        this.handles.delete(id)
        if (handle) await handle.dispose()
        // Record failure directly while this writer already holds the lock.
        const latest = await this.ctx.fs.stat(target)
        if (latest) {
          const current = { runs: await readRuns(this.ctx.fs, cwd, taskId) }
          const index = current.runs.findIndex(item => item.id === id)
          if (index >= 0) current.runs[index] = { ...run, status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }
          await this.ctx.fs.writeText(target, JSON.stringify(current.runs, null, 2) + '\n', { kind: 'replaceIfVersion', version: latest.version }, undefined, { mode: 'workspace-write', workspaceRoot: cwd })
        }
        throw error
      }
    }, { waitMs: this.config.lockWaitMs })
  }
}
