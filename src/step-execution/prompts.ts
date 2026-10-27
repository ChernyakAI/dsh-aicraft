/**
 * FILE: plugin/src/step-execution/prompts.ts
 * DESCRIPTION: Open saved prompts and compose defaults from current inputs
 */
import { diagnosticPublication, diagnosticOperation, diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { join } from 'node:path'
import { readRulesAndRole } from '../project-settings/rules.ts'
import { stepResultInstructions } from '../project-settings/templates.ts'
import { readTaskSnapshot,readTaskState } from '../task-management/queries.ts'
import { AMBIGUOUS_TASKS_MESSAGE } from '../task-management/types.ts'
import { hasKnowledgeMaterials } from '../work-materials/artifact-files.ts'
import { readMaterial,targetFor } from '../work-materials/materials.ts'
import type { MaterialDocument } from '../work-materials/types.ts'

/**
 * Validate and read the same executor inputs for the panel and dispatch.
 * @param fs - DSH filesystem provider.
 * @param cwd - Registered project directory.
 * @param taskId - Task identity obtained from the current snapshot.
 * @param roleId - Role identity from the saved process.
 * @param signal - Caller cancellation.
 * @returns Current rules, role and task requirements.
 */
export async function readExecutionInputs(fs: FileSystem, cwd: string, taskId: string, roleId: string, signal: AbortSignal) {
  const read = async (path: string, missing: string): Promise<string> => {
    const target = await targetFor(fs, cwd, path, signal)
    const info = await fs.stat(target, signal)
    if (!info) throw new Error(missing)
    if (info.type !== 'file') throw new Error(`Executor input must be a file: ${path}`)
    const content = await fs.readText(target, signal)
    if (!content.trim()) throw new Error(`Executor input must not be empty: ${path}`)
    return content
  }
  const { rules, role } = await readRulesAndRole(fs, cwd, roleId, signal)
  const requestPath = `.aicraft/tasks/${taskId}/request.md`
  const request = await read(requestPath, `Add task requirements in ${requestPath} before starting an executor.`)
  return { rules, role, request }
}

/**
 * START_METHOD_openStepPrompt
 * Open or create the editable prompt without creating a run.
 */
export async function openStepPrompt(
  fs: FileSystem,
  waitMs: number,
  cwd: string,
  taskId: string,
  stepId: string,
  signal: AbortSignal,
): Promise<string> {
  return diagnosticOperation({ path: 'src/step-execution/prompts.ts', method: 'openStepPrompt' }, { projectPath: cwd, taskId: taskId, stepId: stepId }, async () => {
    return withFileLock(join(cwd, '.aicraft'), () => inputPrompt(fs, cwd, taskId, stepId, signal), { waitMs: waitMs })

  })
}
// END_METHOD_openStepPrompt

/**
 * START_METHOD_defaultStepPrompt
 * Generate editor defaults without changing the saved prompt or its version.
 */
export async function defaultStepPrompt(
  fs: FileSystem,
  waitMs: number,
  cwd: string,
  taskId: string,
  stepId: string,
  version: string,
  signal: AbortSignal,
): Promise<MaterialDocument> {
  return diagnosticOperation({ path: 'src/step-execution/prompts.ts', method: 'defaultStepPrompt' }, { projectPath: cwd, taskId: taskId, stepId: stepId }, async () => {
    if (!version) throw diagnosticRejection(new Error('The original file version is required'))
    return withFileLock(join(cwd, '.aicraft'), async () => {
      const text = await inputPrompt(fs, cwd, taskId, stepId, signal, version)
      return { path: `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`, text, version, format: 'markdown' }
    }, { waitMs: waitMs })

  })
}
// END_METHOD_defaultStepPrompt

export async function inputPrompt(
  fs: FileSystem,
  cwd: string,
  taskId: string,
  stepId: string,
  signal: AbortSignal,
  previewVersion?: string,
): Promise<string> {
  const snapshot = await readTaskSnapshot(fs, cwd, signal)
  if (snapshot.kind === 'ambiguous') throw new Error(AMBIGUOUS_TASKS_MESSAGE)
  if (snapshot.kind === 'invalid' || !snapshot.allTasks.some(task => task.id === taskId)) throw new Error('Task is missing or invalid')
  const state = await readTaskState(fs, cwd, taskId, signal)
  const step = state.process.steps.find(item => item.id === stepId)
  if (!step) throw new Error('Step is missing from the task process')
  const outputPath = `.aicraft/tasks/${taskId}/${stepId}`
  const path = `${outputPath}/input-prompt.md`
  const target = await targetFor(fs, cwd, path, signal)
  if (previewVersion !== undefined) {
    const current = await readMaterial(fs, cwd, path, signal)
    if (current.version !== previewVersion) throw new Error('The file changed outside the editor. Reload it before resetting the prompt.')
  } else if (await fs.lstat(path, { cwd }, signal)) return (await readMaterial(fs, cwd, path, signal)).text
  const { rules, role, request } = await readExecutionInputs(fs, cwd, taskId, step.role, signal)
  const hasKnowledge = await hasKnowledgeMaterials(fs, cwd, signal)
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
  if (previewVersion === undefined) await diagnosticPublication(() => fs.writeText(target, text, { kind: 'createIfAbsent' }, signal, { mode: 'workspace-write', workspaceRoot: cwd }), target, 'writeText')
  return text
}
