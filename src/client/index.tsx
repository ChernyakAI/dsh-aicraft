import { AMBIGUOUS_TASKS_MESSAGE } from '../types.ts'
import { InitializeProject } from './initialize-project.tsx'
import type { ProcessTemplateLanguage } from '../types.ts'
import { createRoot } from 'react-dom/client'
import { ExecutionStatistics } from './execution-statistics.tsx'
import { ProcessSettings } from './process-settings.tsx'
import { mountMaterialEditors, TaskRequestDialog } from './material-editor.tsx'
import type { Context } from '@deepseek-ai/cordis'
import { Button, SegmentedControl, FileTypeIcon, classifyFileType, Menu, Modal, IconQueueOutlineRegular, IconSettingsOutlineRegular, IconArchiveOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconRefreshOutlineRegular, IconWarningTriangleOutlineRegular, IconListPenOutlineRegular, IconCheckCircleOutlineRegular, IconStopFillRegular, IconEllipsisOutlineRegular, IconClockOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { InitializeProjectRequest, CreateTaskRequest, ProjectPresence, ProjectView, RunModel, RunView, TaskView, StepView, MaterialGroup, MaterialDocument, ProjectSettings, ProcessDefinition, ProcessDocument, RoleDocument, ExecutionStatistics as Statistics, ProjectChange, SessionActivity } from 'dsh-aicraft/types'
import remote from '../../lib/typert.remote-client.js'

const en = {
  panel: 'AICraft',
  subtitle: 'Manage your project tasks with a team of AI agents.',
  project: 'Project',
  projectPath: 'Project path',
  chooseProject: 'Select a DSH project',
  noTask: 'This project has no open task.',
  loadingTask: 'Reading current state',
  loadFailed: 'Could not read the project. Try again.',
  ambiguous: AMBIGUOUS_TASKS_MESSAGE,
  invalid: 'Task state is invalid. Correct the project files and refresh.',
  task: 'Current task', taskPicker: 'Task', chooseTask: 'Select a task', openTask: 'Open',
  process: 'Process',
  step: 'Step',
  editor: 'Editor', preview: 'Preview', editorMode: 'Document mode', save: 'Save', saved: 'Saved', reload: 'Reload', readOnly: 'Read only', closeMaterial: 'Close artifact', materialWindow: 'Artifact', markdownSource: 'Markdown source', discardClosePrompt: 'Discard unsaved changes and close?', discardReloadPrompt: 'Reload the file and discard your changes?', discardChanges: 'Discard changes', keepEditing: 'Keep editing',
  settings: 'Project settings', currentTaskSection: 'Current task', backToCurrentTask: 'Back to current task', createFirstTask: 'Create first task',
  stages: 'Steps', materials: 'Artifacts', views: 'Project views', stageMaterials: 'Step artifacts', deleteStepMaterials: 'Delete step artifacts', backMaterials: 'Back to artifacts', allMaterials: 'All artifacts', noMaterials: 'No artifacts yet.', loadingMaterials: 'Reading artifacts…', loadingDocument: 'Reading document…', copy: 'Copy', copied: 'Copied', footnotes: 'Footnotes', retry: 'Retry',
  role: 'Role', modelColumn: 'Model', stepActions: 'Actions for {step}',
  stepStatus: 'Status',
  pending: 'Pending',
  running: 'In progress',
  completed: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled', currentStage: 'Current',
  refresh: 'Refresh task',
  branch: 'Current branch', createdBranch: 'Branch for task',
  prepare: 'Prepare AICraft project', initProject: 'Init new AICraft project',
  preparing: 'Preparing project…',
  create: 'Create task',
  creating: 'Creating task…',
  title: 'Task title',
  requirements: 'Requirements and acceptance criteria',
  creationBlocked: 'Task creation is unavailable',
  actions: 'Actions',
  goToStep: 'Go to this step', returnTo: 'Return to...', returnStep: 'Return to step', returnTarget: 'Step',
  setStepModel: 'Set step model', showStepPrompt: 'Input prompt', runStep: 'Run', runStepWithModel: 'Run with model', chooseModel: 'Select a model', loadingModels: 'Loading models…', cancel: 'Cancel', close: 'Close',
  completeStep: 'Complete', skipStep: 'Skip',
  closeTask: 'Finish task', reopenTask: 'Reopen Task', finishPrompt: 'Finish this task? It will be marked as completed. Artifacts and chat history will be kept.',
  savedModelHint: 'Saves the model for future runs of this step in this task.', runModelHint: 'Uses the selected model for this run only. The saved step model stays unchanged.',
  saving: 'Saving…',
  model: 'Executor model', stopGenerating: 'Stop generating', archiveChat: 'Archive chat', stopPrompt: 'Stop generation in this chat?', archivePrompt: 'Archive this chat? Any active generation will be stopped. The chat will disappear from AICraft.',
  showMoreChats: 'Show more chats', runHistory: 'Run history', openRun: 'Open executor chat', starting: 'Starting', interrupted: 'Interrupted', runFailed: 'Failed', results: 'Results',
}
const zh: typeof en = {
  panel: 'AICraft',
  subtitle: '与 AI 智能体团队协作处理项目任务。',
  project: '项目', projectPath: '项目路径', chooseProject: '选择 DSH 项目', noTask: '此项目没有未关闭的任务。',
  loadingTask: '正在读取任务状态…', loadFailed: '无法读取项目，请重试。',
  ambiguous: '每个分支最多只能有一个未关闭的任务。当前：',
  invalid: '任务状态无效，请修正项目文件后刷新。', task: '当前任务', taskPicker: '任务', chooseTask: '选择任务', openTask: '未关闭',
  editor: '编辑', preview: '预览', editorMode: '文档模式', save: '保存', saved: '已保存', reload: '重新加载', readOnly: '只读', closeMaterial: '关闭产物', materialWindow: '产物', markdownSource: 'Markdown 源码', discardClosePrompt: '放弃未保存更改并关闭？', discardReloadPrompt: '重新加载并放弃更改？', discardChanges: '放弃更改', keepEditing: '继续编辑',
  settings: '项目设置', currentTaskSection: '当前任务', backToCurrentTask: '返回当前任务', createFirstTask: '创建首个任务',
  stages: '步骤', materials: '产物', views: '项目视图', stageMaterials: '步骤产物', deleteStepMaterials: '删除步骤产物', backMaterials: '返回产物', allMaterials: '全部产物', noMaterials: '暂无文档。', loadingMaterials: '正在读取产物…', loadingDocument: '正在读取文档…', copy: '复制', copied: '已复制', footnotes: '脚注', retry: '重试',
  process: '流程', step: '步骤', role: '角色', modelColumn: '模型', stepActions: '{step}的操作', stepStatus: '状态',
  setStepModel: '设置步骤模型', showStepPrompt: '输入提示词', runStep: '执行', runStepWithModel: '选择模型执行', chooseModel: '选择模型', loadingModels: '正在加载模型…', cancel: '取消', close: '关闭',
  pending: '待处理', running: '进行中', completed: '已完成', skipped: '已跳过', cancelled: '已取消', currentStage: '当前', refresh: '刷新任务',
  branch: '当前分支', createdBranch: '创建分支', prepare: '准备 AICraft 项目', initProject: '初始化 AICraft 项目', preparing: '正在准备项目…',
  create: '创建任务', creating: '正在创建任务…', title: '任务标题',
  requirements: '需求和验收条件', creationBlocked: '无法创建任务',
  actions: '操作', goToStep: '转到此步骤', returnTo: '返回到…', returnStep: '返回步骤', returnTarget: '步骤', completeStep: '完成', skipStep: '跳过', closeTask: '结束任务', reopenTask: '重新打开任务', finishPrompt: '结束此任务？任务将标记为已完成，产物和聊天记录将保留。', savedModelHint: '保存此任务中该步骤后续执行使用的模型。', runModelHint: '仅本次执行使用所选模型，不更改已保存的步骤模型。', saving: '正在保存…',
  model: '执行器模型', stopGenerating: '停止生成', archiveChat: '归档聊天', stopPrompt: '停止此聊天中的生成？', archivePrompt: '归档此聊天？正在生成的内容将停止，聊天将从 AICraft 中隐藏。',
  showMoreChats: '显示更多聊天', runHistory: '执行记录', openRun: '打开执行器聊天', starting: '启动中', interrupted: '已中断', runFailed: '失败', results: '结果',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** AICraft panel interface copy. */
    aicraft: keyof typeof en
  }
}

interface PanelFace {
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
  createTask(workspaceId: string, request: CreateTaskRequest): Promise<ProjectView>
  goToStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>
  returnStep(workspaceId: string, taskId: string, fromStepId: string, stepId: string): Promise<ProjectView>
  skipStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>
  setStepModel(workspaceId: string, taskId: string, stepId: string, model: RunModel): Promise<ProjectView>
  deleteStepMaterials(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>
  completeStep(workspaceId: string, taskId: string, stepId: string): Promise<ProjectView>
  reopenTask(workspaceId: string, taskId: string): Promise<ProjectView>
  closeTask(workspaceId: string, taskId: string): Promise<ProjectView>
  startStep(workspaceId: string, taskId: string, stepId: string, model: RunModel | null): Promise<RunView>
  loadMaterials(workspaceId: string, taskId: string | null, signal: AbortSignal): Promise<MaterialGroup[]>
  loadMaterial(workspaceId: string, path: string, signal: AbortSignal): Promise<MaterialDocument>
  saveMaterial(workspaceId: string, path: string, text: string, version: string, signal: AbortSignal): Promise<MaterialDocument>
  showStepPrompt(workspaceId: string, workspaceTitle: string, taskId: string, stepId: string): Promise<void>
  openProjectRules(workspaceId: string, workspaceTitle: string): Promise<void>
  openMaterial(workspaceId: string, workspaceTitle: string, path: string): void
  loadSettings(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings>
  saveProcess(workspaceId: string, id: string, definition: ProcessDefinition, version: string | null, templateLanguage: ProcessTemplateLanguage | null): Promise<ProcessDocument>
  saveRole(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>
  deleteRole(workspaceId: string, id: string, version: string): Promise<void>
  modelCatalog(): Promise<ModelCatalog>
  stopGenerating(sessionId: string): Promise<void>
  archiveChat(sessionId: string): Promise<void>
  openExecutor(sessionId: string): void
}
type PanelProps = PropsRuntime<'main'> & PropsLocale<'aicraft'> & InjectFace<PanelFace> & { sessionId?: SessionId; visible: boolean }
type Operation = 'prepare' | 'create' | 'goto' | 'return' | 'skip' | 'complete' | 'close' | 'reopen' | 'start' | 'prompt' | 'delete-materials' | 'set-model'

/**
 * Render project controls and show the server connection error only on failure.
 * @param props - Slot-owned translations and server operation.
 * @returns The AICraft panel.
 */
function AicraftPanel({ t, checkConnection, loadProjects, loadProject, followProject, statistics, prepareProject, createTask, goToStep, returnStep, skipStep, completeStep, closeTask, reopenTask, startStep, loadMaterials, loadMaterial, saveMaterial, setStepModel, deleteStepMaterials, openMaterial, openProjectRules, showStepPrompt, modelCatalog, loadSettings, saveProcess, saveRole, deleteRole, openExecutor, stopGenerating, archiveChat, useWorkspaces, sessionId, visible }: PanelProps): ReactNode {
  const workspaces: readonly WorkspaceView[] = useWorkspaces((snapshot: WorkspaceSnapshot) => snapshot.items)
  const archivedSessionIds = useWorkspaces((snapshot: WorkspaceSnapshot) => snapshot.archivedSessionIds)
  const [requestDialog, setRequestDialog] = useState<{ workspaceId: string; workspaceTitle: string; taskId: string; taskTitle: string } | null>(null)
  const [initializingProjectId, setInitializingProjectId] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  useEffect(() => {
    if (projectId !== null || sessionId === undefined) return
    const currentProject = workspaces.find(project => project.sessionIds.includes(sessionId))
    if (currentProject) setProjectId(currentProject.workspaceId)
  }, [projectId, sessionId, workspaces])
  const [creatingTaskProjectId, setCreatingTaskProjectId] = useState<string | null>(null)
  const [finishingTask, setFinishingTask] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [artifactRevision, setArtifactRevision] = useState(0)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivity & { completed: string }>>({})
  const [projectPresence, setProjectPresence] = useState<ProjectPresence[]>([])
  const [projectsError, setProjectsError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void loadProjects(controller.signal).then(
      value => { if (!controller.signal.aborted) { setProjectPresence(value); setProjectsError(null) } },
      error => { if (!controller.signal.aborted) setProjectsError(error instanceof Error ? error.message : String(error)) },
    )
    return () => controller.abort()
  }, [loadProjects, workspaces, refresh])

  const [projectSnapshot, setSnapshot] = useState<ProjectView | null>(null)
  const [snapshotProjectId, setSnapshotProjectId] = useState('')
  const [taskPhase, setTaskPhase] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const selected = workspaces.find(project => project.workspaceId === projectId)
  const project = selected?.workspaceId === snapshotProjectId ? projectSnapshot : null
  const readingState = Boolean(selected && (taskPhase === 'loading' || (!project && taskPhase !== 'failed')))
  const snapshot = project?.task
  const [taskSelection, setTaskSelection] = useState<{ workspaceId: string; taskId: string } | null>(null)
  const allTasks = snapshot?.allTasks ?? []
  const viewedTask = (taskSelection?.workspaceId === selected?.workspaceId ? allTasks.find(task => task.id === taskSelection?.taskId) : undefined)
    ?? snapshot?.tasks[0] ?? allTasks[0]
  const isRunRunning = (run: RunView) => sessionActivity[run.sessionId]?.running ?? ['starting', 'running'].includes(run.status)
  const taskRunning = viewedTask?.runs.some(isRunRunning) ?? false
  const canManageTask = snapshot?.kind === 'task' && viewedTask?.id === snapshot.tasks[0]?.id
  const readOnlyProject = snapshot?.kind === 'ambiguous'
  const blockedStepActions = readOnlyProject || snapshot?.kind === 'invalid'
  useEffect(() => {
    if (selected && project) window.dispatchEvent(new CustomEvent('aicraft:project-readonly', { detail: { workspaceId: selected.workspaceId, readOnly: readOnlyProject } }))
  }, [selected?.workspaceId, Boolean(project), readOnlyProject])
  const scrollRef = useRef<HTMLDivElement>(null)
  const resetScroll = useCallback(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [])
  const sectionId = useId()
  const [section, setSection] = useState<'task' | 'settings'>('task')
  useEffect(() => {
    const controller = new AbortController()
    const saved = (event: Event) => {
      if ((event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId !== projectId || !projectId) return
      if (section !== 'settings') { setRefresh(value => value + 1); return }
      void loadProject(projectId, controller.signal).then(value => {
        if (!controller.signal.aborted) { setSnapshotProjectId(projectId); setSnapshot(value) }
      }, error => { if (!controller.signal.aborted) setConnectionError(String(error)) })
    }
    window.addEventListener('aicraft:material-saved', saved)
    return () => { controller.abort(); window.removeEventListener('aicraft:material-saved', saved) }
  }, [projectId, section, loadProject])

  const modeId = useId()
  const viewKey = `${selected?.workspaceId ?? ''}:${viewedTask?.id ?? ''}`
  const [view, setView] = useState<{ key: string; mode: 'stages' | 'materials'; group: string | null }>({ key: '', mode: 'stages', group: null })
  const [settingsDirty, setSettingsDirty] = useState(false)
  const mode = view.mode
  useEffect(resetScroll, [section, mode, selected?.workspaceId, viewedTask?.id, resetScroll])
  const showStageMaterials = (stepId: string) => setView({ key: viewKey, mode: 'materials', group: `step:${stepId}` })
  const [operation, setOperation] = useState<'idle' | Operation>('idle')
  const [operationError, setOperationError] = useState<{ projectId: string; message: string } | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void checkConnection().then(
      () => { if (active) setConnectionError(null) },
      error => { if (active) setConnectionError(error instanceof Error ? error.message : String(error)) },
    )
    return () => { active = false }
  }, [checkConnection, refresh])
  useEffect(() => {
    const controller = new AbortController()
    if (!visible) return () => controller.abort()
    if (!selected) { setSnapshot(null); setTaskPhase('idle'); return () => controller.abort() }
    setTaskPhase('loading')
    void loadProject(selected.workspaceId, controller.signal).then(
      value => { if (!controller.signal.aborted) { setSnapshotProjectId(selected.workspaceId); setSnapshot(value); setTaskPhase('ready') } },
      () => { if (!controller.signal.aborted) setTaskPhase('failed') },
    )
    return () => controller.abort()
  }, [selected?.workspaceId, loadProject, refresh, visible])
  const hasActiveRun = allTasks.some(task => task.runs.some(isRunRunning))
  const [watchError, setWatchError] = useState('')
  const [watchReady, setWatchReady] = useState(false)
  useEffect(() => { setSessionActivity({}) }, [selected?.workspaceId, viewedTask?.id])
  useEffect(() => {
    setWatchReady(false)
    if (!selected || !project || !visible || operation !== 'idle') return
    const workspaceId = selected.workspaceId, taskId = viewedTask?.id ?? null
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const frame of followProject(workspaceId, taskId, controller.signal)) {
          if (controller.signal.aborted) return
          const artifactPath = (path: string) => path.startsWith('.aicraft/knowledge-base')
            || (taskId !== null && new RegExp(`^\\.aicraft/tasks/${taskId}/[a-z][a-z0-9-]*(?:/|$)`).test(path))
          const projectChanged = frame.kind === 'ready' || frame.paths.some(path => !path.startsWith('$git/') && !artifactPath(path))
          if (projectChanged) {
            const value = await loadProject(workspaceId, controller.signal)
            if (controller.signal.aborted) return
            setSnapshotProjectId(workspaceId); setSnapshot(value); setTaskPhase('ready')
          }
          if (frame.branch !== undefined) setSnapshot(previous => previous && ({ ...previous, branch: frame.branch! }))
          if (frame.counts.length) setSnapshot(previous => {
            if (!previous) return previous
            const update = (task: TaskView) => ({ ...task, steps: task.steps.map(step => {
              const count = frame.counts.find(value => value.taskId === task.id && value.stepId === step.id)
              return count ? { ...step, artifactCount: count.count, artifactIssue: count.issue } : step
            }) })
            return { ...previous, task: { ...previous.task, tasks: previous.task.tasks.map(update), allTasks: previous.task.allTasks.map(update) } }
          })
          if (frame.kind === 'ready' || frame.paths.some(artifactPath) || projectChanged) setArtifactRevision(value => value + 1)
          if (frame.kind === 'ready' || frame.paths.some(path => path.startsWith('.aicraft/config/') || path === '.aicraft/project-rules.md' || path === '.aicraft/agent-rules.md')) setSettingsRevision(value => value + 1)
          if (frame.sessions.length) setSessionActivity(previous => {
            const next = { ...previous }
            for (const activity of frame.sessions) next[activity.id] = { ...activity, completed: activity.running ? previous[activity.id]?.completed ?? '' : activity.revision }
            return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
          })
          setWatchError(''); setWatchReady(true)
        }
      } catch (error) {
        if (!controller.signal.aborted) setWatchError(`Automatic updates unavailable. Use Refresh task. ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return () => controller.abort()
  }, [selected?.workspaceId, viewedTask?.id, Boolean(project), visible, operation, followProject, loadProject, refresh])
  const executeMutation = async (kind: Operation, call: (workspaceId: string) => Promise<ProjectView>, succeeded?: () => void): Promise<void> => {
    if (!selected || operation !== 'idle') return
    const workspaceId = selected.workspaceId
    setOperation(kind)
    setOperationError(null)
    try {
      const value = await call(workspaceId)
      setSnapshotProjectId(workspaceId)
      setSnapshot(value)
      if (kind === 'close' || kind === 'reopen') setTaskSelection({ workspaceId, taskId: viewedTask!.id })
      if (kind === 'create') setCreatingTaskProjectId(null)
      if (kind === 'create' && value.task.tasks[0]) setTaskSelection({ workspaceId, taskId: value.task.tasks[0].id })
      setProjectPresence(items => [...items.filter(item => item.workspaceId !== workspaceId), { workspaceId, hasAicraft: value.prepared }])
      succeeded?.()
    } catch (error) {
      setOperationError({ projectId: workspaceId, message: error instanceof Error ? error.message : String(error) })
      if (kind !== 'create') setRefresh(value => value + 1)
    } finally {
      setOperation('idle')
    }
  }
  const mutate = (kind: 'create', request: CreateTaskRequest): Promise<void> =>
    executeMutation(kind, workspaceId => createTask(workspaceId, request))
  const mutateTask = (kind: 'goto' | 'skip' | 'complete' | 'close', taskId: string, stepId?: string): Promise<void> =>
    executeMutation(kind, workspaceId => kind === 'close' ? closeTask(workspaceId, taskId)
      : kind === 'goto' ? goToStep(workspaceId, taskId, stepId!) : kind === 'skip' ? skipStep(workspaceId, taskId, stepId!) : completeStep(workspaceId, taskId, stepId!))
  const needsInitialization = project && (!project.prepared || project.processes.length === 0)
  const initializing = selected?.workspaceId === initializingProjectId
  const taskPath = viewedTask ? `.aicraft/tasks/${viewedTask.id}` : null
  const taskBranch = viewedTask?.createdBranch
  const branchMismatch = Boolean(section === 'task' && project?.branch && taskBranch && taskBranch !== project.branch)
  return <div ref={scrollRef} style={{ flex: '1 1 0', minHeight: 0, width: '100%', overflowY: 'auto' }}>
    <section style={{ padding: 20, width: '100%', boxSizing: 'border-box' }} aria-label="AICraft">
    <style>{'.aicraft-destructive-confirm { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background: var(--dsw-alias-interactive-bg-hover-danger); } .aicraft-destructive-confirm:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); } .aicraft-destructive-confirm:active:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 24%, transparent); } .aicraft-step-menu [role="separator"] { height: 1px; min-height: 1px; flex-shrink: 0; background: var(--dsw-alias-border-l3); } section[aria-label="AICraft"] .aicraft-init-project { background: var(--dsw-alias-interactive-bg-hover); border: 1px solid var(--dsw-alias-border-l3); transition: background-color 100ms, filter 100ms; } section[aria-label="AICraft"] .aicraft-init-project:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); } section[aria-label="AICraft"] .aicraft-init-project:active:not(:disabled) { filter: brightness(0.95); } .aicraft-task-menu > [role="presentation"] { max-height: 260px; overflow-y: auto; } .aicraft-task-menu [role="menuitem"] { height: 52px; box-sizing: border-box; }'}</style>
    <style>{'.aicraft-task-action { border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover); box-shadow: 0 1px 2px #0000000c; transition: background-color 120ms, box-shadow 120ms, transform 80ms; } .aicraft-task-action:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); box-shadow: 0 2px 4px #00000014; } .aicraft-task-action:active:not(:disabled) { transform: translateY(1px); box-shadow: none; }'}</style>
    {requestDialog && <TaskRequestDialog key={JSON.stringify([requestDialog.workspaceId, requestDialog.taskId])} {...requestDialog} t={t} load={loadMaterial} save={saveMaterial} close={() => setRequestDialog(null)} />}
    {watchError && <p role="alert">{watchError}</p>}
    {connectionError !== null && <p role="alert" style={{ color: '#dc4545', margin: '0 0 16px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{connectionError}</p>}
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label htmlFor="aicraft-project" style={{ flex: '0 0 56px', whiteSpace: 'nowrap' }}>{t('project')}:</label>
        <ProjectPicker projects={workspaces} presence={projectPresence} selectedId={projectId ?? ''} busy={operation !== 'idle' || settingsDirty} t={t} select={setProjectId} />
        {readingState && <span role="status" style={{ display: 'flex', alignItems: 'center', minHeight: 40, fontSize: 12, opacity: 0.65, whiteSpace: 'nowrap' }}>{t('loadingTask')}</span>}
        {selected && project?.prepared && !needsInitialization && !readingState && <Button variant="ghost" title={t('settings')} aria-label={t('settings')} disabled={readOnlyProject || operation !== 'idle'}
          onClick={() => setSection('settings')} style={{ flex: '0 0 40px', width: 40, height: 40, border: '1px solid #8090a060', borderRadius: 7, padding: 0 }}>
          <IconSettingsOutlineRegular size={18} />
        </Button>}
        {selected && <span title={`${t('projectPath')}: ${selected.path}`} style={{ flex: '1 1 180px', minWidth: 0, fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('projectPath')}: {selected.path}</span>}
        {selected && project && !readingState && needsInitialization && !initializing && <Button variant="ghost" className="aicraft-init-project" disabled={operation !== 'idle' || taskPhase === 'loading'} onClick={() => setInitializingProjectId(selected.workspaceId)}
          style={{ height: 40, borderRadius: 7, whiteSpace: 'nowrap' }}>{t(operation === 'prepare' ? 'preparing' : 'initProject')}</Button>}
      </div>
      <hr style={{ border: 0, borderTop: '1px solid #8090a040', margin: '14px 0' }} />
      {projectsError !== null && <p role="alert">{projectsError}</p>}
      {taskPhase === 'failed' && <p role="alert">{t('loadFailed')}</p>}
      {operationError?.projectId === selected?.workspaceId && <p role="alert">{operationError?.message}</p>}
      {selected && initializing && <InitializeProject key={selected.workspaceId} busy={operation === 'prepare'} dirtyChanged={setSettingsDirty}
        cancel={() => setInitializingProjectId(null)} submit={request => executeMutation('prepare', workspaceId => prepareProject(workspaceId, request), () => { setInitializingProjectId(null); setSection('settings'); setView({ key: `${selected.workspaceId}:`, mode: 'stages', group: null }) })} />}
      <div id={`${sectionId}-task-panel`} role="region" aria-label={t('currentTaskSection')} hidden={section !== 'task' || initializing}>
      {selected && project?.prepared && !readingState && <><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span style={{ flex: '0 0 56px', whiteSpace: 'nowrap' }}>{t('taskPicker')}:</span>
        <TaskPicker tasks={allTasks} selectedId={viewedTask?.id ?? ''} busy={operation !== 'idle' || taskPhase === 'loading' || settingsDirty} t={t}
          create={() => setCreatingTaskProjectId(selected.workspaceId)} canCreate={snapshot?.kind === 'empty' && !project.creationIssue}
          select={taskId => setTaskSelection({ workspaceId: selected.workspaceId, taskId })} />
        {viewedTask && <Button type="button" variant="outline" title="Task request" aria-label="Task request" disabled={readOnlyProject || operation !== 'idle' || settingsDirty}
          onClick={() => setRequestDialog({ workspaceId: selected.workspaceId, workspaceTitle: selected.title, taskId: viewedTask.id, taskTitle: viewedTask.title })}
          style={{ flex: '0 0 40px', width: 40, height: 40, padding: 0, borderRadius: 7 }}><IconListPenOutlineRegular size={18} /></Button>}
        {selected && !readingState && allTasks.length > 0 && <button type="button" title={t('refresh')} aria-label={t('refresh')} disabled={taskPhase === 'loading' || operation !== 'idle' || settingsDirty}
          onClick={() => setRefresh(value => value + 1)}
          style={{ flex: '0 0 40px', width: 40, height: 40, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #8090a060', borderRadius: 7, background: 'transparent', color: 'inherit' }}>
          <IconRefreshOutlineRegular size={18} />
        </button>}
        {taskPath && <span title={`Task path: ${taskPath}`} style={{ flex: '1 1 180px', minWidth: 0, fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Task path: {taskPath}</span>}
      </div>
        {project?.branch && <p role={branchMismatch ? 'status' : undefined} style={{ margin: '8px 0 0', minWidth: 0, fontSize: 12, lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, opacity: branchMismatch ? 1 : 0.65, color: branchMismatch ? '#dc2626' : ['master', 'main'].includes(project.branch) ? '#ad6262' : 'inherit' }}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t('branch')}: {project.branch}</span>
          {branchMismatch && <>
            <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}><IconWarningTriangleOutlineRegular size={14} /></span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t('createdBranch')}: {taskBranch}</span>
          </>}
        </p>}
      </>}
      {project?.prepared && !readingState && <div style={{ maxWidth: 300, margin: '14px 0' }}>
        <SegmentedControl id={modeId} value={mode} label={t('views')} disabled={settingsDirty || operation !== 'idle'}
          options={[{ value: 'stages', label: t('stages') }, { value: 'materials', label: t('materials') }]}
          onChange={next => setView({ key: viewKey, mode: next, group: null })} />
      </div>}
      <div id={`${modeId}-stages-panel`} role="tabpanel" aria-labelledby={`${modeId}-stages`} hidden={mode !== 'stages'}>
      {project?.prepared && snapshot?.kind === 'empty' && !viewedTask && <p>{t('noTask')}</p>}
      {project?.prepared && snapshot?.kind === 'empty' && !viewedTask && <>
        {project.creationIssue ? <p>{t('creationBlocked')}: {project.creationIssue}</p>
          : <CreateTaskForm key={projectId} project={project} busy={operation === 'create'} t={t} submit={request => mutate('create', request)} />}
      </>}
      {project?.prepared && viewedTask && creatingTaskProjectId === selected?.workspaceId && <Modal open title={t('create')} closeLabel={t('close')} onClose={() => { if (operation === 'idle') setCreatingTaskProjectId(null) }}>
        {operationError?.projectId === selected?.workspaceId && <p role="alert">{operationError.message}</p>}
        {snapshot?.kind === 'empty' && !project.creationIssue
          ? <CreateTaskForm key={projectId} project={project} busy={operation !== 'idle'} t={t} submit={request => mutate('create', request)} />
          : <p>{project.creationIssue ?? t('creationBlocked')}</p>}
      </Modal>}
      {(snapshot?.kind === 'invalid' || snapshot?.kind === 'ambiguous') && <div role="alert">
        <p>{t(snapshot.kind)}</p>
        <ul>{snapshot.issues.map(issue => <li key={issue}>{issue}</li>)}{snapshot.tasks.map(task => <li key={task.id}>{task.title}</li>)}</ul>
      </div>}
      {viewedTask && [viewedTask].map(task => <div key={task.id} style={{ marginTop: 24 }}>
        <div style={{ border: '1px solid #8090a030', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
          <thead style={{ background: '#8090a00c' }}><tr>
            <th aria-label={t('stepStatus')} style={{ width: 30 }} />
            {[t('step'), t('role'), t('modelColumn'), t('materials'), t('actions')].map(label => <th key={label} style={{ padding: '10px', fontWeight: 500, opacity: 0.7 }}>{label}</th>)}
          </tr></thead>
          <tbody>{task.steps.map(step => <tr key={step.id} style={{ borderTop: '1px solid #8090a030', background: step.status === 'current' ? '#3b82f60a' : 'transparent' }}>
            <td style={{ padding: '8px 10px', verticalAlign: 'middle' }}>
              <Tooltip label={t(step.status === 'current' ? 'currentStage' : step.status === 'done' ? 'completed' : step.status)} portal>
                <span role="img" tabIndex={0} aria-label={`${step.title}: ${t(step.status === 'current' ? 'currentStage' : step.status === 'done' ? 'completed' : step.status)}`} data-step-status={step.status}
                  style={{ display: 'flex', width: 16, height: 16, color: { done: '#22a06b', pending: '#e8b45d', current: '#3b82f6', skipped: '#8b9098', cancelled: '#e9a0a0' }[step.status] }}>
                  <StepStatusIcon status={step.status} />
                </span>
              </Tooltip>
            </td>
            <td style={{ padding: '8px 10px', fontWeight: 600 }}>{step.title}</td>
            <td style={{ padding: '8px 10px', overflowWrap: 'anywhere' }}>{step.role}</td>
            <td style={{ padding: '8px 10px', fontSize: 12, opacity: 0.65, overflowWrap: 'anywhere' }}>
              {modelLabel(step.model)}
            </td>
            <td style={{ padding: '8px 10px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
              {step.artifactCount !== 0 && <Button type="button" variant="ghost" size="sm" disabled={operation !== 'idle'}
                aria-label={`${t('stageMaterials')}: ${step.title}`} title={step.artifactIssue ?? `${t('stageMaterials')}: ${step.title}`}
                onClick={() => showStageMaterials(step.id)} style={{ padding: '0 4px', height: 'auto', minHeight: 0, color: 'var(--dsw-alias-link)', textDecoration: 'underline', fontSize: 'inherit' }}>
                {step.artifactCount ?? '?'}
              </Button>}
            </td>
            <td style={{ padding: '8px 10px', width: 40 }}>
              <StepActions step={step} previousSteps={task.steps.slice(0, task.steps.findIndex(item => item.id === step.id)).filter(item => item.status !== 'cancelled')}
                returnTo={stepId => executeMutation('return', workspaceId => returnStep(workspaceId, task.id, step.id, stepId))} current={task.currentStep === step.id && step.status === 'current'} blocked={blockedStepActions}
                disabled={!canManageTask || operation !== 'idle' || taskRunning} busy={operation !== 'idle'} t={t}
                prompt={() => { void executeMutation('prompt', async workspaceId => { await showStepPrompt(workspaceId, selected!.title, task.id, step.id); return loadProject(workspaceId, new AbortController().signal) }) }}
                run={() => { void executeMutation('start', async workspaceId => { await startStep(workspaceId, task.id, step.id, null); return loadProject(workspaceId, new AbortController().signal) }) }}
                modelCatalog={modelCatalog}
                setModel={model => executeMutation('set-model', workspaceId => setStepModel(workspaceId, task.id, step.id, model))}
                runWithModel={model => { void executeMutation('start', async workspaceId => { await startStep(workspaceId, task.id, step.id, model); return loadProject(workspaceId, new AbortController().signal) }) }}
                select={kind => { void mutateTask(kind, task.id, step.id) }} />
            </td>
          </tr>)}</tbody>
        </table>
        </div>
        {finishingTask === task.id && <Modal open title={t('closeTask')} description={task.title} closeLabel={t('close')}
          onClose={() => { if (operation === 'idle') setFinishingTask(null) }}>
          <p>{t('finishPrompt')}</p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" disabled={operation !== 'idle'} onClick={() => setFinishingTask(null)}>{t('cancel')}</Button>
            <Button variant="outline" disabled={!canManageTask || operation !== 'idle' || taskRunning}
              onClick={() => { void mutateTask('close', task.id).then(() => setFinishingTask(null)) }}>{t('closeTask')}</Button>
          </div>
        </Modal>}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
        <ExecutionStatistics key={`${selected!.workspaceId}:${task.id}`} title="Task totals" workspaceId={selected!.workspaceId} taskId={task.id} sessionId={null}
          active={visible && watchReady && section === 'task' && mode === 'stages'} revision={JSON.stringify([task.runs.filter(run => !['starting', 'running'].includes(run.status)).map(run => [run.id, run.finishedAt]), Object.values(sessionActivity).filter(item => item.completed).map(item => [item.id, item.completed])])} load={statistics} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
            {operation !== 'idle' && <span role="status">{t('saving')}</span>}
            <Button type="button" variant="outline" className="aicraft-task-action" disabled={!canManageTask || operation !== 'idle' || taskRunning} onClick={() => setFinishingTask(task.id)}>{t('closeTask')}</Button>
            {task.status !== 'open' && <Button type="button" variant="outline" className="aicraft-task-action" disabled={snapshot?.kind !== 'empty' || operation !== 'idle' || hasActiveRun}
              onClick={() => { void executeMutation('reopen', workspaceId => reopenTask(workspaceId, task.id)) }}>{t('reopenTask')}</Button>}
          </div>
        </div>
        <RunHistory task={task} workspaceId={selected!.workspaceId} statistics={statistics} active={visible && watchReady && section === 'task' && mode === 'stages'} readOnly={readOnlyProject} sessionActivity={sessionActivity} archivedSessionIds={archivedSessionIds} t={t} openExecutor={openExecutor} stopGenerating={stopGenerating} archiveChat={archiveChat} />
      </div>)}
      </div>
      {project?.prepared && !readingState && mode === 'materials' && selected && <div id={`${modeId}-materials-panel`} role="tabpanel" aria-labelledby={`${modeId}-materials`}>
        <MaterialsBrowser active={visible && section === 'task'} key={viewKey} workspaceId={selected.workspaceId} task={viewedTask ?? null}
          canDelete={Boolean(canManageTask && !taskRunning)} busy={operation !== 'idle'}
          deleteArtifacts={stepId => executeMutation('delete-materials', workspaceId => deleteStepMaterials(workspaceId, viewedTask!.id, stepId))} initialGroup={view.key === viewKey ? view.group : null}
          refresh={refresh + artifactRevision} workspaceTitle={selected.title} resetScroll={resetScroll} t={t} loadMaterials={loadMaterials} openMaterial={openMaterial} />
      </div>}
      </div>
      {/* Keep the editor mounted while refreshing the retained project snapshot. */}
      {project?.prepared && section === 'settings' && selected && <div id={`${sectionId}-settings-panel`} role="region" aria-label={t('settings')}>
        {allTasks.length === 0 && project.creationIssue && <p role="status">{project.creationIssue}</p>}
        <ProcessSettings key={selected.workspaceId} workspaceId={selected.workspaceId} externalRevision={settingsRevision} back={<Button variant="outline" disabled={settingsDirty || operation !== 'idle' || (allTasks.length === 0 && Boolean(project.creationIssue))} onClick={() => setSection('task')}
          icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8H3m5-5L3 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}>
          {t(snapshot?.kind === 'empty' && allTasks.length === 0 ? 'createFirstTask' : 'backToCurrentTask')}
        </Button>} projectRules={() => { const workspaceId = selected.workspaceId; setOperationError(null); void openProjectRules(workspaceId, selected.title).catch(error => setOperationError({ projectId: workspaceId, message: error instanceof Error ? error.message : String(error) })) }} load={loadSettings} save={saveProcess} saveRole={saveRole} deleteRole={deleteRole} modelCatalog={modelCatalog} dirtyChanged={setSettingsDirty}
          saved={() => { const workspaceId = selected.workspaceId; void loadProject(workspaceId, new AbortController().signal).then(value => { setSnapshotProjectId(workspaceId); setSnapshot(value) }, error => setConnectionError(String(error))) }} />
      </div>}
    </div>
    </section>
  </div>
}

/** Material catalog stays visible while documents open in independent floating panels. */
function MaterialsBrowser({ active, workspaceId, workspaceTitle, task, canDelete, busy, deleteArtifacts, initialGroup, refresh, resetScroll, t, loadMaterials, openMaterial }: {
  active: boolean; workspaceId: string; workspaceTitle: string; task: TaskView | null; canDelete: boolean; busy: boolean; deleteArtifacts(stepId: string): Promise<void>; initialGroup: string | null; refresh: number; resetScroll(): void;
  t: PropsLocale<'aicraft'>['t']; loadMaterials: PanelFace['loadMaterials']; openMaterial: PanelFace['openMaterial'];
}): ReactNode {
  const taskId = task?.id ?? null
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const deletingStep = task?.steps.find(step => step.id === deleteTarget)
  const canClear = (step: StepView) => canDelete && !busy && step.status !== 'skipped' && step.status !== 'cancelled'
  const [groups, setGroups] = useState<MaterialGroup[] | null>(null)
  const [groupId, setGroupId] = useState(initialGroup)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(resetScroll, [groupId, resetScroll])
  useEffect(() => {
    if (busy || !active) return
    const controller = new AbortController()
    const read = async () => {
      try {
        const value = await loadMaterials(workspaceId, taskId, controller.signal)
        if (!controller.signal.aborted) {
          setGroups(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value)
          setError('')
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error))
      }
    }
    void read()
    return () => controller.abort()
  }, [workspaceId, taskId, refresh, retry, loadMaterials, busy, active])
  return <section aria-label={t('materials')} style={{ minWidth: 0, marginTop: 16 }}>
    {groupId !== null && <Button variant="ghost" onClick={() => setGroupId(null)}>← {t('allMaterials')}</Button>}
    {error && <div role="alert"><p>{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>{t('retry')}</Button></div>}
    {!error && (groups === null ? <p role="status">{t('loadingMaterials')}</p>
      : groups.filter(group => (group.id === 'request' || group.id === 'knowledge' || group.issue || group.files.length > 0) && (groupId === null || group.id === groupId)).map(group => {
        const step = task?.steps.find(item => group.id === `step:${item.id}`)
        return <details key={group.id} open={groupId !== null || group.id === 'request'} style={{ borderBottom: '1px solid #8090a030', padding: '10px 0' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>{group.title} <span style={{ opacity: 0.55 }}>({group.issue ? '?' : group.files.length})</span></summary>
        {step && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <Button type="button" variant="outline" disabled={!canClear(step) || (!group.issue && !group.files.some(file => file.name !== 'input-prompt.md'))} onClick={() => setDeleteTarget(step.id)}>{t('deleteStepMaterials')}</Button>
        </div>}
        {group.issue ? <p role="alert">{group.issue}</p> : group.files.length === 0 ? <p style={{ fontSize: 12, opacity: 0.65 }}>{t('noMaterials')}</p>
          : <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>{group.files.map(file => <li key={file.path}>
            <Button variant="ghost" title={file.path} onClick={() => openMaterial(workspaceId, workspaceTitle, file.path)} style={{ width: '100%', minWidth: 0, justifyContent: 'flex-start', fontSize: 13 }}>
              <FileTypeIcon kind={classifyFileType(file.name)} size={16} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
            </Button>
          </li>)}</ul>}
      </details>}))}
    {deletingStep && <Modal open title={t('deleteStepMaterials')} description={deletingStep.title} closeLabel={t('close')}
      onClose={() => { if (!busy) setDeleteTarget(null) }}>
      <p>Delete all artifacts for this step except input-prompt.md? Reports and previous run instructions will be deleted. This cannot be undone. The input prompt, chat history and step status will be kept.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>{t('cancel')}</Button>
        <Button type="button" variant="outline" className="aicraft-destructive-confirm" disabled={!canClear(deletingStep)} onClick={() => {
          void deleteArtifacts(deletingStep.id).then(() => { setDeleteTarget(null); setRetry(value => value + 1) })
        }}>{busy ? 'Deleting…' : t('deleteStepMaterials')}</Button>
      </div>
    </Modal>}
  </section>
}

/** Distinct step status glyphs, keeping the existing semantic colours. */
function StepStatusIcon({ status }: { status: StepView['status'] }): ReactNode {
  if (status === 'cancelled') return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5.5 8h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
  if (status === 'current') return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2 8h11M8 3l5 5-5 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
  if (status === 'skipped') return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 3l4 4 4-4M4 8l4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
  const Icon = { done: IconCheckOutlineRegular, pending: IconClockOutlineRegular }[status]
  return <Icon size={16} />
}

/** Compact stage commands using the same menu and button primitives as DSH. */
function StepActions({ blocked, step, previousSteps, returnTo, current, disabled, busy, setModel, prompt, run, runWithModel, modelCatalog, t, select }: {
  blocked: boolean; step: StepView; previousSteps: StepView[]; returnTo(stepId: string): Promise<void>; current: boolean; disabled: boolean; busy: boolean; setModel(model: RunModel): Promise<void>; prompt(): void; run(): void;
  modelCatalog(): Promise<ModelCatalog>; runWithModel(model: RunModel): void;
  t: PropsLocale<'aicraft'>['t']; select(kind: 'goto' | 'skip' | 'complete'): void;
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [choosingModel, setChoosingModel] = useState(false)
  const [choosingAssignment, setChoosingAssignment] = useState(false)
  const [returnTarget, setReturnTarget] = useState<string | null>(null)
  const readOnly = step.status === 'skipped' || step.status === 'cancelled'
  const cannotChange = disabled || readOnly
  const cannotSelect = disabled || step.status === 'cancelled'
  return <><Menu listClassName="aicraft-step-menu" open={open && !busy && !blocked} portal align="end" autoFocus onClose={() => setOpen(false)}
    items={[
      { id: 'prompt', label: t('showStepPrompt'), disabled: blocked },
      { type: 'separator', id: 'materials-separator' },
      { id: 'set-model', label: t('setStepModel'), disabled: cannotChange },
      { id: 'run', label: t('runStep'), disabled: cannotChange || !current },
      { id: 'run-model', label: t('runStepWithModel'), disabled: cannotChange || !current },
      { type: 'separator', id: 'execution-separator' },
      { id: 'complete', label: t('completeStep'), disabled: cannotChange || !current },
      { id: 'skip', label: t('skipStep'), disabled: cannotChange || !current },
      { id: 'goto', label: t('goToStep'), disabled: cannotSelect || current },
      { id: 'return', label: t('returnTo'), disabled: cannotChange || !current || previousSteps.length === 0 },
    ]}
    onSelect={id => {
      setOpen(false)
      if (id === 'prompt' && !blocked) prompt()
      else if (id === 'set-model' && !cannotChange) setChoosingAssignment(true)
      else if (id === 'run' && !cannotChange && current) run()
      else if (id === 'run-model' && !cannotChange && current) setChoosingModel(true)
      else if (id === 'return' && current && !cannotChange && previousSteps.length > 0) setReturnTarget(previousSteps.at(-1)!.id)
      else if (id === 'goto' && !cannotSelect && !current) select('goto')
      else if (!cannotChange && current && (id === 'skip' || id === 'complete')) select(id)
    }}
    anchor={<Button variant="ghost" size="sm" disabled={busy || blocked} title={t('actions')}
      aria-label={t('stepActions', { step: step.title })} aria-haspopup="menu" aria-expanded={open && !busy}
      onClick={() => setOpen(value => !value)} style={{ width: 28, padding: 0 }}>
      <IconEllipsisOutlineRegular size={16} />
    </Button>} />
    {returnTarget !== null && current && <Modal open title={t('returnTo')} description={step.title} closeLabel={t('close')}
      onClose={() => { if (!busy) setReturnTarget(null) }}>
      <label style={{ display: 'grid', gap: 8, marginBottom: 16 }}>{t('returnTarget')}
        <select aria-label={t('returnTarget')} value={returnTarget} disabled={cannotChange || busy} onChange={event => setReturnTarget(event.target.value)}>
          {previousSteps.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      <p>The selected step becomes current, including a skipped step. Later ordinary steps return to pending. Other skipped and cancelled steps, artifacts and chat history are kept.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="outline" disabled={busy} onClick={() => setReturnTarget(null)}>{t('cancel')}</Button>
        <Button variant="outline" disabled={cannotChange || busy || !previousSteps.some(item => item.id === returnTarget)}
          onClick={() => { void returnTo(returnTarget).then(() => setReturnTarget(null)) }}>{t('returnStep')}</Button>
      </div>
    </Modal>}
    {choosingAssignment && <StepModelDialog stepTitle={step.title} assignment initialModel={step.model} disabled={disabled || busy} t={t} modelCatalog={modelCatalog}
      close={() => { if (!busy) setChoosingAssignment(false) }} confirm={model => { void setModel(model).then(() => setChoosingAssignment(false)) }} />}
    {choosingModel && <StepModelDialog stepTitle={step.title} disabled={disabled || !current || busy} t={t} modelCatalog={modelCatalog}
      close={() => setChoosingModel(false)} confirm={model => { if (model) { setChoosingModel(false); runWithModel(model) } }} />}
  </>
}

/** Choose a catalog model for this run without changing the saved assignment. */
function StepModelDialog({ stepTitle, disabled, t, modelCatalog, close, confirm, assignment = false, initialModel = null }: {
  stepTitle: string; disabled: boolean; t: PropsLocale<'aicraft'>['t'];
  modelCatalog(): Promise<ModelCatalog>; close(): void; confirm(model: RunModel): void; assignment?: boolean; initialModel?: RunModel | null;
}): ReactNode {
  const id = useId()
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [error, setError] = useState('')
  const [route, setRoute] = useState(initialModel ? JSON.stringify([initialModel.provider, initialModel.model]) : '')
  useEffect(() => {
    let active = true
    void modelCatalog().then(value => { if (active) setCatalog(value) }, error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [modelCatalog])
  const routes = catalog?.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, key: JSON.stringify([group.id, model.id]), label: `${group.name} / ${model.name}` }))) ?? []
  const selected = routes.find(item => item.key === route)
  return <Modal open onClose={close} title={t(assignment ? 'setStepModel' : 'runStepWithModel')} description={stepTitle} closeLabel={t('close')}
    footer={<><Button variant="ghost" onClick={close}>{t('cancel')}</Button>
      <Button variant="outline" disabled={disabled || !selected} onClick={() => { if (selected && !disabled) confirm({ provider: selected.provider, model: selected.model, reasoningEffort: initialModel && initialModel.provider === selected.provider && initialModel.model === selected.model ? initialModel.reasoningEffort : null }) }}>{t(assignment ? 'save' : 'runStep')}</Button></>}>
    <p style={{ opacity: 0.65 }}>{t(assignment ? 'savedModelHint' : 'runModelHint')}</p>
    <label htmlFor={id} style={{ display: 'block', marginBottom: 8 }}>{t('model')}</label>
    <select id={id} data-modal-autofocus value={route} disabled={disabled || !catalog} onChange={event => setRoute(event.target.value)}
      style={{ width: '100%', padding: 8, color: 'inherit', background: 'transparent' }}>
      <option value="" disabled>{t('chooseModel')}</option>
      {initialModel && route && !selected && <option value={route}>{modelLabel(initialModel)} (unavailable)</option>}
      {routes.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
    </select>
    {!catalog && !error && <p role="status">{t('loadingModels')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

/** Use DSH's standard menu so project entries can carry the sidebar icon. */
function ProjectPicker({ projects, presence, selectedId, busy, t, select }: {
  projects: readonly WorkspaceView[]; presence: ProjectPresence[]; selectedId: string; busy: boolean;
  t: PropsLocale<'aicraft'>['t']; select(id: string): void;
}): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = projects.find(project => project.workspaceId === selectedId)
  const hasProject = (id: string): boolean => presence.some(item => item.workspaceId === id && item.hasAicraft)
  return <div style={{ flex: '0 1 300px', minWidth: 0 }}>
    <div style={{ display: 'grid' }}>
      <Menu open={open && !busy} portal autoFocus selection="fill" selectedId={selectedId} onClose={() => setOpen(false)}
        onSelect={id => { select(id); setOpen(false) }}
        items={[{ id: '', label: t('chooseProject'), icon: selectedId === '' ? <IconCheckOutlineRegular size={14} /> : <span /> }, ...projects.map(project => ({
          id: project.workspaceId,
          icon: selectedId === project.workspaceId ? <IconCheckOutlineRegular size={14} /> : <span />,
          label: <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.title}</span>
            {hasProject(project.workspaceId) && <AicraftIcon size={18} />}
          </span>,
        }))]}
        anchor={<button id="aicraft-project" type="button" disabled={busy} aria-label={t('project')} aria-haspopup="menu" aria-expanded={open && !busy}
          onClick={() => setOpen(value => !value)} style={{ width: '100%', height: 40, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 7, border: '1px solid #8090a060', color: 'inherit', background: 'transparent', textAlign: 'left' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected?.title ?? t('chooseProject')}</span>
          {selected && hasProject(selected.workspaceId) && <AicraftIcon size={18} />}
          <IconChevronDownOutlineRegular size={16} />
        </button>} />
    </div>
  </div>
}

/** Browse task history without changing the project's open task. */
function TaskPicker({ tasks, selectedId, busy, t, select, create, canCreate }: {
  tasks: TaskView[]; selectedId: string; busy: boolean;
  t: PropsLocale<'aicraft'>['t']; select(id: string): void; create(): void; canCreate: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = tasks.find(task => task.id === selectedId)
  const statusIcon = (status: TaskView['status']): ReactNode => {
    const Icon = { open: IconListPenOutlineRegular, completed: IconCheckCircleOutlineRegular, cancelled: IconStopFillRegular }[status]
    return <Tooltip label={t(status === 'open' ? 'openTask' : status)} portal>
      <span role="img" aria-label={t(status === 'open' ? 'openTask' : status)} data-task-status={status}
        style={{ display: 'inline-flex', flexShrink: 0, opacity: status === 'cancelled' ? 0.65 : 0.85, color: { open: '#3b82f6', completed: '#22a06b', cancelled: 'inherit' }[status] }}>
        <Icon size={16} />
      </span>
    </Tooltip>
  }
  return <div style={{ flex: '0 1 300px', minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
    <Menu open={open && !busy} listClassName="aicraft-task-menu" portal autoFocus selection="fill" selectedId={selectedId} onClose={() => setOpen(false)}
      onSelect={id => { if (id === ':create') create(); else select(id); setOpen(false) }}
      items={[...tasks.map(task => ({
        id: task.id,
        icon: task.id === selectedId ? <IconCheckOutlineRegular size={14} /> : <span />,
        label: <span style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 360 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span title={task.title} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
            {task.updatedAt && <span style={{ display: 'block', fontSize: 11, opacity: 0.65 }}>{new Date(task.updatedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>}
          </span>
          {statusIcon(task.status)}
        </span>,
      })), { type: 'separator', id: ':create-separator' }, { id: ':create', label: t('create'), disabled: !canCreate }]}
      anchor={<button type="button" disabled={busy || tasks.length === 0} aria-label={t('taskPicker')} aria-haspopup="menu" aria-expanded={open && !busy}
        onClick={() => setOpen(value => !value)} style={{ width: '100%', minWidth: 0, height: 40, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 7, border: '1px solid #8090a060', color: 'inherit', background: 'transparent', textAlign: 'left' }}>
        <span title={selected?.title} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected?.title ?? t('chooseTask')}</span>
        {selected && statusIcon(selected.status)}
        <IconChevronDownOutlineRegular size={16} />
      </button>} />
  </div>
}

/** Show the durable provider identity, model and optional reasoning effort. */
function modelLabel(model: RunModel | null | undefined): string {
  if (!model) return 'Not assigned'
  return `${model.provider} / ${model.model}${model.reasoningEffort ? ` / ${model.reasoningEffort}` : ''}`
}

/** Latest executor chats first, with theme-aware activity on the complete heading. */
function RunHistory({ readOnly, task, workspaceId, statistics, active, sessionActivity, archivedSessionIds, t, openExecutor, stopGenerating, archiveChat }: {
  readOnly: boolean; task: TaskView; workspaceId: string; statistics: PanelFace['statistics']; active: boolean; sessionActivity: Record<string, SessionActivity & { completed: string }>; archivedSessionIds: readonly SessionId[]; stopGenerating(sessionId: string): Promise<void>; archiveChat(sessionId: string): Promise<void>; t: PropsLocale<'aicraft'>['t']; openExecutor(sessionId: string): void;
}): ReactNode {
  const [visibleCount, setVisibleCount] = useState(3)
  const [confirmation, setConfirmation] = useState<{ kind: 'stop' | 'archive'; run: RunView } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    if (!confirmation || busy || readOnly) return
    setBusy(true); setError('')
    try {
      await (confirmation.kind === 'stop' ? stopGenerating(confirmation.run.sessionId) : archiveChat(confirmation.run.sessionId))
      setConfirmation(null)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const runs = task.runs.map((run, index) => {
    const running = sessionActivity[run.sessionId]?.running ?? ['starting', 'running'].includes(run.status)
    const status = running ? (run.status === 'starting' ? 'starting' : 'running') : run.status
    return { run, number: index + 1, running, status }
  })
    .filter(({ run }) => !archivedSessionIds.includes(run.sessionId as SessionId))
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt) || b.number - a.number)
  if (!runs.length && !confirmation) return null
  return <section style={{ marginTop: 24 }} aria-label={t('runHistory')}>
    <style>{`
      @keyframes aicraft-run-wave {
        from { background-position: 100% 0; }
        to { background-position: 0% 0; }
      }
      /* Animate only the text colour, without a duplicate layer or glyph motion. */
      .aicraft-run-wave {
        background-image: linear-gradient(110deg, var(--dsw-alias-label-primary) 40%, var(--dsw-alias-label-secondary) 50%, var(--dsw-alias-label-primary) 60%);
        background-size: 250% 100%;
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
        animation: aicraft-run-wave 2.8s linear infinite;
      }
    `}</style>
    {runs.slice(0, visibleCount).map(({ run, number, running, status }) => <div key={run.id} data-run-id={run.id} style={{ borderTop: '1px solid #8090a040', padding: '12px 0', overflowWrap: 'anywhere' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong><span className={running ? 'aicraft-run-wave' : undefined}>{`#${number} · ${task.steps.find(step => step.id === run.stepId)?.title ?? run.stepId} · ${t(status === 'failed' ? 'runFailed' : status)}`}</span></strong>
        <Button variant="ghost" size="sm" title={t('openRun')} aria-label={t('openRun')} onClick={() => openExecutor(run.sessionId)} style={{ width: 28, padding: 0, flexShrink: 0 }}>
          <IconQueueOutlineRegular size={16} />
        </Button>
        <Button variant="ghost" size="sm" title={t('stopGenerating')} aria-label={t('stopGenerating')} disabled={readOnly || busy || !running}
          onClick={() => { setError(''); setConfirmation({ kind: 'stop', run }) }} style={{ width: 28, padding: 0, flexShrink: 0 }}>
          <IconStopFillRegular size={16} />
        </Button>
        <Button variant="ghost" size="sm" title={t('archiveChat')} aria-label={t('archiveChat')} disabled={readOnly || busy}
          onClick={() => { setError(''); setConfirmation({ kind: 'archive', run }) }} style={{ width: 28, padding: 0, flexShrink: 0 }}>
          <IconArchiveOutlineRegular size={16} />
        </Button>
      </div>
      <p style={{ fontSize: 12 }}>{new Date(run.startedAt).toLocaleString()} · {modelLabel(run.model)}</p>
      <ExecutionStatistics key={`${workspaceId}:${task.id}:${run.sessionId}`} workspaceId={workspaceId} taskId={task.id} sessionId={run.sessionId}
        active={active} running={running} revision={sessionActivity[run.sessionId]?.completed ?? run.finishedAt ?? run.startedAt} load={statistics} />
      {run.error && <p role="alert">{run.error}</p>}
    </div>)}
    {runs.length > visibleCount && <button type="button" onClick={() => setVisibleCount(count => count + 3)}
      style={{ border: 0, padding: '8px 0', background: 'transparent', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>{t('showMoreChats')}</button>}
    {confirmation && <Modal open onClose={() => { if (!busy) setConfirmation(null) }} title={t(confirmation.kind === 'stop' ? 'stopGenerating' : 'archiveChat')} closeLabel={t('close')}
      description={t(confirmation.kind === 'stop' ? 'stopPrompt' : 'archivePrompt')}
      footer={<><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>{t('cancel')}</Button>
        <Button variant="outline" disabled={readOnly || busy} onClick={() => { void confirm() }}>{t(busy ? 'saving' : confirmation.kind === 'stop' ? 'stopGenerating' : 'archiveChat')}</Button></>}>
      <p>{task.steps.find(step => step.id === confirmation.run.stepId)?.title ?? confirmation.run.stepId} · {new Date(confirmation.run.startedAt).toLocaleString()}</p>
      {error && <p role="alert">{error}</p>}
    </Modal>}
  </section>
}

/**
 * Collect requirements and a process before creating a task.
 * @param props - Project templates, translations and creation operation.
 * @returns The task creation form.
 */
function CreateTaskForm({ project, busy, t, submit }: {
  project: ProjectView; busy: boolean; t: PropsLocale<'aicraft'>['t']; submit(request: CreateTaskRequest): Promise<void>
}): ReactNode {
  const [taskIdentifier, setTaskIdentifier] = useState('')
  const [title, setTitle] = useState('')
  const [processId, setProcessId] = useState(project.processes[0]?.id ?? '')
  const [requestText, setRequestText] = useState(project.requestTemplate)
  const field = { width: '100%', padding: 10, borderRadius: 7, border: '1px solid #8090a060', color: 'inherit', background: 'transparent', boxSizing: 'border-box' as const }
  const duplicate = project.task.allTasks.some(task => task.id === taskIdentifier)
  const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(taskIdentifier)
  return <form onSubmit={event => { event.preventDefault(); if (!duplicate && validId) void submit({ taskIdentifier, title, processId, requestText }) }} style={{ marginTop: 24 }}>
    <h2 style={{ fontSize: 16 }}>{t('create')}</h2>
    <label htmlFor="aicraft-task-id">Task ID</label>
    <input id="aicraft-task-id" required disabled={busy} maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}" placeholder="task_name" value={taskIdentifier} onChange={event => setTaskIdentifier(event.target.value)} aria-describedby="aicraft-task-id-hint" aria-invalid={duplicate || (Boolean(taskIdentifier) && !validId)} style={{ ...field, margin: '8px 0' }} />
    <p id="aicraft-task-id-hint" role={duplicate ? 'alert' : undefined} style={{ fontSize: 12, margin: '0 0 16px', color: duplicate ? '#dc4545' : 'inherit', opacity: duplicate ? 1 : 0.65 }}>{duplicate ? `Task directory "${taskIdentifier}" already exists. Choose another Task ID.` : 'Used as the task directory name. Letters, digits, hyphens and underscores; starts with a letter or digit.'}</p>
    <label htmlFor="aicraft-title">{t('title')}</label>
    <input id="aicraft-title" required disabled={busy} value={title} onChange={event => setTitle(event.target.value)} style={{ ...field, margin: '8px 0 16px' }} />
    <label htmlFor="aicraft-process">{t('process')}</label>
    <select id="aicraft-process" required disabled={busy} value={processId} onChange={event => setProcessId(event.target.value)} style={{ ...field, margin: '8px 0 16px' }}>
      {project.processes.map(process => <option key={process.id} value={process.id}>{process.name}</option>)}
    </select>
    <label htmlFor="aicraft-request">{t('requirements')}</label>
    <textarea id="aicraft-request" required disabled={busy} rows={7} value={requestText} onChange={event => setRequestText(event.target.value)} style={{ ...field, margin: '8px 0 16px', resize: 'vertical' }} />
    <Button type="submit" variant="outline" className="aicraft-task-action" disabled={busy || !validId || duplicate || !title.trim() || !requestText.trim() || !processId}>{t(busy ? 'creating' : 'create')}</Button>
  </form>
}

/**
 * Render the AICraft sidebar icon.
 * @param props - Icon size supplied by the sidebar.
 * @returns A forged crafting hammer with three magic sparks.
 */
function AicraftIcon({ size }: { size: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" opacity="0.65" aria-hidden="true">
    <g transform="translate(24 0) scale(-1 1) rotate(-35 12 12)" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M10.7 10.5h2.6V20h-2.6z" fill="currentColor" />
      <path d="M10 19h4v2h-4z" fill="currentColor" />
      <path d="M7 4h10l1 1v5l-1 1H7l-1-1V5z" fill="currentColor" fillOpacity="0.18" />
      <path d="M9 4v7m6-7v7" />
    </g>
    <path d="M4 1 4.9 3.1 7 4 4.9 4.9 4 7 3.1 4.9 1 4 3.1 3.1Z" fill="currentColor" />
    <path d="M20.5 14.8 21.4 16.9 23.5 17.8 21.4 18.7 20.5 20.8 19.6 18.7 17.5 17.8 19.6 16.9Z" fill="currentColor" />
    <path d="M3 10.1 3.8 11.7 5.4 12.5 3.8 13.3 3 14.9 2.2 13.3 .6 12.5 2.2 11.7Z" fill="currentColor" />
  </svg>
}

/** Services required to mount the Remote API and register the panel. */
export const inject = ['slots', 'locale', 'layout', 'remote']

/**
 * Mount AICraft Remote methods and add the sidebar entry and main panel.
 * @param ctx - Browser Cordis plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(remote)
  ctx.effect(() => disposeRemote, 'aicraft: remote')
  ctx.effect(() => ctx.locale.register('aicraft', { en, zh }), 'aicraft: translations')
  const t = ctx.locale.bind('aicraft')
  const panelId = 'aicraft' as MainPanelId
  ctx.inject(['remote', 'remote.aicraft', 'remote.session', 'workspaces', 'sidebarRight', 'sidebarRightTabs', 'uiSession', 'uiWorkspace'], panelCtx => {
    const tabId = 'dsh-aicraft'
    panelCtx.effect(() => panelCtx.sidebarRightTabs.register({
      id: tabId, kind: 'aicraft', title: () => t('panel'), keepMounted: true,
      guide: [{ id: 'aicraft', order: 10, title: () => t('panel'), description: () => t('subtitle') }],
    }), 'aicraft: sidebar tab')
    let pendingFrame: number | undefined
    panelCtx.effect(() => () => { if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame) })
    const openSidebar = (): void => {
      if (panelCtx.uiSession.adapter.current.getSnapshot().key === undefined) return
      panelCtx.layout.selectPanel(null)
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame)
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined
        panelCtx.sidebarRight.openTab('aicraft')
      })
    }
    // Keep panel state independent of DSH's per-session sidebar occurrences.
    const panelElement = document.createElement('div')
    Object.assign(panelElement.style, { display: 'flex', flexDirection: 'column', flex: '1 1 0', height: '100%', minHeight: '0' })
    const panelRoot = createRoot(panelElement)
    let executorScroll: number | undefined
    panelCtx.effect(() => () => { panelRoot.unmount(); panelElement.remove() }, 'aicraft: persistent panel')
    const PanelHost = ({ active, ...props }: Omit<PanelProps, 'visible'> & { active: boolean }): ReactNode => {
      const target = useRef<HTMLDivElement>(null)
      const latest = useRef(props)
      latest.current = props
      useLayoutEffect(() => {
        const host = target.current
        return () => {
          if (panelElement.parentElement === host) panelRoot.render(<AicraftPanel {...latest.current} visible={false} />)
        }
      }, [])
      useLayoutEffect(() => {
        if (!active || !target.current) {
          if (panelElement.parentElement === target.current) panelRoot.render(<AicraftPanel {...props} visible={false} />)
          return
        }
        if (panelElement.parentElement !== target.current) {
          target.current.appendChild(panelElement)
          if (executorScroll !== undefined) {
            panelElement.firstElementChild?.scrollTo({ top: executorScroll })
            executorScroll = undefined
          }
        }
        panelRoot.render(<AicraftPanel {...props} visible={true} />)
      })
      return <div ref={target} style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', height: '100%', minHeight: 0 }} />
    }
    const SidebarHost = (props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'aicraft'> & InjectFace<PanelFace>): ReactNode => {
      const { tab } = props.useTabInfo()
      return <PanelHost {...props} active={tab.visible} />
    }
    const Launcher = (props: PropsRuntime<'main'> & PropsLocale<'aicraft'> & InjectFace<PanelFace>): ReactNode => {
      const current = panelCtx.uiSession.adapter.current
      const sessionId = useSyncExternalStore(
        listener => current.subscribe(listener),
        () => current.getSnapshot().key as SessionId | undefined,
      )
      useEffect(() => { if (sessionId !== undefined) openSidebar() }, [sessionId])
      const active = props.usePanelInfo((info: PanelInfo) => info.activePanelId === panelId)
      return <PanelHost {...props} sessionId={sessionId} active={active} />
    }
    let closingProject = Promise.resolve()
    let editors: ReturnType<typeof mountMaterialEditors>
    const face: PanelFace = {
      followProject: async function* (workspaceId, taskId, signal) {
        await closingProject
        if (signal.aborted) return
        const stream = panelCtx.remote.$stream<ProjectChange>({
          name: 'AICraft project changes',
          open: generation => panelCtx.remote.aicraft.changes(workspaceId, taskId, generation),
          ended: () => new Error('Automatic project updates ended; use Refresh task'),
        })
        const close = () => { closingProject = stream.dispose(); return closingProject }
        const cancel = () => { void close().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          for await (const item of stream) {
            if (signal.aborted) return
            if (item.value.kind === 'ready') item.accept()
            yield item.value
          }
        } finally { signal.removeEventListener('abort', cancel); await close() }
      },
      checkConnection: async () => {
        const result = await panelCtx.remote.aicraft.status()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadProjects: async signal => {
        const result = await panelCtx.remote.aicraft.projects(signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadProject: async (workspaceId, signal) => {
        const result = await panelCtx.remote.aicraft.project(workspaceId, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      prepareProject: async (workspaceId, request) => {
        const result = await panelCtx.remote.aicraft.prepare(workspaceId, request)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      createTask: async (workspaceId, request) => {
        const result = await panelCtx.remote.aicraft.createTask(workspaceId, request)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      goToStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.goToStep(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      returnStep: async (workspaceId, taskId, fromStepId, stepId) => {
        const result = await panelCtx.remote.aicraft.returnStep(workspaceId, taskId, fromStepId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      skipStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.skipStep(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      setStepModel: async (workspaceId, taskId, stepId, model) => {
        const result = await panelCtx.remote.aicraft.setStepModel(workspaceId, taskId, stepId, model)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      deleteStepMaterials: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.deleteStepMaterials(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      completeStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.completeStep(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      startStep: async (workspaceId, taskId, stepId, model) => {
        const result = await panelCtx.remote.aicraft.startStep(workspaceId, taskId, stepId, model)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      statistics: async (workspaceId, taskId, sessionId, signal) => {
        const result = await panelCtx.remote.aicraft.statistics(workspaceId, taskId, sessionId, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadMaterials: async (workspaceId, taskId, signal) => {
        const result = await panelCtx.remote.aicraft.materials(workspaceId, taskId, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadMaterial: async (workspaceId, path, signal) => {
        const result = await panelCtx.remote.aicraft.material(workspaceId, path, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      saveMaterial: async (workspaceId, path, text, version, signal) => {
        const result = await panelCtx.remote.aicraft.saveMaterial(workspaceId, path, text, version, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      showStepPrompt: async (workspaceId, workspaceTitle, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.stepPrompt(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        editors.open(workspaceId, workspaceTitle, `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`)
      },
      openProjectRules: async (workspaceId, workspaceTitle) => {
        const result = await panelCtx.remote.aicraft.projectRules(workspaceId)
        if (!result.ok) throw new Error(result.error.message)
        editors.open(workspaceId, workspaceTitle, result.value.path)
      },
      openMaterial: (workspaceId, workspaceTitle, path) => editors.open(workspaceId, workspaceTitle, path),
      loadSettings: async (workspaceId, signal) => {
        const result = await panelCtx.remote.aicraft.settings(workspaceId, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      saveProcess: async (workspaceId, id, definition, version, templateLanguage) => {
        const result = await panelCtx.remote.aicraft.saveProcess(workspaceId, id, definition, version, templateLanguage)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      saveRole: async (workspaceId, id, text, version) => {
        const result = await panelCtx.remote.aicraft.saveRole(workspaceId, id, text, version)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      deleteRole: async (workspaceId, id, version) => {
        const result = await panelCtx.remote.aicraft.deleteRole(workspaceId, id, version)
        if (!result.ok) throw new Error(result.error.message)
      },
      modelCatalog: async () => {
        const result = await panelCtx.remote.session.modelCatalog()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      stopGenerating: async sessionId => {
        const result = await panelCtx.remote.session.cancel({ sessionId: sessionId as SessionId })
        if (!result.ok) throw new Error(result.error.message)
      },
      archiveChat: async sessionId => {
        const wasCurrent = panelCtx.uiSession.adapter.current.getSnapshot().key === sessionId
        await panelCtx.uiWorkspace.archiveSession(sessionId as SessionId, { stopActivity: true })
        if (wasCurrent || panelCtx.uiSession.adapter.current.getSnapshot().key === undefined) panelCtx.layout.selectPanel(panelId)
      },
      openExecutor: sessionId => {
        if (panelCtx.uiSession.adapter.current.getSnapshot().key !== sessionId) executorScroll = panelElement.firstElementChild?.scrollTop ?? 0
        panelCtx.uiWorkspace.openSession(sessionId as SessionId)
        if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame)
        pendingFrame = requestAnimationFrame(() => { pendingFrame = undefined; panelCtx.sidebarRight.openTab('aicraft') })
      },
      reopenTask: async (workspaceId, taskId) => {
        const result = await panelCtx.remote.aicraft.reopenTask(workspaceId, taskId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      closeTask: async (workspaceId, taskId) => {
        const result = await panelCtx.remote.aicraft.closeTask(workspaceId, taskId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
    }
    editors = mountMaterialEditors({ t, load: face.loadMaterial, save: face.saveMaterial,
      resetPrompt: async (workspaceId, taskId, stepId, version, signal) => {
        const result = await panelCtx.remote.aicraft.defaultStepPrompt(workspaceId, taskId, stepId, version, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      saved: (workspaceId, path) => window.dispatchEvent(new CustomEvent('aicraft:material-saved', { detail: { workspaceId, path } })),
    })
    panelCtx.effect(() => () => editors.dispose(), 'aicraft: floating material editors')
    panelCtx.slots.inject('sidebar.right.pane.tab', () => panelCtx.slots.register({
      name: 'sidebar.right.pane.tab', key: tabId, locale: 'aicraft', inject: () => face,
    }, SidebarHost))
    panelCtx.slots.inject('main', () => panelCtx.slots.register({
      name: 'main', key: panelId, locale: 'aicraft', inject: () => face,
    }, Launcher))
    panelCtx.slots.inject('sidebar.panellist', () => panelCtx.slots.register({
      name: 'sidebar.panellist', id: panelId, order: 10, label: () => t('panel'), locale: 'aicraft',
    }, AicraftIcon))
  })
}
