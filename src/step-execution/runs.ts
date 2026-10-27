/**
 * FILE: plugin/src/step-execution/runs.ts
 * DESCRIPTION: Own executor dispatch, recovery, native activity and lifetime
 */
import { diagnosticAccepted, diagnosticOperation, diagnosticPublication, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection,type Agent,type AgentHandle } from '@deepseek-ai/dsh-agent'
import type { } from '@deepseek-ai/dsh-agent-preset-registry'
import type { } from '@deepseek-ai/dsh-api-session-controller/types'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { } from '@deepseek-ai/dsh-fs'
import { createUserMessage,ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { } from '@deepseek-ai/dsh-session-query'
import type { } from '@deepseek-ai/dsh-session-title'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { } from '@deepseek-ai/dsh-workspace'
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ProjectConfig } from '../dsh-integration/config.ts'
import { readTaskSnapshot,readTaskState } from '../task-management/queries.ts'
import { currentStepOf } from '../task-management/state.ts'
import { targetFor } from '../work-materials/artifact-files.ts'
import { readRuns } from './history.ts'
import { inputPrompt } from './prompts.ts'
import type { RunModel,RunView } from './types.ts'

/**
 * START_METHOD_hasActiveRun
 * Await native activity providers before admitting any task mutation.
 */
export async function hasActiveRun(runs: RunView[], isActive: (run: RunView) => boolean | Promise<boolean>): Promise<boolean> {
  return diagnosticOperation({ path: 'src/step-execution/runs.ts', method: 'hasActiveRun' }, {  }, async () => {
    for (const run of runs) if (await isActive(run)) return true
    return false

  })
}
// END_METHOD_hasActiveRun

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
  constructor(
    private readonly ctx: Context,
    private readonly config: ProjectConfig,
    private readonly trackStatistics: ((agent: Agent) => Promise<void>) | undefined,
    private readonly resolveModel: (assignment: RunModel, signal: AbortSignal) => Promise<RunModel>,
  ) {
    this.archivedSessions = new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
    ctx.on('domain/changed', (change) => {
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
      void this.release(id, handle).catch((error) => {
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

  private async finish(cwd: string, taskId: string, run: RunView, recovery = false): Promise<void> {
    return diagnosticOperation({ path: 'src/step-execution/runs.ts' }, { projectPath: cwd, taskId, runId: run.id, sessionId: run.sessionId }, async () => {
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
        await diagnosticPublication(() => this.ctx.fs.writeText(target, JSON.stringify(runs, null, 2) + '\n', { kind: 'replaceIfVersion', version: info.version }, undefined, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
      }, { waitMs: this.config.lockWaitMs })

    })
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
   * START_METHOD_RunController.reconcile
   * Reconcile durable links after restart without restarting model work.
   * @param cwd - Project directory.
   * @returns Fulfillment after missing live runs have their persisted outcome.
   */
  async reconcile(cwd: string): Promise<void> {
    return diagnosticOperation({ path: 'src/step-execution/runs.ts', method: 'RunController.reconcile' }, { projectPath: cwd }, async () => {
      this.releaseIdleHandles()
      const snapshot = await readTaskSnapshot(this.ctx.fs, cwd, new AbortController().signal)
      if (snapshot.kind !== 'task') return
      for (const task of snapshot.tasks) {
        for (const run of await readRuns(this.ctx.fs, cwd, task.id)) {
          if ((run.status === 'starting' || run.status === 'running') && !this.active.has(run.id)) {
            const agent = this.ctx.agents.get(brandString<SessionId>(run.sessionId))
            if (!agent || agent.status === 'idle') await this.finish(cwd, task.id, run, true)
          }
        }
      }

    })
  }
  // END_METHOD_RunController.reconcile

  /**
   * START_METHOD_RunController.isActive
   * Native activity includes background jobs and descendants after the root turn ends.
   */
  readonly isActive = async (run: RunView): Promise<boolean> => {
    return diagnosticOperation({ path: 'src/step-execution/runs.ts', method: 'RunController.isActive' }, { runId: run.id, sessionId: run.sessionId }, async () => {
      if (['starting', 'running'].includes(run.status) || this.active.has(run.id)
        || (this.ctx.agents.get(brandString<SessionId>(run.sessionId))?.status ?? 'idle') !== 'idle') return true
      const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: brandString<SessionId>(run.sessionId) }, () => Promise.resolve([]))
      return activity.length > 0

    })
  }
  // END_METHOD_RunController.isActive

  /**
   * START_METHOD_RunController.start
   * Start the current stage in a fresh DSH session using its editable input prompt.
   * @param workspaceId - Registered project identity.
   * @param cwd - Project directory.
   * @param taskId - Current task identity.
   * @param stepId - Current running stage.
   * @param override - Optional per-run route; never changes global settings.
   * @param signal - Creation-only cancellation.
   * @returns Saved link to the newly started executor.
   */
  async start(
    workspaceId: string,
    cwd: string,
    taskId: string,
    stepId: string,
    override: RunModel | null,
    signal: AbortSignal,
    sandboxMode?: SandboxMode,
  ): Promise<RunView> {
    return diagnosticOperation({ path: 'src/step-execution/runs.ts', method: 'RunController.start' }, { workspaceId: workspaceId, projectPath: cwd, taskId: taskId, stepId: stepId }, async () => {
      await this.reconcile(cwd)
      return withFileLock(join(cwd, '.aicraft'), async () => {
        signal.throwIfAborted()
        const snapshot = await readTaskSnapshot(this.ctx.fs, cwd, signal)
        if (snapshot.kind !== 'task' || snapshot.tasks[0]?.id !== taskId) throw diagnosticRejection(new Error('The current task changed or is ambiguous'))
        const target = await targetFor(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/runs.json`, signal)
        const info = await this.ctx.fs.stat(target, signal)
        const state = { ...await readTaskState(this.ctx.fs, cwd, taskId, signal), runs: await readRuns(this.ctx.fs, cwd, taskId, signal) }
        const step = state.process.steps.find(item => item.id === stepId)
        if (state.status !== 'open' || !step || currentStepOf(state) !== stepId || state.stepStates.find(item => item.id === stepId)?.status !== 'current') throw diagnosticRejection(new Error('Only the current running stage can start an executor'))
        if (await hasActiveRun(state.runs, this.isActive)) throw diagnosticRejection(new Error('An executor is already active for this task'))
        const model = await this.resolveModel(override ?? step.model, signal)
        const id = `run-${randomUUID()}`
        const outputPath = `.aicraft/tasks/${taskId}/${stepId}`
        const sessionId = `session-${randomUUID()}`
        const prompt = await inputPrompt(this.ctx.fs, cwd, taskId, stepId, signal)
        let run: RunView = { id, stepId, sessionId, status: 'starting', startedAt: new Date().toISOString(), finishedAt: null, outputPath, model, error: null }
        diagnosticAccepted({ runId: id, sessionId, model, taskId, stepId })
        const savedProcess = await targetFor(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/process.json`, signal)
        if (!await this.ctx.fs.stat(savedProcess, signal)) await diagnosticPublication(() => this.ctx.fs.writeText(savedProcess, JSON.stringify(state.process, null, 2) + '\n', { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), savedProcess, 'writeText')
        state.runs.push(run)
        await diagnosticPublication(() => this.ctx.fs.writeText(target, JSON.stringify(state.runs, null, 2) + '\n', info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
        let handle: AgentHandle | undefined
        try {
          const preset = await this.ctx.agentPresets.resolve()
          const selected = { provider: model.provider, model: model.model, ...(model.reasoningEffort === null ? {} : {
            reasoningEffort: ReasoningEffortId(model.reasoningEffort) }) }
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
          if (!workspace) throw diagnosticRejection(new Error('The project disappeared before session attachment'))
          await workspace.attachSession(handle.agent.session.id)
          this.ctx.sessionTitle.rename(handle.agent.session, `AICraft · ${state.title} · ${step.title} · ${state.runs.filter(item => item.stepId === stepId).length}`)
          run = { ...run, status: 'running' }
          state.runs[state.runs.length - 1] = run
          const fresh = await this.ctx.fs.stat(target, signal)
          if (!fresh || fresh.version === undefined) throw diagnosticRejection(new Error('Task state disappeared before dispatch'))
          // Preserve unrelated edits and guard the version read before dispatch.
          const current = { ...await readTaskState(this.ctx.fs, cwd, taskId, signal),
            runs: await readRuns(this.ctx.fs, cwd, taskId, signal) }
          const index = current.runs.findIndex(item => item.id === id)
          if (index < 0 || current.status !== 'open' || currentStepOf(current) !== stepId || current.stepStates.find(item => item.id === stepId)?.status !== 'current') throw diagnosticRejection(new Error('Task state changed before executor dispatch'))
          current.runs[index] = run
          await diagnosticPublication(() => this.ctx.fs.writeText(target, JSON.stringify(current.runs, null, 2) + '\n', { kind: 'replaceIfVersion', version: fresh.version }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
          if (await hasActiveRun(current.runs.filter(item => item.id !== id), this.isActive)) throw diagnosticRejection(new Error('An executor is already active for this task'))
          this.handles.set(id, handle)
          this.active.add(id)
          handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
          const owned = handle
          void owned.agent.whenIdle().then(async () => {
            if (!this.stopping) await this.finish(cwd, taskId, await this.settled(run))
          }).catch((error) => {
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
            await diagnosticPublication(() => this.ctx.fs.writeText(target, JSON.stringify(current.runs, null, 2) + '\n', { kind: 'replaceIfVersion', version: latest.version }, undefined, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
          }
          throw error
        }
      }, { waitMs: this.config.lockWaitMs })

    })
  }
  // END_METHOD_RunController.start

}
