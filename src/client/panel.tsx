/**
 * FILE: plugin/src/client/panel.tsx
 * DESCRIPTION: Keep panel state and coordinate user actions
 */
import { notice, noticeText, messageText, type Notice } from './messages.ts'
import { messageOf } from '../ui-message.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceSnapshot,WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button,IconListPenOutlineRegular,IconRefreshOutlineRegular,IconSettingsOutlineRegular,IconWarningTriangleOutlineRegular,Modal,SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace,PropsLocale,PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreateTaskRequest,TaskCreationConfirmation,InitializeProjectRequest,MaterialDocument,MaterialGroup,ProcessDefinition,ProcessDocument,ProcessTemplateLanguage,ProjectChange,ProjectPresence,ProjectSettings,ProjectView,RoleDocument,RunModel,RunView,SessionActivity,ExecutionStatistics as Statistics,TaskView } from 'dsh-aicraft/types'
import { useCallback,useEffect,useId,useRef,useState,type ReactNode } from 'react'
import { checkTaskCreation } from '../dsh-integration/creation-result.ts'
import { OperationPresentationError } from '../dsh-integration/operation-result.ts'
import type { VerificationRequest } from '../types.ts'
import { isCreationRefusal,latestCreation,type TaskCreationAttempt } from './task-creation.ts'
import { CreateTaskForm } from './create-task.tsx'
import { ExecutionStatistics } from './execution-statistics.tsx'
import { InitializeProject } from './initialize-project.tsx'
import { TaskRequestDialog } from './material-editor.tsx'
import { MaterialsBrowser } from './materials-browser.tsx'
import { ProjectPicker,TaskPicker } from './pickers.tsx'
import { ProcessSettings } from './process-settings.tsx'
import { projectReader } from './project-sync.ts'
import { RunHistory } from './run-history.tsx'
import { StepActions,TaskStages } from './task-view.tsx'

/**
 * Operations supplied by DSH integration to the panel, with shared mutation outcomes.
 */
export interface PanelFace {
  /** Observe platform recovery independently of an AICraft snapshot. */
  useConnectionGeneration(): number | null
  /** Read the connection status from the AICraft server service. */
  checkConnection(): Promise<string>
  /** Identify workspaces containing the AICraft directory. */
  loadProjects(signal: AbortSignal): Promise<ProjectPresence[]>
  /** Read the current task for a registered project. */
  statistics(workspaceId: string, taskId: string, sessionId: string | null, signal: AbortSignal): Promise<Statistics>
  followProject(workspaceId: string, taskId: string | null, signal: AbortSignal): AsyncIterable<ProjectChange>
  loadProject(workspaceId: string, signal: AbortSignal): Promise<ProjectView>
  /** Prepare missing project files. */
  prepareProject(workspaceId: string, request: InitializeProjectRequest): Promise<ProjectView>
  /** Create a task through the shared server operation. */
  createTask(workspaceId: string, request: CreateTaskRequest): Promise<TaskCreationConfirmation>
  goToStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>
  returnStep(workspaceId: string, taskId: string, fromStepId: string, stepId: string): Promise<ProjectView>
  skipStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>
  setStepModel(workspaceId: string, taskId: string, stepId: string, model: RunModel): Promise<ProjectView>
  deleteStepMaterials(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>
  completeStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>
  reopenTask(workspaceId: string, taskId: string): Promise<ProjectView>
  closeTask(workspaceId: string, taskId: string): Promise<ProjectView>
  startStep(workspaceId: string, taskId: string, stepId: string, model: RunModel | null, attemptId: string): Promise<RunView>
  observeRun(workspaceId: string, taskId: string, runId: string | null, attemptId: string | null): Promise<import('../types.ts').RunObservation>
  loadMaterials(workspaceId: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]>
  loadMaterial(workspaceId: string, path: string, signal: AbortSignal): Promise<MaterialDocument>
  /**
   * Client save port passed to TaskRequestDialog's document editor.
   */
  saveMaterial(workspaceId: string, path: string, text: string, version: string, signal: AbortSignal): Promise<import('../types.ts').OperationResult<MaterialDocument>>
  showStepPrompt(workspaceId: string, workspaceTitle: string, taskId: string, stepId: string): Promise<void>
  openProjectRules(workspaceId: string, workspaceTitle: string): Promise<void>
  openMaterial(workspaceId: string, workspaceTitle: string, path: string, preview?: MaterialDocument): void
  loadSettings(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings>
  saveProcess(workspaceId: string, id: string, definition: ProcessDefinition, version: string | null, templateLanguage:
     ProcessTemplateLanguage | null): Promise<ProcessDocument>
  saveRole(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>
  deleteRole(workspaceId: string, id: string, version: string): Promise<void>
  modelCatalog(): Promise<ModelCatalog>
  stopGenerating(sessionId: string): Promise<void>
  archiveChat(sessionId: string): Promise<void>
  openExecutor(sessionId: string): void
}

export type PanelProps = PropsRuntime<'main'> & PropsLocale<'aicraft'> & InjectFace<PanelFace> & { sessionId?: SessionId; visible: boolean }

type Operation = 'prepare' | 'create' | 'goto' | 'return' | 'skip' | 'complete' | 'close' | 'reopen' | 'start' | 'prompt' | 'delete-materials' | 'set-model'
interface PendingLaunch { workspaceId: string; taskId: string; attemptId: string; message: Notice; verification?: VerificationRequest }
/**
 * START_METHOD_AicraftPanel
 * Render project controls and show the server connection error only on failure.
 * @param props - Slot-owned translations and server operation.
 * @returns The AICraft panel.
 */
export function AicraftPanel({ t, checkConnection, loadProjects, loadProject, followProject, statistics, prepareProject,
  createTask, goToStep, returnStep, skipStep, completeStep, closeTask, reopenTask, startStep, observeRun, loadMaterials, loadMaterial,
  saveMaterial, setStepModel, deleteStepMaterials, openMaterial, openProjectRules, showStepPrompt, modelCatalog, loadSettings,
  saveProcess, saveRole, deleteRole, openExecutor, stopGenerating, archiveChat, useWorkspaces, useConnectionGeneration,
  sessionId, visible }:
PanelProps): ReactNode {
  const connectionGeneration = useConnectionGeneration()
  const workspaces: readonly WorkspaceView[] = useWorkspaces((snapshot: WorkspaceSnapshot) => snapshot.items)
  const archivedSessionIds = useWorkspaces((snapshot: WorkspaceSnapshot) => snapshot.archivedSessionIds)
  const [requestDialog, setRequestDialog] = useState<{
    workspaceId: string
    workspaceTitle: string
    taskId: string
    taskTitle: string } | null>(null)
  const [initializingProjectId, setInitializingProjectId] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  useEffect(() => {
    if (projectId !== null || sessionId === undefined) return
    const currentProject = workspaces.find(project => project.sessionIds.includes(sessionId))
    if (currentProject) setProjectId(currentProject.workspaceId)
  }, [projectId, sessionId, workspaces])
  const [creationAttempts, setCreationAttempts] = useState<Record<string, TaskCreationAttempt>>({})
  const attempts = useRef(creationAttempts)
  attempts.current = creationAttempts
  const creationSequence = useRef(0)
  const updateAttempt = (workspaceId: string, update: (previous: TaskCreationAttempt | undefined) => TaskCreationAttempt) => {
    const attempt = update(latestCreation(attempts.current, workspaceId))
    const next = { ...attempts.current, [JSON.stringify([workspaceId, attempt.taskIdentifier])]: attempt }
    attempts.current = next
    setCreationAttempts(next)
  }
  const creation = projectId ? latestCreation(creationAttempts, projectId) : undefined
  const pendingCreation = creation && ['created', 'unknown'].includes(creation.outcome) && creation.check?.outcome !== 'found'
  const [readError, setReadError] = useState<{ workspaceId: string; message: Notice } | null>(null)
  const [creatingTaskProjectId, setCreatingTaskProjectId] = useState<string | null>(null)
  const [finishingTask, setFinishingTask] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const refreshSequence = useRef(0)
  const [refreshRequest, setRefreshRequest] = useState<{ id: number; workspaceId: string } | null>(null)
  const [artifactRevision, setArtifactRevision] = useState(0)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivity & { completed: string }>>({})
  const [projectPresence, setProjectPresence] = useState<ProjectPresence[]>([])
  const [projectsError, setProjectsError] = useState<Notice | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void loadProjects(controller.signal).then(
      (value) => { if (!controller.signal.aborted) { setProjectPresence(value); setProjectsError(null) } },
      (error) => { if (!controller.signal.aborted) setProjectsError(notice(error)) },
    )
    return () => controller.abort()
  }, [loadProjects, workspaces, refresh, connectionGeneration])

  const [projectSnapshot, setSnapshot] = useState<ProjectView | null>(null)
  const [snapshotProjectId, setSnapshotProjectId] = useState('')
  const [taskPhase, setTaskPhase] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const selected = workspaces.find(project => project.workspaceId === projectId)
  const project = selected?.workspaceId === snapshotProjectId ? projectSnapshot : null
  const readingState = Boolean(selected && (taskPhase === 'loading' || (!project && taskPhase !== 'failed')))
  const snapshot = project?.task
  const [taskSelection, setTaskSelection] = useState<{ workspaceId: string; taskId: string } | null>(null)
  const allTasks = snapshot?.allTasks ?? []
  const viewedTask = (taskSelection?.workspaceId === selected?.workspaceId ? allTasks.find(task =>
    task.id === taskSelection?.taskId) : undefined)
    ?? snapshot?.tasks[0] ?? allTasks[0]
  const isRunRunning = (run: RunView) => sessionActivity[run.sessionId]?.running ?? ['starting', 'running'].includes(run.status)
  const taskRunning = viewedTask?.runs.some(isRunRunning) ?? false
  const canManageTask = snapshot?.kind === 'task' && viewedTask?.id === snapshot.tasks[0]?.id
  const readOnlyProject = snapshot?.kind === 'ambiguous'
  const blockedStepActions = readOnlyProject || snapshot?.kind === 'invalid' || Boolean(pendingCreation)
  useEffect(() => {
    if (selected && project) window.dispatchEvent(new CustomEvent('aicraft:project-readonly', { detail: { workspaceId: selected.workspaceId, readOnly: readOnlyProject } }))
  }, [selected?.workspaceId, Boolean(project), readOnlyProject])
  const scrollRef = useRef<HTMLDivElement>(null)
  const resetScroll = useCallback(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [])
  const sectionId = useId()
  const [section, setSection] = useState<'task' | 'settings'>('task')
  const requestProjectRead = useRef<(() => void) | null>(null)
  useEffect(() => {
    const saved = (event: Event) => {
      if ((event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId !== projectId || !projectId) return
      if (section !== 'settings') { setRefresh(value => value + 1); return }
      requestProjectRead.current?.()
    }
    window.addEventListener('aicraft:material-saved', saved)
    return () => window.removeEventListener('aicraft:material-saved', saved)
  }, [projectId, section])

  const modeId = useId()
  const viewKey = `${selected?.workspaceId ?? ''}:${viewedTask?.id ?? ''}`
  const [view, setView] = useState<{ key: string; mode: 'stages' | 'materials'; group: string | null }>({ key: '', mode: 'stages', group: null })
  const [settingsDirty, setSettingsDirty] = useState(false)
  const mode = view.mode
  useEffect(resetScroll, [section, mode, selected?.workspaceId, viewedTask?.id, resetScroll])
  const showStageMaterials = (stepId: string) => setView({ key: viewKey, mode: 'materials', group: `step:${stepId}` })
  const [operation, setOperation] = useState<'idle' | Operation>('idle')
  const [operationError, setOperationError] = useState<{ projectId: string; message: Notice } | null>(null)
  const [pendingStarts, setPendingStarts] = useState<Record<string, PendingLaunch>>({})
  const pendingStart = pendingStarts[viewKey] ?? null
  const updatePendingStart = (key: string, value: PendingLaunch | null) => setPendingStarts((previous) => {
    const next = { ...previous }
    if (value) next[key] = value
    else delete next[key]
    return next
  })
  const [connectionError, setConnectionError] = useState<Notice | null>(null)
  useEffect(() => {
    let active = true
    void checkConnection().then(
      () => { if (active) setConnectionError(null) },
      (error) => { if (active) setConnectionError(notice(error)) },
    )
    return () => { active = false }
  }, [checkConnection, refresh, connectionGeneration])
  const hasActiveRun = allTasks.some(task => task.runs.some(isRunRunning))
  const [watchError, setWatchError] = useState<Notice | null>(null)
  const [watchReady, setWatchReady] = useState(false)
  useEffect(() => { setSessionActivity({}) }, [selected?.workspaceId, viewedTask?.id])
  useEffect(() => {
    setWatchReady(false)
    setWatchError(null)
    if (!visible || operation !== 'idle') return
    if (!selected) { setSnapshot(null); setTaskPhase('idle'); return }
    const workspaceId = selected.workspaceId, taskId = viewedTask?.id ?? null
    const controller = new AbortController()
    const requestedRefresh = refreshSequence.current
    const finishRefresh = () => setRefreshRequest(current =>
      current?.id === requestedRefresh && current.workspaceId === workspaceId ? null : current)
    let watching = false, synchronized = false
    // Rebinding an observer must retain the already loaded project view.
    if (!project) setTaskPhase('loading')
    const read = projectReader(
      async (signal) => {
        const attempt = latestCreation(attempts.current, workspaceId)
        return { value: await loadProject(workspaceId, signal), attempt }
      }, controller.signal, () => connectionGeneration !== null,
      ({ value, attempt }) => {
        const current = latestCreation(attempts.current, workspaceId)
        if (attempt && attempt === current && ['created', 'unknown'].includes(attempt.outcome)) {
          const check = checkTaskCreation(workspaceId, attempt.taskIdentifier, value)
          updateAttempt(workspaceId, previous => ({ ...previous!, check }))
          if (check.outcome === 'found') setTaskSelection({ workspaceId, taskId: attempt.taskIdentifier })
        }
        setReadError(null)
        synchronized = true
        setSnapshotProjectId(workspaceId); setSnapshot(value); setTaskPhase('ready'); setWatchReady(watching)
      },
      (error) => {
        synchronized = false; setTaskPhase('failed'); setWatchReady(false)
        const message = notice(error)
        setReadError({ workspaceId, message })
        const current = latestCreation(attempts.current, workspaceId)
        if (current && current.outcome === 'unknown') updateAttempt(workspaceId, previous => ({ ...previous!,
          check: checkTaskCreation(workspaceId, current.taskIdentifier, null,
            error instanceof Error ? error.message : String(error), messageOf(error)) }))
      },
      finishRefresh,
    )
    requestProjectRead.current = read
    read()
    void (async () => {
      try {
        for await (const frame of followProject(workspaceId, taskId, controller.signal)) {
          if (controller.signal.aborted) return
          const artifactPath = (path: string) => path.startsWith('.aicraft/knowledge-base')
            || (taskId !== null && new RegExp(`^\\.aicraft/tasks/${taskId}/[a-z][a-z0-9-]*(?:/|$)`).test(path))
          const projectChanged = frame.kind === 'ready' || frame.paths.some(path => !path.startsWith('$git/') && !artifactPath(path))
          watching = true
          if (frame.kind === 'ready') { synchronized = false; setWatchReady(false) }
          // A read started before an incremental update must not overwrite that newer snapshot field.
          if (projectChanged || (read.pending() && (frame.branch !== undefined || frame.counts.length > 0))) read()
          if (frame.branch !== undefined) setSnapshot(previous => previous && ({ ...previous, branch: frame.branch! }))
          if (frame.counts.length) setSnapshot((previous) => {
            if (!previous) return previous
            const update = (task: TaskView) => ({ ...task, steps: task.steps.map((step) => {
              const count = frame.counts.find(value => value.taskId === task.id && value.stepId === step.id)
              return count ? { ...step, artifactCount: count.count, artifactIssue: count.issue,
                artifactIssueMessage: count.issueMessage } : step
            }) })
            return { ...previous, task: { ...previous.task, tasks: previous.task.tasks.map(update), allTasks:
               previous.task.allTasks.map(update) } }
          })
          if (frame.kind === 'ready' || frame.paths.some(artifactPath) || projectChanged) setArtifactRevision(value => value + 1)
          if (frame.kind === 'ready' || frame.paths.some(path => path.startsWith('.aicraft/config/') || path === '.aicraft/project-rules.md' || path === '.aicraft/agent-rules.md')) setSettingsRevision(value => value + 1)
          if (frame.sessions.length) setSessionActivity((previous) => {
            const next = { ...previous }
            for (const activity of frame.sessions) next[activity.id] = { ...activity, completed: activity.running ? previous[activity.id]?.completed ?? '' : activity.revision }
            return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
          })
          setWatchError(null); setWatchReady(synchronized)
        }
      } catch (error) {
        watching = false
        if (!controller.signal.aborted) {
          setWatchReady(false)
          setWatchError(notice(error, { key: 'automaticUpdatesEnded' }))
        }
      }
    })()
    return () => { requestProjectRead.current = null; controller.abort() }
  }, [selected?.workspaceId, viewedTask?.id, visible, operation, followProject, loadProject, refresh, connectionGeneration])
  /**
   * Serialize panel mutations and display their result or the confirmation and refresh failure.
   */
  const executeMutation = async (kind: Operation, call: (workspaceId: string) => Promise<ProjectView>, succeeded?: () =>
  void): Promise<void> => {
    if (!selected || operation !== 'idle') return
    const workspaceId = selected.workspaceId
    setOperation(kind)
    setOperationError(null)
    try {
      const value = await call(workspaceId)
      setSnapshotProjectId(workspaceId)
      setSnapshot(value)
      if (kind === 'close' || kind === 'reopen') setTaskSelection({ workspaceId, taskId: viewedTask!.id })
      setProjectPresence(items => [...items.filter(item => item.workspaceId !== workspaceId), { workspaceId, hasAicraft: value.prepared }])
      succeeded?.()
    } catch (error) {
      setOperationError({ projectId: workspaceId, message: notice(error) })
      if (kind !== 'create') setRefresh(value => value + 1)
    } finally {
      setOperation('idle')
    }
  }
  /**
   * Retain the original creation attempt separately from project refresh and unknown outcomes.
   */
  const submitCreation = async (request: CreateTaskRequest): Promise<void> => {
    if (!selected || operation !== 'idle' || pendingCreation) return
    const workspaceId = selected.workspaceId, sequence = ++creationSequence.current
    updateAttempt(workspaceId, () => ({ workspaceId, taskIdentifier: request.taskIdentifier, sequence, request,
      outcome: 'sending', confirmation: null, reason: null, check: null }))
    setOperation('create'); setOperationError(null)
    try {
      const confirmation = await createTask(workspaceId, request)
      updateAttempt(workspaceId, previous => ({ ...previous!, outcome: 'created', confirmation }))
      setCreatingTaskProjectId(null)
    } catch (error) {
      const refused = isCreationRefusal(error, request.taskIdentifier)
      const message = notice(error)
      updateAttempt(workspaceId, previous => ({ ...previous!, outcome: refused ? 'not-created' : 'unknown', reason: message }))
      if (refused) setOperationError({ projectId: workspaceId, message: notice(message, { key: 'creationRefused' }) })
      else setCreatingTaskProjectId(null)
    } finally { setOperation('idle') }
  }
  /**
   * Select the explicit task-state command for the user's confirmed action.
   */
  const mutateTask = (kind: 'goto' | 'skip' | 'complete' | 'close', taskId: string, stepId?: string): Promise<void> =>
    executeMutation(kind, workspaceId => kind === 'close' ? closeTask(workspaceId, taskId)
      : kind === 'goto' ? goToStep(workspaceId, taskId, stepId!) : kind === 'skip' ? skipStep(workspaceId, taskId, stepId!) : completeStep(workspaceId, taskId, stepId!))
  /** Launch a stage with a stable attempt identity retained by the panel.
   */
  const launch = (taskId: string, stepId: string, model: RunModel | null) => {
    if (!selected) return
    const attemptId = crypto.randomUUID()
    const key = `${selected.workspaceId}:${taskId}`
    const original: PendingLaunch = { workspaceId: selected.workspaceId, taskId, attemptId, message: notice({ key: 'launchAwaiting' }) }
    updatePendingStart(key, original)
    void executeMutation('start', async (workspaceId) => {
      let run: RunView
      try { run = await startStep(workspaceId, taskId, stepId, model, attemptId) }
      catch (error) {
        if (error instanceof OperationPresentationError) updatePendingStart(key, error.verification ? { ...original,
          message: notice(error), verification: error.verification } : null)
        else updatePendingStart(key, { ...original, message: notice(error, { key: 'outcomeUnknown' }) })
        throw error
      }
      updatePendingStart(key, null)
      try { return await loadProject(workspaceId, new AbortController().signal) }
      catch (error) { throw notice(error, { key: 'executorStarted', params: { sessionId: run.sessionId } }) }
    })
  }
  /** Read the original attempt or its source document after an uncertain launch.
   */
  const checkStart = async () => {
    if (!pendingStart) return
    const original = pendingStart, key = `${original.workspaceId}:${original.taskId}`
    try {
      if (original.verification && original.verification.workspaceId !== original.workspaceId) throw { key: 'verificationForeign' }
      if (original.verification?.operation === 'material' && original.verification.path) {
        const document = await loadMaterial(original.workspaceId, original.verification.path, new AbortController().signal)
        openMaterial(original.workspaceId, selected?.title ?? original.workspaceId, document.path, document)
        updatePendingStart(key, { ...original, message: notice({ key: 'launchDocumentReadable' }) })
        return
      }
      const observed = await observeRun(original.workspaceId, original.taskId, null, original.attemptId)
      updatePendingStart(key, { ...original, message: notice({ key: 'launchFound', params: { outcome: observed.initialOutcome.state, availability: observed.availability.executor.state } }) })
      setRefresh(value => value + 1)
    } catch (error) {
      updatePendingStart(key, { ...original, message: notice(error) })
    }
  }
  const needsInitialization = project && (!project.prepared || project.processes.length === 0)
  const initializing = selected?.workspaceId === initializingProjectId
  const taskPath = viewedTask ? `.aicraft/tasks/${viewedTask.id}` : null
  const taskBranch = viewedTask?.createdBranch
  const branchMismatch = Boolean(section === 'task' && project?.branch && taskBranch && taskBranch !== project.branch)
  const manualRefreshing = Boolean(selected && refreshRequest?.workspaceId === selected.workspaceId)
  const taskRefreshVisible = Boolean(selected && project?.prepared && !readingState && section === 'task' && !initializing)
  const refreshControl = selected && <Button type="button" variant="ghost" title={operation !== 'idle'
    ? t('refreshBusyOperation') : settingsDirty ? t('refreshUnsavedChanges') : manualRefreshing ? t('loadingTask') : t('refresh')}
  aria-label={t('refresh')} aria-busy={manualRefreshing} disabled={operation !== 'idle' || settingsDirty}
  onClick={() => {
    if (operation !== 'idle' || settingsDirty) return
    setRefreshRequest({ id: ++refreshSequence.current, workspaceId: selected.workspaceId })
    setRefresh(value => value + 1)
  }} style={{ flex: '0 0 40px', width: 40, height: 40, padding: 0, border: '1px solid var(--aicraft-border, #8090a060)', borderRadius: 7 }}>
    <span aria-hidden="true" className={manualRefreshing ? 'aicraft-refreshing' : undefined} style={{ display: 'inline-flex' }}>
      <IconRefreshOutlineRegular size={18} />
    </span>
  </Button>
  return <div ref={scrollRef} className="aicraft-text-surface" style={{ flex: '1 1 0', minHeight: 0, width: '100%', overflowY: 'auto' }}>
    <section style={{ padding: 20, width: '100%', boxSizing: 'border-box' }} aria-label="AICraft">
      <style>{'.aicraft-destructive-confirm { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background: var(--dsw-alias-interactive-bg-hover-danger); } .aicraft-destructive-confirm:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); } .aicraft-destructive-confirm:active:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent); } .aicraft-step-menu [role="separator"] { height: 1px; min-height: 1px; flex-shrink: 0; background: var(--dsw-alias-border-l3); } section[aria-label="AICraft"] .aicraft-init-project { background: var(--dsw-alias-interactive-bg-hover); border: 1px solid var(--dsw-alias-border-l3); transition: background-color 100ms, filter 100ms; } section[aria-label="AICraft"] .aicraft-init-project:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); } section[aria-label="AICraft"] .aicraft-init-project:active:not(:disabled) { filter: brightness(0.95); } .aicraft-task-menu > [role="presentation"] { max-height: 260px; overflow-y: auto; } .aicraft-task-menu [role="menuitem"] { height: 52px; box-sizing: border-box; }'}</style>
      <style>{'.aicraft-view-tabs[role="tablist"] { background: var(--aicraft-stage-header, var(--dsw-alias-interactive-bg-hover)); } .aicraft-task-action { border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover); box-shadow: 0 1px 2px #0000000c; transition: background-color 120ms, box-shadow 120ms, transform 80ms; } .aicraft-task-action:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); box-shadow: 0 2px 4px #00000014; } .aicraft-task-action:active:not(:disabled) { transform: translateY(1px); box-shadow: none; }'}</style>
      <style>{'@keyframes aicraft-refresh { to { transform: rotate(360deg); } } .aicraft-refreshing { animation: aicraft-refresh 1s linear infinite; } @media (prefers-reduced-motion: reduce) { .aicraft-refreshing { animation: none; } }'}</style>
      {requestDialog && <TaskRequestDialog key={JSON.stringify([requestDialog.workspaceId, requestDialog.taskId])} {
        ...requestDialog} t={t} load={loadMaterial} save={saveMaterial} close={() => setRequestDialog(null)} />}
      {watchError && <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t, watchError)}</p>}
      {connectionError !== null && <p role="alert" style={{ color: 'var(--aicraft-error, #dc4545)', margin: '0 0 16px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t, connectionError)}</p>}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label htmlFor="aicraft-project" style={{ flex: '0 0 auto', minWidth: 56, whiteSpace: 'nowrap' }}>{t('project')}:</label>
          <ProjectPicker projects={workspaces} presence={projectPresence} selectedId={projectId ?? ''} busy={operation !== 'idle' || settingsDirty} t={t} select={setProjectId} />
          {readingState && <span role="status" style={{ display: 'flex', alignItems: 'center', minHeight: 40, fontSize: 12, opacity: 0.65, whiteSpace: 'nowrap' }}>{t('loadingTask')}</span>}
          {selected && project?.prepared && !needsInitialization && !readingState && <Button variant="ghost" title={t('settings')} aria-label={t('settings')} disabled={readOnlyProject || operation !== 'idle'}
            onClick={() => setSection('settings')} style={{ flex: '0 0 40px', width: 40, height: 40, border: '1px solid var(--aicraft-border, #8090a060)', borderRadius: 7, padding: 0 }}>
            <IconSettingsOutlineRegular size={18} />
          </Button>}
          {selected && <span title={`${t('projectPath')}: ${selected.path}`} style={{ flex: '1 1 180px', minWidth: 0, fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('projectPath')}: {selected.path}</span>}
          {selected && project && !readingState && needsInitialization && !initializing && <Button variant="ghost" className="aicraft-init-project" disabled={operation !== 'idle' || taskPhase === 'loading'} onClick={() => setInitializingProjectId(selected.workspaceId)}
            style={{ height: 40, borderRadius: 7, whiteSpace: 'nowrap' }}>{t(operation === 'prepare' ? 'preparing' : 'initProject')}</Button>}
        </div>
        <hr style={{ border: 0, borderTop: '1px solid var(--aicraft-border-subtle, #8090a040)', margin: '14px 0' }} />
        {projectsError !== null && <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t, projectsError)}</p>}
        {selected && taskPhase === 'failed' && readError?.workspaceId !== selected.workspaceId && <p role="alert">{t('loadFailed')}</p>}
        {selected && !taskRefreshVisible && (taskPhase === 'failed' || watchError || manualRefreshing) && refreshControl}
        {creation?.confirmation && <div role="status" data-testid="task-creation-confirmation">
          <p>{t('taskCreated')}: {creation.confirmation.taskIdentifier} — {creation.confirmation.title}</p>
          <p>{t('creationInitialState')}</p>
          <ul>{creation.confirmation.initialState.stepStates.map(step => <li key={step.id}>{step.id}: {t(step.status === 'current' ? 'currentStage' : 'pending')}</li>)}</ul>
          {pendingCreation && <p>{t('creationAwaitingRead')}</p>}
        </div>}
        {creation?.outcome === 'unknown' && <div role="status" data-testid="task-creation-unknown">
          <p>{t('creationUnknown')}: {creation.taskIdentifier}</p>
          {creation.reason && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t, creation.reason)}</p>}
          {creation.check?.outcome === 'not-found' && <p>{t('creationNotFound')}</p>}
          {creation.check?.outcome === 'unavailable' && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t('creationCheckFailed')}: {messageText(t, creation.check.reasonMessage, creation.check.reason)}</p>}
          {creation.check?.outcome === 'found' && <p>{t('creationFound')}: {creation.check.task?.title}</p>}
          <Button variant="outline" disabled={operation !== 'idle'} onClick={() => setRefresh(value => value + 1)}>{t('checkCreation')}</Button>
        </div>}
        {selected && readError?.workspaceId === selected.workspaceId && <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{creation?.confirmation ? t('creationReadFailed') : t('loadFailed')}: {noticeText(t, readError?.message ?? null)}</p>}
        {operationError?.projectId === selected?.workspaceId && <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t, operationError?.message ?? null)}</p>}
        {selected && initializing && <InitializeProject t={t} key={selected.workspaceId} busy={operation === 'prepare'} dirtyChanged={setSettingsDirty}
          cancel={() => setInitializingProjectId(null)} submit={request => executeMutation('prepare', workspaceId => prepareProject(workspaceId, request), () => { setInitializingProjectId(null); setSection('settings'); setView({ key: `${selected.workspaceId}:`, mode: 'stages', group: null }) })} />}
        <div id={`${sectionId}-task-panel`} role="region" aria-label={t('currentTaskSection')} hidden={section !== 'task' || initializing}>
          {selected && project?.prepared && !readingState && <><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ flex: '0 0 auto', minWidth: 56, whiteSpace: 'nowrap' }}>{t('taskPicker')}:</span>
            <TaskPicker tasks={allTasks} selectedId={viewedTask?.id ?? ''} busy={operation !== 'idle' || taskPhase === 'loading' || settingsDirty} t={t}
              create={() => setCreatingTaskProjectId(selected.workspaceId)} canCreate={snapshot?.kind === 'empty' && !project.creationIssue && !pendingCreation}
              select={taskId => setTaskSelection({ workspaceId: selected.workspaceId, taskId })} />
            {viewedTask && <Button type="button" variant="outline" title={t('uiTaskRequest')} aria-label={t('uiTaskRequest')} disabled={readOnlyProject || operation !== 'idle' || settingsDirty}
              onClick={() => setRequestDialog({ workspaceId: selected.workspaceId, workspaceTitle: selected.title, taskId:
                 viewedTask.id, taskTitle: viewedTask.title })}
              style={{ flex: '0 0 40px', width: 40, height: 40, padding: 0, borderRadius: 7 }}><IconListPenOutlineRegular size={18} /></Button>}
            {taskRefreshVisible && refreshControl}
            {taskPath && <span title={t('taskPathLabel', { path: taskPath })} style={{ flex: '1 1 180px', minWidth: 0, fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('uiTaskPath')} {taskPath}</span>}
          </div>
          {project?.branch && <p role={branchMismatch ? 'status' : undefined} style={{ margin: '8px 0 0', minWidth: 0, fontSize: 12, lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, opacity: branchMismatch ? 1 : 0.65, color: branchMismatch ? 'var(--aicraft-error, #dc2626)' : ['master', 'main'].includes(project.branch) ? 'var(--aicraft-branch, #ad6262)' : 'inherit' }}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t('branch')}: {project.branch}</span>
            {branchMismatch && <>
              <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}><IconWarningTriangleOutlineRegular size={14} /></span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t('createdBranch')}: {taskBranch}</span>
            </>}
          </p>}
          </>}
          {project?.prepared && !readingState && <div style={{ maxWidth: 300, margin: '14px 0' }}>
            <SegmentedControl className="aicraft-view-tabs" id={modeId} value={mode} label={t('views')} disabled={settingsDirty || operation !== 'idle'}
              options={[{ value: 'stages', label: t('stages') }, { value: 'materials', label: t('materials') }]}
              onChange={next => setView({ key: viewKey, mode: next, group: null })} />
          </div>}
          <div id={`${modeId}-stages-panel`} role="tabpanel" aria-labelledby={`${modeId}-stages`} hidden={mode !== 'stages'}>
            {project?.prepared && snapshot?.kind === 'empty' && !viewedTask && !pendingCreation && <p>{t('noTask')}</p>}
            {project?.prepared && snapshot?.kind === 'empty' && !viewedTask && !pendingCreation && <>
              {project.creationIssue && creation?.outcome !== 'not-created' ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t('creationBlocked')}: {messageText(t, project.creationIssueMessage, project.creationIssue)}</p>
                : <CreateTaskForm key={projectId} project={project} initial={creation?.outcome === 'not-created' ? creation.request : undefined} busy={operation === 'create'} t={t} submit={submitCreation} />}
            </>}
            {project?.prepared && viewedTask && creatingTaskProjectId === selected?.workspaceId && <Modal className="aicraft-text-surface" open title={t('create')} closeLabel={t('close')} onClose={() => { if (operation === 'idle') setCreatingTaskProjectId(null) }}>
              {operationError?.projectId === selected?.workspaceId && <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t, operationError.message)}</p>}
              {creation?.outcome === 'not-created' || snapshot?.kind === 'empty' && !project.creationIssue
                ? <CreateTaskForm key={projectId} project={project} initial={creation?.outcome === 'not-created' ? creation.request : undefined} busy={operation !== 'idle'} t={t} submit={submitCreation} />
                : <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{project.creationIssue ? messageText(t, project.creationIssueMessage, project.creationIssue) : t('creationBlocked')}</p>}
            </Modal>}
            {project && snapshot?.kind !== 'empty' && creation?.outcome === 'not-created' && creatingTaskProjectId !== selected?.workspaceId &&
              <CreateTaskForm key={`${projectId}:refused`} project={project} initial={creation.request} busy={operation !== 'idle'} t={t} submit={submitCreation} />}
            {(snapshot?.kind === 'invalid' || snapshot?.kind === 'ambiguous') && <div role="alert">
              <p>{t(snapshot.kind)}</p>
              <ul>{snapshot.issues.map((issue, index) => <li key={issue} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{messageText(t, snapshot.issueMessages?.[index],
                issue)}</li>)}{snapshot.tasks.map(task => <li key={task.id}>{
                task.title}</li>)}</ul>
            </div>}
            {viewedTask && !pendingCreation && [viewedTask].map(task => <div key={task.id} style={{ marginTop: 24 }}>
              <TaskStages task={task} busy={operation !== 'idle'} t={t} showStageMaterials={showStageMaterials}
                actions={step => <StepActions step={step} previousSteps={task.steps.slice(0, task.steps.findIndex(item => item.id === step.id)).filter(item => item.status !== 'cancelled')}
                  returnTo={stepId => executeMutation('return', workspaceId => returnStep(workspaceId, task.id, step.id, stepId))} current={task.currentStep === step.id && step.status === 'current'} blocked={blockedStepActions}
                  disabled={!canManageTask || operation !== 'idle' || taskRunning} busy={operation !== 'idle'} t={t}
                  prompt={() => { void executeMutation('prompt', async (workspaceId) => { await showStepPrompt(workspaceId, selected!.title, task.id, step.id); return loadProject(workspaceId, new AbortController().signal) }) }}
                  run={() => launch(task.id, step.id, null)}
                  modelCatalog={modelCatalog}
                  setModel={model => executeMutation('set-model', workspaceId => setStepModel(workspaceId, task.id, step.id, model))}
                  runWithModel={model => launch(task.id, step.id, model)}
                  select={(kind) => { void mutateTask(kind, task.id, step.id) }} />} />
              {finishingTask === task.id && <Modal className="aicraft-text-surface" open title={t('closeTask')} description={task.title} closeLabel={t('close')}
                onClose={() => { if (operation === 'idle') setFinishingTask(null) }}>
                <p>{t('finishPrompt')}</p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <Button variant="outline" disabled={operation !== 'idle'} onClick={() => setFinishingTask(null)}>{t('cancel')}</Button>
                  <Button variant="outline" disabled={!canManageTask || operation !== 'idle' || taskRunning}
                    onClick={() => { void mutateTask('close', task.id).then(() => setFinishingTask(null)) }}>{t('closeTask')}</Button>
                </div>
              </Modal>}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                <ExecutionStatistics t={t} key={`${selected!.workspaceId}:${task.id}`} title={t('uiTaskTotals')} workspaceId={selected!.workspaceId} taskId={task.id} sessionId={null}
                  active={visible && watchReady && section === 'task' && mode === 'stages'} revision={JSON.stringify([task.runs.filter(run => !['starting', 'running'].includes(run.status)).map(run => [run.id, run.finishedAt]), Object.values(sessionActivity).filter(item => item.completed).map(item => [item.id, item.completed])])} load={statistics} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
                  {operation !== 'idle' && <span role="status">{t('saving')}</span>}
                  <Button type="button" variant="outline" className="aicraft-task-action" disabled={!canManageTask || operation !== 'idle' || taskRunning} onClick={() => setFinishingTask(task.id)}>{t('closeTask')}</Button>
                  {task.status !== 'open' && <Button type="button" variant="outline" className="aicraft-task-action" disabled={snapshot?.kind !== 'empty' || operation !== 'idle' || hasActiveRun}
                    onClick={() => { void executeMutation('reopen', workspaceId => reopenTask(workspaceId, task.id)) }}>{t('reopenTask')}</Button>}
                </div>
              </div>
              {pendingStart && pendingStart.workspaceId === selected?.workspaceId && pendingStart.taskId === task.id && <div role="status">
                <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t, pendingStart.message)} {t('uiCheckThisOriginalLaunchBeforeStartingAnotherOne')}</p>
                <Button variant="outline" onClick={() => { void checkStart() }}>{t('uiCheckOriginalLaunch')}</Button>
              </div>}
              <RunHistory observeRun={observeRun} task={task} workspaceId={selected!.workspaceId} statistics={statistics} active={visible && watchReady && section === 'task' && mode === 'stages'} readOnly={readOnlyProject} sessionActivity={sessionActivity} archivedSessionIds={archivedSessionIds} t={t} openExecutor={openExecutor} stopGenerating={stopGenerating} archiveChat={archiveChat} />
            </div>)}
          </div>
          {project?.prepared && !readingState && mode === 'materials' && selected && <div id={`${modeId}-materials-panel`} role="tabpanel" aria-labelledby={`${modeId}-materials`}>
            <MaterialsBrowser active={visible && section === 'task'} key={viewKey} workspaceId={selected.workspaceId} task={viewedTask ?? null}
              canDelete={Boolean(canManageTask && !taskRunning)} busy={operation !== 'idle'}
              deleteArtifacts={stepId => executeMutation('delete-materials', workspaceId => deleteStepMaterials(workspaceId, viewedTask!.id, stepId))} initialGroup={view.key === viewKey ? view.group : null}
              refresh={refresh + artifactRevision} workspaceTitle={selected.title} resetScroll={resetScroll} t={
                t} loadMaterials={loadMaterials} openMaterial={openMaterial} />
          </div>}
        </div>
        {/* Keep the editor mounted while refreshing the retained project snapshot. */}
        {project?.prepared && section === 'settings' && selected && <div id={`${sectionId}-settings-panel`} role="region" aria-label={t('settings')}>
          {allTasks.length === 0 && project.creationIssue && <p role="status" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{messageText(t, project.creationIssueMessage, project.creationIssue)}</p>}
          <ProcessSettings t={t} key={selected.workspaceId} workspaceId={selected.workspaceId} externalRevision={settingsRevision} back={<Button variant="outline" disabled={settingsDirty || operation !== 'idle' || (allTasks.length === 0 && Boolean(project.creationIssue))} onClick={() => setSection('task')}
            icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8H3m5-5L3 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}>
            {t(snapshot?.kind === 'empty' && allTasks.length === 0 ? 'createFirstTask' : 'backToCurrentTask')}
          </Button>} projectRules={() => { const workspaceId = selected.workspaceId; setOperationError(null)
            void openProjectRules(workspaceId, selected.title).catch(error => setOperationError({ projectId: workspaceId, message:
             notice(error) })) }} load={loadSettings} save={saveProcess} saveRole={
            saveRole} deleteRole={deleteRole} modelCatalog={modelCatalog} dirtyChanged={setSettingsDirty}
          saved={() => requestProjectRead.current?.()} />
        </div>}
      </div>
    </section>
  </div>
}
// END_METHOD_AicraftPanel
