import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir, rm, realpath, symlink, lstat, cp } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { saveMaterial, readMaterial, listMaterials } from '../.build/host/materials.js'
import { readSettings, saveProcess, saveRole, deleteRole } from '../.build/host/settings.js'
import { AicraftService } from '../.build/host/index.js'
import { RunController } from '../.build/host/runs.js'
import { readTaskState, readRuns } from '../.build/host/task-state.js'
import { defaultStepModel } from '../.build/host/process-templates.js'
import { currentBranch, prepareProject, createTask, updateTask, readExecutionInputs, readProject, openProjectRules } from '../.build/host/project.js'

const config = { gitTimeoutMs: 1000, gitGraceMs: 100, lockWaitMs: 1000 }
const signal = () => new AbortController().signal
const noGit = { async resolveExecutable() { throw new Error('Git is not installed') } }

test('merged open tasks are view-only: prompt commands, stale saves, settings and recovery cannot write', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-merged-tasks-')), fs = filesystem()
  try {
    await prepareProject(fs, noGit, cwd, config, signal())
    const project = await createTask(fs, noGit, cwd, { taskIdentifier: 'one', title: 'First task', processId: 'manual', requestText: 'First branch' }, config, signal())
    const controller = new RunController({ fs, subprocess: noGit, agents: { get() {} }, effect() {}, on() {}, get() {} }, config)
    const prompt = await controller.prompt(cwd, 'one', 'analysis', signal())
    const base = join(cwd, '.aicraft/tasks/one')
    const loaded = await readMaterial(fs, cwd, '.aicraft/tasks/one/analysis/input-prompt.md', signal())
    await saveRole(fs, cwd, 'unused', 'Unused role', null, config.lockWaitMs, signal())
    const settings = await readSettings(fs, cwd, signal())
    const role = settings.roleDocuments.find(role => role.id === 'unused')
    const template = settings.processes[0]
    await writeFile(join(base, 'runs.json'), JSON.stringify([{ id: 'stale', stepId: 'analysis', sessionId: 'missing', status: 'running', startedAt: '2026-10-16T10:00:00Z', finishedAt: null, outputPath: '.aicraft/tasks/one/analysis', model: defaultStepModel(), error: null }]))
    await cp(base, join(cwd, '.aicraft/tasks/two'), { recursive: true })
    const state = JSON.parse(await readFile(join(base, 'state.json'), 'utf8'))
    await writeFile(join(cwd, '.aicraft/tasks/two/state.json'), JSON.stringify({ ...state, taskIdentifier: 'two', taskTitle: 'Second task' }))
    const snapshot = async () => {
      const paths = (await readdir(join(cwd, '.aicraft'), { recursive: true })).sort()
      return Promise.all(paths.map(async path => [path, (await stat(join(cwd, '.aicraft', path))).isFile() ? (await readFile(join(cwd, '.aicraft', path))).toString('hex') : null]))
    }
    const before = await snapshot(), blocked = /Only one open task is allowed per branch/
    for (const taskId of ['one', 'two']) {
      await assert.rejects(controller.prompt(cwd, taskId, 'analysis', signal()), blocked)
      await assert.rejects(controller.prompt(cwd, taskId, 'implementation', signal()), blocked)
      await assert.rejects(controller.defaultPrompt(cwd, taskId, 'analysis', loaded.version, signal()), blocked)
      await assert.rejects(controller.setStepModel(cwd, taskId, 'analysis', defaultStepModel(), signal()))
      await assert.rejects(controller.deleteStepMaterials(cwd, taskId, 'analysis', signal()))
      await assert.rejects(controller.start('workspace', cwd, taskId, 'analysis', null, signal()))
      await assert.rejects(updateTask(fs, noGit, cwd, taskId, 'close', null, config, signal()))
      assert.ok((await listMaterials(fs, cwd, taskId, signal())).some(group => group.id === 'step:analysis'))
      assert.equal((await readMaterial(fs, cwd, `.aicraft/tasks/${taskId}/analysis/input-prompt.md`, signal())).text, prompt)
    }
    await controller.reconcile(cwd)
    await assert.rejects(saveMaterial(fs, cwd, loaded.path, 'Stale editor must not write', loaded.version, config.lockWaitMs, signal()), blocked)
    await assert.rejects(saveProcess(fs, cwd, template.id, { ...template.definition, name: 'Blocked rename' }, template.version, config.lockWaitMs, signal()), blocked)
    await assert.rejects(saveRole(fs, cwd, role.id, 'Blocked edit', role.version, config.lockWaitMs, signal()), blocked)
    await assert.rejects(saveRole(fs, cwd, 'new-role', 'Blocked new role', null, config.lockWaitMs, signal()), blocked)
    await assert.rejects(deleteRole(fs, cwd, role.id, role.version, config.lockWaitMs, signal()), blocked)
    await assert.rejects(prepareProject(fs, noGit, cwd, config, signal()), blocked)
    assert.deepEqual(await snapshot(), before, 'No files created, removed or rewritten, including missing prompts and stale running records')
    await rm(join(cwd, '.aicraft/tasks/two'), { recursive: true })
    assert.equal(await controller.prompt(cwd, 'one', 'analysis', signal()), prompt)
    assert.equal((await saveMaterial(fs, cwd, loaded.path, 'Writable again', loaded.version, config.lockWaitMs, signal())).text, 'Writable again')
    assert.equal(project.task.kind, 'task')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
function subprocess(branch) {
  return {
    async resolveExecutable() { return 'git' },
    spawn({ argv }) {
      assert.deepEqual(argv, ['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'])
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ lossy: false, text: branch + '\n' }) } } }
    },
  }
}
function filesystem() {
  const version = text => createHash('sha256').update(text).digest('hex')
  return {
    async resolve(path, { cwd = process.cwd() } = {}) { const target = resolve(cwd, path); try { return await realpath(target) } catch (error) { if (error.code === 'ENOENT') return target; throw error } },
    contains(root, target) { const path = relative(root, target); return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path) },
    processPath(path) { return path },
    fileUrl(path) { return pathToFileURL(path).href },
    processPathFromHostPath(path) { return path },
    async lstat(path, { cwd } = {}) { try { const info = await lstat(resolve(cwd ?? '.', path)); return { type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file', version: info.isFile() ? version(await readFile(resolve(cwd ?? '.', path))) : '' } } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } },
    async stat(path) {
      try { const info = await stat(path); return { type: info.isDirectory() ? 'directory' : 'file', version: info.isDirectory() ? '' : version(await readFile(path)) } }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    },
    async listDir(path) { return (await readdir(path, { withFileTypes: true })).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', target: join(path, entry.name) })) },
    async readText(path) { return readFile(path, 'utf8') },
    async readBytes(path) { return readFile(path) },
    async writeText(path, text, guard) {
      await mkdir(join(path, '..'), { recursive: true })
      if (guard.kind === 'replaceIfVersion') assert.equal(version(await readFile(path)), guard.version)
      await writeFile(path, text, { flag: guard.kind === 'createIfAbsent' ? 'wx' : 'w' })
      return { after: text, version: version(text) }
    },
  }
}

test('branch is only an optional reminder; missing Git and detached HEAD do not cause errors', async () => {
  assert.equal(await currentBranch(noGit, '/project', config, signal()), null)
  assert.equal(await currentBranch(subprocess('master'), '/project', config, signal()), 'master')
  const detached = { ...subprocess(''), spawn() { return { done: Promise.resolve({ exitCode: 1 }) } } }
  assert.equal(await currentBranch(detached, '/project', config, signal()), null)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(currentBranch(noGit, '/project', config, controller.signal))
})

for (const branch of [null, 'main', 'master']) {
  test(`project and task lifecycle work with branch ${branch ?? 'unavailable'}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aicraft-no-git-'))
    try {
      const fs = filesystem(), runner = branch === null ? noGit : subprocess(branch)
      const prepared = await prepareProject(fs, runner, cwd, config, signal())
      assert.equal(prepared.branch, branch)
      assert.equal(prepared.creationIssue, null)
      assert.equal(await fs.stat(join(cwd, '.aicraft/config/integration-branches.json')), undefined)
      await writeFile(join(cwd, '.aicraft/config/integration-branches.json'), 'obsolete invalid config')
      const project = await createTask(fs, runner, cwd, { taskIdentifier: 'my-task', title: 'Task', processId: 'manual', requestText: 'Check task lifecycle' }, config, signal())
      const task = project.task.tasks[0]
      const state = JSON.parse(await readFile(join(cwd, '.aicraft/tasks', task.id, 'state.json'), 'utf8'))
      assert.equal(state.createdBranch ?? null, branch)
      assert.equal(state.taskType, 'manual')
      assert.equal(state.taskIdentifier, task.id)
      assert.equal(state.taskTitle, 'Task')
      assert.equal(await readFile(join(cwd, '.aicraft/tasks', task.id, 'request.md'), 'utf8'), 'Check task lifecycle\n')
      assert.ok(Array.isArray(state.stepStates))
      assert.match(state.updatedAt, /Z$/)
      assert.equal(Object.hasOwn(state, 'process'), false)
      assert.equal(Object.hasOwn(state, 'runs'), false)
      const savedProcess = await readFile(join(cwd, '.aicraft/tasks', task.id, 'process.json'), 'utf8')
      await writeFile(join(cwd, '.aicraft/config/processes/manual.jsonc'), '{"name":"Changed","steps":[{"id":"other","title":"Other","role":"developer"}]}')
      await assert.rejects(createTask(fs, runner, cwd, { taskIdentifier: 'second-task', title: 'Second', processId: 'manual', requestText: 'No second open task' }, config, signal()))
      await updateTask(fs, runner, cwd, task.id, 'move', 'implementation', config, signal())
      const completed = await updateTask(fs, runner, cwd, task.id, 'complete', 'implementation', config, signal())
      assert.equal(completed.task.tasks[0].steps[1].status, 'done')
      assert.equal(completed.task.tasks[0].currentStep, 'review')
      await updateTask(fs, runner, cwd, task.id, 'move', 'analysis', config, signal())
      assert.equal(await readFile(join(cwd, '.aicraft/tasks', task.id, 'process.json'), 'utf8'), savedProcess)
      const closed = await updateTask(fs, runner, cwd, task.id, 'close', null, config, signal())
      assert.equal(closed.task.kind, 'empty')
      assert.equal(JSON.parse(await readFile(join(cwd, '.aicraft/tasks', task.id, 'state.json'), 'utf8')).status, 'completed')
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })
}

test('executor history survives restart separately from the agreed state format', async () => {
  const { RunController } = await import('../.build/host/runs.js')
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-runs-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    const project = await createTask(fs, noGit, cwd, { taskIdentifier: 'executor', title: 'Executor', processId: 'manual', requestText: 'Check history' }, config, signal())
    const task = project.task.tasks[0]
    const statePath = join(cwd, '.aicraft/tasks', task.id, 'state.json')
    const original = await readFile(statePath, 'utf8')
    let dispatched = false
    const ctx = {
      fs, effect() {}, on() {}, get() {}, async waterfall() { return [] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      llm: { async resolveCallConfig(selection) { return selection } },
      agentPresets: { async resolve() { return { id: 'default' } } },
      workspaceRegistry: { get: () => ({ async attachSession() {} }) },
      sessionTitle: { rename() {} },
      sessionQuery: { async observeSession() { return { events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }], [Symbol.dispose]() {} } } },
      agents: {
        get() {},
        async create({ sessionId }) {
          return { agent: { session: { id: sessionId }, followup() { dispatched = true }, whenIdle: () => new Promise(() => {}) }, async dispose() {} }
        },
      },
    }
    const run = await new RunController(ctx, config).start('workspace', cwd, task.id, 'analysis', null, signal())
    assert.equal(dispatched, true)
    assert.equal(run.status, 'running')
    assert.deepEqual(run.model, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null })
    assert.equal(await readFile(statePath, 'utf8'), original)
    const runsPath = join(cwd, '.aicraft/tasks', task.id, 'runs.json')
    assert.equal(JSON.parse(await readFile(runsPath, 'utf8'))[0].sessionId, run.sessionId)
    await assert.rejects(updateTask(fs, noGit, cwd, task.id, 'complete', 'analysis', config, signal()))
    await new RunController(ctx, config).reconcile(cwd)
    assert.equal(JSON.parse(await readFile(runsPath, 'utf8'))[0].status, 'completed')
    assert.equal(await readFile(statePath, 'utf8'), original)
    const after = await updateTask(fs, noGit, cwd, task.id, 'complete', 'analysis', config, signal())
    assert.equal(after.task.tasks[0].runs[0].sessionId, run.sessionId)
    assert.equal(after.task.tasks[0].steps[0].status, 'done')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('editable input prompt is created once, saved edits are dispatched, missing prompts regenerate without run directories', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-prompt-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    const project = await createTask(fs, noGit, cwd, { taskIdentifier: 'prompt-task', title: 'Prompt task', processId: 'manual', requestText: 'Implement the requested export' }, config, signal())
    const task = project.task.tasks[0]
    const processPath = join(cwd, '.aicraft/tasks', task.id, 'process.json')
    const process = JSON.parse(await readFile(processPath, 'utf8'))
    process.steps[0].model = { provider: 'lmstudio', model: 'local-test' }
    await writeFile(processPath, JSON.stringify(process))
    const before = await readFile(join(cwd, '.aicraft/tasks', task.id, 'state.json'), 'utf8')
    let dispatched, selected
    const ctx = {
      fs, effect() {}, on() {}, get() {}, async waterfall() { return [] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'unused', model: 'unused' }) },
      llm: { async resolveCallConfig(selection) { selected = selection; return selection } },
      agents: { get() {}, async create(options) { return { agent: { session: { id: options.sessionId }, followup(message) { dispatched = message }, whenIdle: () => new Promise(() => {}) }, async dispose() {} } } },
      agentPresets: { async resolve() { return { id: 'test' } } },
      workspaceRegistry: { get: () => ({ async attachSession() {} }) },
      sessionTitle: { rename() {} },
      sessionQuery: { async observeSession() { return { events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }], [Symbol.dispose]() {} } } },
    }
    const runs = new RunController(ctx, config)
    const templatePath = join(cwd, '.aicraft/config/processes/manual.jsonc'), templateBefore = await readFile(templatePath, 'utf8')
    const assignment = { provider: 'saved-provider', model: 'saved-model', reasoningEffort: null }
    await assert.rejects(runs.setStepModel(cwd, task.id, 'analysis', null, signal()))
    assert.deepEqual(JSON.parse(await readFile(processPath, 'utf8')).steps[0].model, { provider: 'lmstudio', model: 'local-test' })
    await runs.setStepModel(cwd, task.id, 'analysis', assignment, signal())
    assert.deepEqual(JSON.parse(await readFile(processPath, 'utf8')).steps[0].model, assignment)
    assert.equal(await readFile(templatePath, 'utf8'), templateBefore)
    await assert.rejects(runs.setStepModel(cwd, task.id, 'missing', assignment, signal()), /missing/)
    const rules = '### Общие правила\n\n### Проверки\nТекст.\n\n#### Ограничения\nТекст.\n\n##### Детали\nТекст.\n\n###### Примечания\nТекст.\n\n```md\n### Заголовок в примере\n```\n'
    await writeFile(join(cwd, '.aicraft/project-rules.md'), rules)
    const customRole = '# My custom analyst\nOnly document the supplied facts.'
    await writeFile(join(cwd, '.aicraft/config/roles/analyst.md'), customRole)
    const preview = await runs.prompt(cwd, task.id, 'analysis', signal())
    assert.ok(preview.includes(rules), 'Rule Markdown is included verbatim, including heading depth and code fences')
    assert.ok(preview.includes('## Общие правила\n### Общие правила\n'), 'The wrapper must not demote the heading from project-rules.md')
    assert.equal(await readFile(join(cwd, '.aicraft/project-rules.md'), 'utf8'), rules)
    const inputPath = join(cwd, '.aicraft/tasks', task.id, 'analysis/input-prompt.md')
    assert.equal(await readFile(inputPath, 'utf8'), preview)
    assert.equal(await runs.prompt(cwd, task.id, 'analysis', signal()), preview)
    await writeFile(join(cwd, '.aicraft/project-rules.md'), rules.replace('### Общие правила', '#### Обновлённые правила'))
    assert.equal(await runs.prompt(cwd, task.id, 'analysis', signal()), preview, 'A saved input prompt is not regenerated when project rules change')
    await writeFile(join(cwd, '.aicraft/project-rules.md'), rules)
    assert.match(preview, /Implement the requested export/)
    assert.match(preview, /## Общие правила/)
    assert.match(preview, /## Роль/)
    assert.ok(preview.includes('Для простой задачи ориентируйся\nна 150–300 слов'))
    assert.ok(preview.includes(customRole))
    assert.ok(!preview.includes('Код и конфигурацию не изменяй.'))
    assert.ok(!preview.includes('Подготовь минимальный достаточный анализ'))
    assert.ok(!preview.includes('изменения кода выполняй'))
    assert.ok(!preview.includes('tasks/task_name/'))
    assert.ok(preview.includes('Рабочие каталоги этапов:\n\n- `.aicraft/tasks/'))
    assert.ok(preview.includes(`- \`.aicraft/tasks/${task.id}/analysis/\``))
    assert.ok(!preview.includes(`- \`.aicraft/tasks/${task.id}/implementation/\``))
    assert.ok(!preview.includes(`- \`.aicraft/tasks/${task.id}/review/\``))

    assert.ok(preview.includes(`.aicraft/tasks/${task.id}/analysis/report.md`))
    assert.equal(preview.includes('<run-id>'), false)
    assert.equal(await fs.stat(join(cwd, '.aicraft/tasks', task.id, 'runs.json')), undefined)
    await assert.rejects(runs.prompt(cwd, '../outside', 'analysis', signal()))
    await assert.rejects(runs.prompt(cwd, task.id, 'missing', signal()))
    await assert.rejects(runs.start('workspace', cwd, task.id, 'implementation', null, signal()))
    const edited = '# Edited assignment\nUse exactly this saved text.\n'
    await writeFile(inputPath, edited)
    assert.equal(await runs.prompt(cwd, task.id, 'analysis', signal()), edited)
    const run = await runs.start('workspace', cwd, task.id, 'analysis', null, signal())
    assert.equal(run.model.provider, 'saved-provider')
    assert.equal(selected.model, 'saved-model')
    assert.equal(await readFile(inputPath, 'utf8'), edited)
    assert.ok(JSON.stringify(dispatched).includes('Use exactly this saved text.'))
    assert.equal(await fs.stat(join(cwd, run.outputPath, 'runs')), undefined)
    assert.equal(await readFile(join(cwd, '.aicraft/tasks', task.id, 'state.json'), 'utf8'), before)
    await assert.rejects(runs.start('workspace', cwd, task.id, 'analysis', null, signal()))
    await assert.rejects(runs.setStepModel(cwd, task.id, 'analysis', assignment, signal()), /executor/)
    const resumed = new RunController(ctx, config)
    await resumed.reconcile(cwd)
    await resumed.deleteStepMaterials(cwd, task.id, 'analysis', signal())
    assert.equal(await readFile(inputPath, 'utf8'), edited)
    assert.equal(JSON.parse(await readFile(join(cwd, '.aicraft/tasks', task.id, 'runs.json'), 'utf8')).length, 1)
    const override = { provider: 'other-provider', model: 'override-model', reasoningEffort: null }
    const overridden = await resumed.start('workspace', cwd, task.id, 'analysis', override, signal())
    assert.deepEqual(overridden.model, override)
    assert.equal(await readFile(inputPath, 'utf8'), edited)
    assert.ok(JSON.stringify(dispatched).includes('Use exactly this saved text.'))
    assert.equal(await fs.stat(join(cwd, overridden.outputPath, 'runs')), undefined)
    assert.equal(JSON.parse(await readFile(join(cwd, '.aicraft/tasks', task.id, 'runs.json'), 'utf8')).length, 2)
    assert.equal(selected.provider, 'other-provider')
    assert.deepEqual(JSON.parse(await readFile(processPath, 'utf8')).steps[0].model, assignment)
    const fresh = new RunController(ctx, config)
    await fresh.reconcile(cwd)
    await fresh.setStepModel(cwd, task.id, 'analysis', defaultStepModel(), signal())
    const legacy = JSON.parse(await readFile(processPath, 'utf8'))
    legacy.steps[0].model = null
    legacy.steps[1].model = { provider: 'explicit', model: 'pro', reasoningEffort: null }
    await writeFile(processPath, JSON.stringify(legacy))
    const legacyBefore = await readFile(processPath, 'utf8')
    ctx.agentDefaultModel.currentSelection = () => { throw new Error('AICraft must not consult DSH default selection') }
    const resolveModel = ctx.llm.resolveCallConfig
    const runsBeforeMissing = await readFile(join(cwd, '.aicraft/tasks', task.id, 'runs.json'), 'utf8')
    ctx.llm.resolveCallConfig = async () => { throw new Error('Flash unavailable') }
    await assert.rejects(fresh.start('workspace', cwd, task.id, 'analysis', null, signal()), /Flash unavailable/)
    assert.equal(await readFile(join(cwd, '.aicraft/tasks', task.id, 'runs.json'), 'utf8'), runsBeforeMissing)
    ctx.llm.resolveCallConfig = resolveModel
    await rm(inputPath)
    const defaultRun = await fresh.start('workspace', cwd, task.id, 'analysis', null, signal())
    assert.equal(await readFile(inputPath, 'utf8'), preview)
    assert.deepEqual(defaultRun.model, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null })
    assert.equal(await readFile(processPath, 'utf8'), legacyBefore, 'Legacy empty assignment resolves to Flash without rewriting the process')
    await rm(inputPath)
    await symlink(join(cwd, '.aicraft/project-rules.md'), inputPath)
    await assert.rejects(fresh.prompt(cwd, task.id, 'analysis', signal()), /regular file/)
    await rm(inputPath); await mkdir(inputPath)
    await assert.rejects(fresh.prompt(cwd, task.id, 'analysis', signal()), /regular file/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('initialization writes only the selected translated or manual process and preserves existing files', async () => {
  const { processTemplate, templateRoleInstructions } = await import('../.build/host/process-templates.js')
  for (const template of ['ru', 'en', 'manual']) {
    const cwd = await mkdtemp(join(tmpdir(), 'aicraft-init-'))
    try {
      const fs = filesystem()
      const definition = { name: 'Custom process', steps: [] }
      const processId = template === 'manual' ? 'custom' : 'feature'
      const request = { template, processId, definition: template === 'manual' ? definition : null }
      if (template === 'manual') {
        await assert.rejects(prepareProject(fs, noGit, cwd, config, signal(), { ...request, definition: null }))
        assert.equal(await fs.stat(join(cwd, '.aicraft')), undefined, 'Invalid input writes nothing')
        await mkdir(join(cwd, '.aicraft'), { recursive: true })
        await writeFile(join(cwd, '.aicraft/project-rules.md'), '# Custom rules')
      }
      const project = await prepareProject(fs, noGit, cwd, config, signal(), request)
      assert.equal(project.prepared, true); assert.equal(project.needsPreparation, false)
      if (template === 'manual') assert.match(project.creationIssue, /at least one step/)
      else assert.equal(project.creationIssue, null)
      assert.deepEqual(project.processes.map(process => process.id), [processId])
      assert.deepEqual(await readdir(join(cwd, '.aicraft/config/processes')), [processId + '.jsonc'])
      const saved = JSON.parse(await readFile(join(cwd, '.aicraft/config/processes', processId + '.jsonc'), 'utf8'))
      assert.deepEqual(saved, template === 'manual' ? definition : processTemplate(template))
      if (template !== 'manual') assert.match(await readFile(join(cwd, '.aicraft/config/roles/qa.md'), 'utf8'), /^QA\./)
      else {
        const { readSettings, saveRole, saveProcess } = await import('../.build/host/settings.js')
        assert.deepEqual((await readSettings(fs, cwd, signal())).roleDocuments, [])
        assert.deepEqual((await readSettings(fs, cwd, signal())).processes[0].definition.steps, [])
        await assert.rejects(createTask(fs, noGit, cwd, { taskIdentifier: 'not-ready', title: 'Not ready', processId, requestText: 'Check' }, config, signal()), /at least one step/)
        await saveRole(fs, cwd, 'custom-role', '# Custom role\nDo the work.', null, config.lockWaitMs, signal())
        const document = (await readSettings(fs, cwd, signal())).processes[0]
        await saveProcess(fs, cwd, processId, { name: definition.name, steps: [{ id: 'work', title: 'Work', role: 'custom-role', model: defaultStepModel() }] }, document.version, config.lockWaitMs, signal())
        assert.deepEqual((await readSettings(fs, cwd, signal())).roles, ['custom-role'])
      }
      if (template === 'manual') assert.equal(await readFile(join(cwd, '.aicraft/project-rules.md'), 'utf8'), '# Custom rules')
      if (template !== 'manual') assert.match(await readFile(join(cwd, '.aicraft/project-rules.md'), 'utf8'), template === 'ru' ? /^## Общие правила\n/ : /^## Shared rules\n/)
      if (template === 'en') assert.match(project.requestTemplate, /Task requirements/)
      await assert.rejects(prepareProject(fs, noGit, cwd, config, signal(), request), /already exists/)
      const created = await createTask(fs, noGit, cwd, { taskIdentifier: 'initial-task', title: 'Initial task', processId, requestText: 'Verify setup' }, config, signal())
      assert.equal(created.task.tasks[0].steps.length, template === 'manual' ? 1 : saved.steps.length)
      if (template !== 'manual') {
        const task = created.task.tasks[0], runs = new RunController({ fs, effect() {}, on() {}, get() {} }, config)
        const expected = {
          analyst: 'Код и конфигурацию не изменяй.',
          'plan-reviewer': 'Код, конфигурацию и проверяемый план не изменяй.',
          developer: 'Код и конфигурацию изменяй с помощью предоставленных инструментов.',
          qa: 'Чтение\nисходных кодов не заменяет проверку работающего поведения.',
          reviewer: 'Отделяй подтверждённые дефекты',
          'release-manager': 'штатные средства сборки и упаковки проекта.',
        }
        for (const step of saved.steps) {
          const prompt = await runs.prompt(cwd, task.id, step.id, signal())
          const result = prompt.split(template === 'ru' ? '## Результат этого запуска\n' : '## Result of this run\n')[1]
          assert.ok(prompt.includes(templateRoleInstructions(template)[step.role]), 'Demo instructions are visible in the editable role section')
          if (template === 'ru') assert.ok(prompt.includes(expected[step.role]), `${template}: demo role retains its assignment`)
          assert.ok(!result.includes(expected[step.role]), 'Report instructions do not select behavior by role ID')
          assert.ok(result.includes(template === 'ru' ? 'не считай его отсутствующим и не переходи автоматически к изменению' : 'do not treat it as absent or automatically switch to editing files'))
          if (template === 'en') assert.doesNotMatch(prompt, /[А-Яа-яЁё]/)
          assert.ok(result.includes(`.aicraft/tasks/${task.id}/${step.id}/report.md`))
          if (step.role !== 'developer') assert.ok(!result.includes(expected.developer))
          const path = join(cwd, '.aicraft/tasks', task.id, step.id, 'input-prompt.md')
          await writeFile(path, '# Custom saved prompt\n')
          assert.equal(await runs.prompt(cwd, task.id, step.id, signal()), '# Custom saved prompt\n')
          assert.equal((await runs.defaultPrompt(cwd, task.id, step.id, (await fs.stat(path)).version, signal())).text, prompt)
          assert.equal(await readFile(path, 'utf8'), '# Custom saved prompt\n', 'Defaults never replace the saved prompt')
        }
      }
    } finally { await rm(cwd, { recursive: true, force: true }) }
  }
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-init-links-')), outside = await mkdtemp(join(tmpdir(), 'aicraft-init-outside-'))
  try {
    await symlink(outside, join(cwd, '.aicraft'))
    await assert.rejects(prepareProject(filesystem(), noGit, cwd, config, signal(), { template: 'en', processId: 'feature', definition: null }), /outside/)
    assert.deepEqual(await readdir(outside), [])
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('user-chosen task IDs name directories and collisions or invalid IDs never overwrite files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-task-id-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    const request = { taskIdentifier: 'export-report', title: 'Export report', processId: 'manual', requestText: 'Export requirements' }
    for (const id of ['', '../escape', '.hidden', 'two words', 'a/b', 'CON', 'nul', 'x'.repeat(129)]) {
      await assert.rejects(createTask(fs, noGit, cwd, { ...request, taskIdentifier: id }, config, signal()))
    }
    await mkdir(join(cwd, '.aicraft/tasks/occupied'))
    await writeFile(join(cwd, '.aicraft/tasks/occupied/keep.md'), 'Keep this')
    await assert.rejects(createTask(fs, noGit, cwd, { ...request, taskIdentifier: 'occupied' }, config, signal()), /already exists/)
    assert.equal(await readFile(join(cwd, '.aicraft/tasks/occupied/keep.md'), 'utf8'), 'Keep this')
    await mkdir(join(cwd, '.aicraft/tasks/empty'))
    await assert.rejects(createTask(fs, noGit, cwd, { ...request, taskIdentifier: 'empty' }, config, signal()), /already exists/)
    await rm(join(cwd, '.aicraft/tasks/occupied'), { recursive: true }); await rm(join(cwd, '.aicraft/tasks/empty'), { recursive: true })
    const project = await createTask(fs, noGit, cwd, request, config, signal())
    assert.equal(project.task.tasks[0].id, 'export-report')
    const statePath = join(cwd, '.aicraft/tasks/export-report/state.json')
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).taskIdentifier, 'export-report')
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).taskTitle, 'Export report')
    assert.equal(await readFile(join(cwd, '.aicraft/tasks/export-report/request.md'), 'utf8'), 'Export requirements\n')
    await updateTask(fs, noGit, cwd, 'export-report', 'close', null, config, signal())
    const before = await readFile(statePath, 'utf8')
    await assert.rejects(createTask(fs, noGit, cwd, request, config, signal()), /already exists/)
    assert.equal(await readFile(statePath, 'utf8'), before)
    assert.equal((await readdir(join(cwd, '.aicraft/tasks'))).some(id => id.startsWith('.creating-')), false)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})


test('complete and skip advance only the current step, preserve cancelled/skipped materials and leave the task open', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-step-transition-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    const project = await createTask(fs, noGit, cwd, { taskIdentifier: 'transitions', title: 'Transitions', processId: 'manual', requestText: 'Keep request' }, config, signal())
    const task = project.task.tasks[0], base = join(cwd, '.aicraft/tasks', task.id)
    const ids = ['analysis', 'cancelled-step', 'skipped-step', 'development', 'delivery']
    const route = { name: 'Transitions', steps: ids.map(id => ({ id, title: id, role: 'developer', model: null })) }
    await writeFile(join(base, 'process.json'), JSON.stringify(route))
    const state = JSON.parse(await readFile(join(base, 'state.json'), 'utf8'))
    state.stepStates = ids.map((id, i) => ({ id, status: ['current', 'cancelled', 'skipped', 'pending', 'pending'][i] }))
    await writeFile(join(base, 'state.json'), JSON.stringify(state))
    await mkdir(join(base, 'analysis'), { recursive: true })
    await writeFile(join(base, 'analysis/report.md'), 'Keep report')
    const unchanged = await readFile(join(base, 'process.json'), 'utf8')
    for (const id of ['cancelled-step', 'skipped-step', 'development']) {
      for (const operation of ['complete', 'skip']) await assert.rejects(updateTask(fs, noGit, cwd, task.id, operation, id, config, signal()), /current running/)
    }
    await writeFile(join(base, 'runs.json'), JSON.stringify([{ id: 'active', stepId: 'analysis', sessionId: 'session-active', status: 'running', startedAt: '2026-10-15T10:00:00.000Z', finishedAt: null, outputPath: '.aicraft/tasks/transitions/analysis', model: { provider: 'test', model: 'test', reasoningEffort: null }, error: null }]))
    await assert.rejects(updateTask(fs, noGit, cwd, task.id, 'skip', 'analysis', config, signal()), /active executor/)
    await writeFile(join(base, 'runs.json'), '[]')
    const completed = await updateTask(fs, noGit, cwd, task.id, 'complete', 'analysis', config, signal())
    assert.equal(completed.task.tasks[0].currentStep, 'development')
    assert.deepEqual(completed.task.tasks[0].steps.map(s => s.status), ['done', 'cancelled', 'skipped', 'current', 'pending'])
    const skipped = await updateTask(fs, noGit, cwd, task.id, 'skip', 'development', config, signal())
    assert.equal(skipped.task.tasks[0].currentStep, 'delivery')
    assert.equal(skipped.task.tasks[0].steps[3].status, 'skipped')
    await updateTask(fs, noGit, cwd, task.id, 'skip', 'delivery', config, signal())
    const final = JSON.parse(await readFile(join(base, 'state.json'), 'utf8'))
    assert.equal(final.status, 'open')
    assert.ok(final.stepStates.every(s => s.status !== 'current'))
    assert.match(final.updatedAt, /Z$/)
    assert.equal(await readFile(join(base, 'analysis/report.md'), 'utf8'), 'Keep report')
    assert.equal(await readFile(join(base, 'process.json'), 'utf8'), unchanged)
    assert.equal(await readFile(join(base, 'request.md'), 'utf8'), 'Keep request\n')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})


test('return validates source-relative earlier stages and preserves excluded statuses, route and materials', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-return-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    const project = await createTask(fs, noGit, cwd, { taskIdentifier: 'return-task', title: 'Return', processId: 'manual', requestText: 'Keep request' }, config, signal())
    const task = project.task.tasks[0], base = join(cwd, '.aicraft/tasks', task.id)
    const ids = ['analysis', 'skipped-step', 'cancelled-step', 'development', 'delivery']
    const route = { name: 'Return', steps: ids.map(id => ({ id, title: id, role: 'developer' })) }
    await writeFile(join(base, 'process.json'), JSON.stringify(route))
    const state = JSON.parse(await readFile(join(base, 'state.json'), 'utf8'))
    state.stepStates = ids.map((id, i) => ({ id, status: ['done', 'skipped', 'cancelled', 'done', 'current'][i] }))
    await writeFile(join(base, 'state.json'), JSON.stringify(state))
    await mkdir(join(base, 'development'), { recursive: true })
    await writeFile(join(base, 'development/report.md'), 'Keep report')
    const original = await readFile(join(base, 'state.json'), 'utf8')
    for (const [from, to] of [['development','analysis'], ['delivery','delivery'], ['analysis','delivery'], ['delivery','cancelled-step'], ['skipped-step','analysis'], ['cancelled-step','analysis'], ['missing','analysis'], ['delivery','missing']]) {
      await assert.rejects(updateTask(fs, noGit, cwd, task.id, 'return', to, config, signal(), from))
      assert.equal(await readFile(join(base, 'state.json'), 'utf8'), original)
    }
    state.stepStates[0].status = 'done'
    state.stepStates[3].status = 'pending'
    await writeFile(join(base, 'state.json'), JSON.stringify(state))
    await assert.rejects(updateTask(fs, noGit, cwd, task.id, 'return', 'analysis', config, signal(), 'development'), /current running/)
    state.stepStates[3].status = 'done'
    await writeFile(join(base, 'state.json'), JSON.stringify(state))
    const result = await updateTask(fs, noGit, cwd, task.id, 'return', 'analysis', config, signal(), 'delivery')
    assert.deepEqual(result.task.tasks[0].steps.map(s => s.status), ['current','skipped','cancelled','pending','pending'])
    assert.equal(result.task.tasks[0].currentStep, 'analysis')
    assert.equal(result.task.tasks[0].status, 'open')
    assert.equal(await readFile(join(base, 'development/report.md'), 'utf8'), 'Keep report')
    assert.deepEqual(JSON.parse(await readFile(join(base, 'process.json'), 'utf8')), route)
    await writeFile(join(base, 'state.json'), original)
    const skipped = await updateTask(fs, noGit, cwd, task.id, 'return', 'skipped-step', config, signal(), 'delivery')
    assert.deepEqual(skipped.task.tasks[0].steps.map(s => s.status), ['done','current','cancelled','pending','pending'])
    assert.equal(skipped.task.tasks[0].currentStep, 'skipped-step')
    assert.equal(await readFile(join(base, 'development/report.md'), 'utf8'), 'Keep report')
    assert.deepEqual(JSON.parse(await readFile(join(base, 'process.json'), 'utf8')), route)
    assert.equal(await readFile(join(base, 'request.md'), 'utf8'), 'Keep request\n')
    await updateTask(fs, noGit, cwd, task.id, 'close', null, config, signal())
    await assert.rejects(updateTask(fs, noGit, cwd, task.id, 'return', 'analysis', config, signal(), 'delivery'))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})


test('go to this step transfers current status without changing intervening or excluded stages', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-goto-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    const project = await createTask(fs, noGit, cwd, { taskIdentifier: 'jump', title: 'Jump', processId: 'manual', requestText: 'Keep request' }, config, signal())
    const task = project.task.tasks[0], base = join(cwd, '.aicraft/tasks', task.id)
    const ids = ['analysis','review','skipped-step','cancelled-step','delivery','done-step']
    const route = { name: 'Jump', steps: ids.map(id => ({ id, title: id, role: 'developer' })) }
    await writeFile(join(base, 'process.json'), JSON.stringify(route))
    const state = JSON.parse(await readFile(join(base, 'state.json'), 'utf8'))
    state.stepStates = ids.map((id,i) => ({ id, status: ['current','pending','skipped','cancelled','pending','done'][i] }))
    await writeFile(join(base, 'state.json'), JSON.stringify(state))
    await writeFile(join(base, 'runs.json'), '[]')
    await mkdir(join(base, 'analysis'), { recursive: true })
    await writeFile(join(base, 'analysis/report.md'), 'Keep report')
    const jumped = await updateTask(fs, noGit, cwd, task.id, 'goto', 'delivery', config, signal())
    assert.deepEqual(jumped.task.tasks[0].steps.map(s=>s.status), ['pending','pending','skipped','cancelled','current','done'])
    assert.deepEqual(JSON.parse(await readFile(join(base, 'state.json'), 'utf8')).stepStates.map(s=>s.status), ['pending','pending','skipped','cancelled','current','done'])
    const previous = await readFile(join(base, 'state.json'), 'utf8')
    const service = { ctx: { fs, subprocess: noGit }, config, runs: new RunController({ agents: { get() {} }, effect() {}, on() {}, get() {} }, config), projectPath() { return cwd } }
    for (const id of ['cancelled-step','missing']) {
      for (const method of ['goToStep', 'moveStep']) {
        await assert.rejects(AicraftService.prototype[method].call(service, 'workspace', task.id, id, signal()))
        assert.equal(await readFile(join(base, 'state.json'), 'utf8'), previous)
      }
    }
    const back = await updateTask(fs, noGit, cwd, task.id, 'goto', 'analysis', config, signal())
    assert.deepEqual(back.task.tasks[0].steps.map(s=>s.status), ['current','pending','skipped','cancelled','pending','done'])
    assert.deepEqual(JSON.parse(await readFile(join(base, 'process.json'), 'utf8')), route)
    assert.equal(await readFile(join(base, 'analysis/report.md'), 'utf8'), 'Keep report')
    const skipped = await updateTask(fs, noGit, cwd, task.id, 'goto', 'skipped-step', config, signal())
    assert.deepEqual(skipped.task.tasks[0].steps.map(s => s.status), ['pending','pending','current','cancelled','pending','done'])
    assert.equal(skipped.task.tasks[0].currentStep, 'skipped-step')
    assert.equal(await readFile(join(base, 'analysis/report.md'), 'utf8'), 'Keep report')
    assert.deepEqual(JSON.parse(await readFile(join(base, 'process.json'), 'utf8')), route)
    assert.equal(await readFile(join(base, 'runs.json'), 'utf8'), '[]')
    await updateTask(fs, noGit, cwd, task.id, 'skip', 'skipped-step', config, signal())
    const viaMove = await AicraftService.prototype.moveStep.call(service, 'workspace', task.id, 'skipped-step', signal())
    assert.equal(viaMove.task.tasks[0].currentStep, 'skipped-step', 'Agent move keeps skipped targets available')
    assert.equal(viaMove.task.tasks[0].steps.find(step => step.id === 'cancelled-step').status, 'cancelled', 'Moving back must not turn cancelled stages into pending')
    await assert.rejects(AicraftService.prototype.moveStep.call(service, 'workspace', task.id, 'cancelled-step', signal()), /Cancelled steps/)
    assert.equal(await readFile(join(base, 'analysis/report.md'), 'utf8'), 'Keep report')
    await updateTask(fs, noGit, cwd, task.id, 'close', null, config, signal())
    await assert.rejects(updateTask(fs, noGit, cwd, task.id, 'goto', 'delivery', config, signal()))
  } finally { await rm(cwd, { recursive:true, force:true }) }
})

test('default input prompt is read-only, saves explicitly and rejects stale or failed generation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-reset-prompt-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    const project = await createTask(fs, noGit, cwd, { taskIdentifier: 'reset-task', title: 'Reset test', processId: 'manual', requestText: 'Original request' }, config, signal())
    const task = project.task.tasks[0], runs = new RunController({ fs, effect() {}, on() {}, get() {} }, config)
    await runs.prompt(cwd, task.id, 'analysis', signal())
    const base = join(cwd, '.aicraft/tasks', task.id), input = join(base, 'analysis/input-prompt.md')
    const state = await readFile(join(base, 'state.json'), 'utf8')
    const process = await readFile(join(base, 'process.json'), 'utf8')
    await writeFile(input, '# User-edited prompt\n')
    const version = (await fs.stat(input)).version
    await writeFile(join(cwd, '.aicraft/project-rules.md'), '### Общие правила\nPreserve this heading.\n')
    await writeFile(join(cwd, '.aicraft/config/roles/analyst.md'), 'Analyst. Updated role.\n')
    await writeFile(join(base, 'request.md'), 'Updated requirements.\n')
    const reset = await runs.defaultPrompt(cwd, task.id, 'analysis', version, signal())
    assert.ok(reset.text.includes('## Общие правила\n### Общие правила\n'))
    assert.ok(reset.text.includes('Analyst. Updated role.'))
    assert.ok(reset.text.includes('Updated requirements.'))
    assert.ok(!reset.text.includes('User-edited prompt'))
    assert.equal(await readFile(input, 'utf8'), '# User-edited prompt\n')
    assert.equal(reset.version, version)
    assert.equal((await fs.stat(input)).version, version)
    assert.equal(await runs.prompt(cwd, task.id, 'analysis', signal()), '# User-edited prompt\n', 'Launch uses the old saved prompt until Save')
    await saveMaterial(fs, cwd, reset.path, reset.text, reset.version, config.lockWaitMs, signal())
    assert.equal(await runs.prompt(cwd, task.id, 'analysis', signal()), reset.text)
    await writeFile(input, 'Concurrent change')
    await assert.rejects(runs.defaultPrompt(cwd, task.id, 'analysis', reset.version, signal()), /changed outside/)
    assert.equal(await readFile(input, 'utf8'), 'Concurrent change')
    await assert.rejects(saveMaterial(fs, cwd, reset.path, reset.text, reset.version, config.lockWaitMs, signal()), /changed|version|equal/i)
    assert.equal(await readFile(input, 'utf8'), 'Concurrent change')
    await writeFile(join(cwd, '.aicraft/config/roles/analyst.md'), '')
    await assert.rejects(runs.defaultPrompt(cwd, task.id, 'analysis', (await fs.stat(input)).version, signal()), /must not be empty/)
    assert.equal(await readFile(input, 'utf8'), 'Concurrent change')
    await writeFile(join(cwd, '.aicraft/config/roles/analyst.md'), 'Invalid\0role')
    await assert.rejects(runs.defaultPrompt(cwd, task.id, 'analysis', (await fs.stat(input)).version, signal()), /NUL/)
    await writeFile(join(cwd, '.aicraft/config/roles/analyst.md'), 'Large role. ' + 'x'.repeat(2 * 1024 * 1024))
    await assert.rejects(runs.defaultPrompt(cwd, task.id, 'analysis', (await fs.stat(input)).version, signal()), /too large/)
    assert.equal(await readFile(input, 'utf8'), 'Concurrent change')
    await assert.rejects(runs.defaultPrompt(cwd, task.id, 'analysis', '', signal()), /version is required/)
    await assert.rejects(runs.defaultPrompt(cwd, task.id, 'missing', reset.version, signal()), /missing/)
    assert.equal(await readFile(join(base, 'state.json'), 'utf8'), state)
    assert.equal(await readFile(join(base, 'process.json'), 'utf8'), process)
    assert.equal(await fs.stat(join(base, 'runs.json')), undefined)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('generated prompts omit empty knowledge and later stage directories, including after reset', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-prompt-paths-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    const project = await createTask(fs, noGit, cwd, { taskIdentifier: 'paths-task', title: 'Paths', processId: 'manual', requestText: 'Test paths' }, config, signal())
    const task = project.task.tasks[0], runs = new RunController({ fs, effect() {}, on() {}, get() {} }, config)
    const first = await runs.prompt(cwd, task.id, 'analysis', signal())
    assert.ok(!first.includes('Язык проекта — русский.'), 'The plugin must not force the response language')
    assert.ok(!first.includes('.aicraft/knowledge-base/'), 'A .gitkeep-only directory is empty')
    assert.ok(first.includes('Рабочие каталоги этапов:'))
    assert.ok(!first.includes('Артефакты этапов:'))
    const stagePaths = text => [...text.matchAll(/^- `(.+\/)`$/gm)].map(match => match[1])
    const prefix = `.aicraft/tasks/${task.id}/`
    assert.deepEqual(stagePaths(first), [prefix + 'analysis/'])
    const middle = await runs.prompt(cwd, task.id, 'implementation', signal())
    assert.deepEqual(stagePaths(middle), [prefix + 'analysis/', prefix + 'implementation/'])
    assert.ok(middle.includes('Код и конфигурацию изменяй с помощью предоставленных инструментов.'))
    assert.ok(!middle.includes('Код и конфигурацию не изменяй.'))
    const last = await runs.prompt(cwd, task.id, 'review', signal())
    assert.deepEqual(stagePaths(last), [prefix + 'analysis/', prefix + 'implementation/', prefix + 'review/'])
    const path = join(cwd, prefix, 'analysis/input-prompt.md'), kb = join(cwd, '.aicraft/knowledge-base')
    const reset = async () => (await runs.defaultPrompt(cwd, task.id, 'analysis', (await fs.stat(path)).version, signal())).text
    await rm(kb, { recursive: true })
    assert.ok(!(await reset()).includes('.aicraft/knowledge-base/'), 'Missing directory is omitted')
    await mkdir(join(kb, 'nested/empty'), { recursive: true })
    assert.ok(!(await reset()).includes('.aicraft/knowledge-base/'), 'Nested empty directories are omitted')
    await writeFile(join(kb, 'nested/design.md'), 'Project knowledge')
    await writeFile(join(kb, 'nested/other.md'), 'More knowledge')
    const populated = await reset()
    assert.ok(populated.includes('База знаний: `.aicraft/knowledge-base/`'))
    assert.deepEqual(stagePaths(populated), [prefix + 'analysis/'])
    const originalList = fs.listDir
    fs.listDir = async target => { if (target.endsWith('/knowledge-base')) throw new Error('Must not scan a linked knowledge root'); return originalList(target) }
    await rm(kb, { recursive: true })
    await symlink(join(cwd, '.aicraft/config/roles'), kb)
    assert.ok(!(await reset()).includes('.aicraft/knowledge-base/'), 'Linked roots are not followed')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('finish/reopen preserves task contents, rejects active or competing tasks and serializes concurrent reopens', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-reopen-'))
  try {
    const fs = filesystem()
    await prepareProject(fs, noGit, cwd, config, signal())
    await createTask(fs, noGit, cwd, { taskIdentifier: 'first', title: 'First', processId: 'manual', requestText: 'Keep this request' }, config, signal())
    const root = join(cwd, '.aicraft/tasks/first'), statePath = join(root, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.stepStates = [{ id: 'analysis', status: 'done' }, { id: 'implementation', status: 'cancelled' }, { id: 'review', status: 'current' }]
    await writeFile(statePath, JSON.stringify(state))
    const run = { id: 'run-kept', stepId: 'analysis', sessionId: 'kept-session', status: 'completed', startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:01:00Z', outputPath: '.aicraft/tasks/first/analysis', model: { provider: 'test', model: 'test', reasoningEffort: null }, error: null }
    await writeFile(join(root, 'runs.json'), JSON.stringify([run]))
    await writeFile(join(root, 'analysis/report.md'), 'Keep report\n')
    const paths = ['request.md', 'process.json', 'runs.json', 'analysis/report.md']
    const before = await Promise.all(paths.map(path => readFile(join(root, path))))
    const finished = await updateTask(fs, noGit, cwd, 'first', 'close', null, config, signal())
    assert.equal(finished.task.kind, 'empty')
    assert.deepEqual(finished.task.allTasks[0].steps.map(step => step.status), ['done', 'cancelled', 'current'])
    const closed = JSON.parse(await readFile(statePath, 'utf8'))
    const reopened = await updateTask(fs, noGit, cwd, 'first', 'reopen', null, config, signal())
    assert.equal(reopened.task.kind, 'task')
    assert.equal(reopened.task.tasks[0].id, 'first')
    const after = JSON.parse(await readFile(statePath, 'utf8'))
    assert.deepEqual(after, { ...closed, status: 'open', updatedAt: after.updatedAt })
    assert.deepEqual(await Promise.all(paths.map(path => readFile(join(root, path)))), before)
    await assert.rejects(updateTask(fs, noGit, cwd, 'first', 'reopen', null, config, signal()), /open task/)
    await updateTask(fs, noGit, cwd, 'first', 'close', null, config, signal())
    await createTask(fs, noGit, cwd, { taskIdentifier: 'second', title: 'Second', processId: 'manual', requestText: 'Other task' }, config, signal())
    const firstBefore = await readFile(statePath)
    await assert.rejects(updateTask(fs, noGit, cwd, 'first', 'reopen', null, config, signal()), /open task/)
    assert.deepEqual(await readFile(statePath), firstBefore)
    await updateTask(fs, noGit, cwd, 'second', 'close', null, config, signal())
    const concurrent = await Promise.allSettled(['first', 'second'].map(id => updateTask(fs, noGit, cwd, id, 'reopen', null, config, signal())))
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
    const current = (await import('../.build/host/project.js')).readProject
    const snapshot = await current(fs, noGit, cwd, config, signal())
    assert.equal(snapshot.task.kind, 'task')
    await updateTask(fs, noGit, cwd, snapshot.task.tasks[0].id, 'close', null, config, signal())
    await writeFile(join(root, 'runs.json'), JSON.stringify([{ ...run, status: 'running', finishedAt: null }]))
    await assert.rejects(updateTask(fs, noGit, cwd, 'second', 'reopen', null, config, signal()), /active executor/)
    await writeFile(join(root, 'runs.json'), JSON.stringify([run]))
    await assert.rejects(updateTask(fs, noGit, cwd, 'missing', 'reopen', null, config, signal()), /not found/)
    const cancelled = JSON.parse(await readFile(statePath, 'utf8')); cancelled.status = 'cancelled'
    await writeFile(statePath, JSON.stringify(cancelled))
    assert.equal((await updateTask(fs, noGit, cwd, 'first', 'reopen', null, config, signal())).task.tasks[0].status, 'open')
    assert.deepEqual(await Promise.all(paths.map(path => readFile(join(root, path)))), before)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})


test('service reads and writes reject files linked outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicraft-service-boundaries-'))
  const cwd = join(root, 'project'), fs = filesystem(), outside = join(root, 'outside')
  try {
    await mkdir(cwd); await mkdir(outside)
    await prepareProject(fs, noGit, cwd, config, signal())
    await createTask(fs, noGit, cwd, { taskIdentifier: 'check', title: 'Check', processId: 'manual', requestText: 'Inside project' }, config, signal())
    await writeFile(join(cwd, '.aicraft/tasks/check/runs.json'), '[]')
    const controller = new RunController({ fs, subprocess: noGit, agents: { get() {} }, effect() {}, on() {}, get() {} }, config)
    const cases = [
      ['project-rules.md', () => readExecutionInputs(fs, cwd, 'check', 'analyst', signal())],
      ['config/roles/analyst.md', () => readExecutionInputs(fs, cwd, 'check', 'analyst', signal())],
      ['tasks/check/request.md', () => readExecutionInputs(fs, cwd, 'check', 'analyst', signal())],
      ['tasks/check/state.json', () => readTaskState(fs, cwd, 'check', signal())],
      ['tasks/check/process.json', () => readTaskState(fs, cwd, 'check', signal())],
      ['tasks/check/runs.json', () => readRuns(fs, cwd, 'check', signal())],
    ]
    for (const [path, read] of cases) {
      const file = join(cwd, '.aicraft', path), external = join(outside, 'linked-file')
      const original = await readFile(file)
      await writeFile(external, original); await rm(file); await symlink(external, file)
      try {
        await assert.rejects(read(), /outside/)
        await assert.rejects(controller.prompt(cwd, 'check', 'analysis', signal()))
        if (path.endsWith('state.json') || path.endsWith('process.json') || path.endsWith('runs.json')) {
          await assert.rejects(updateTask(fs, noGit, cwd, 'check', 'complete', 'analysis', config, signal()))
          await assert.rejects(controller.start('workspace', cwd, 'check', 'analysis', null, signal()))
        }
        assert.deepEqual(await readFile(external), original, `external ${path} must not change`)
        await assert.rejects(stat(join(cwd, '.aicraft/tasks/check/analysis/input-prompt.md')), { code: 'ENOENT' })
      } finally { await rm(file); await writeFile(file, original) }
    }
    const template = join(cwd, '.aicraft/config/processes/manual.jsonc'), external = join(outside, 'process.jsonc')
    const original = await readFile(template)
    await writeFile(external, original); await rm(template); await symlink(external, template)
    assert.match((await readProject(fs, noGit, cwd, config, signal())).creationIssue, /outside/)
    await rm(template); await writeFile(template, original)
    assert.match(await controller.prompt(cwd, 'check', 'analysis', signal()), /Inside project/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('external parent directory links are rejected during preparation and task reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicraft-parent-boundaries-'))
  const cwd = join(root, 'project'), external = join(root, 'external'), fs = filesystem()
  try {
    await mkdir(cwd); await mkdir(external)
    await symlink(external, join(cwd, '.aicraft'), 'dir')
    await assert.rejects(prepareProject(fs, noGit, cwd, config, signal()), /outside/)
    assert.deepEqual(await readdir(external), [])
    await rm(join(cwd, '.aicraft'))
    await prepareProject(fs, noGit, cwd, config, signal())
    await createTask(fs, noGit, cwd, { taskIdentifier: 'check', title: 'Check', processId: 'manual', requestText: 'Inside' }, config, signal())
    const tasks = join(cwd, '.aicraft/tasks'), moved = join(external, 'tasks')
    await cp(tasks, moved, { recursive: true }); await rm(tasks, { recursive: true }); await symlink(moved, tasks, 'dir')
    await assert.rejects(readTaskState(fs, cwd, 'check', signal()), /outside/)
    await assert.rejects(updateTask(fs, noGit, cwd, 'check', 'complete', 'analysis', config, signal()), /outside/)
    assert.equal(JSON.parse(await readFile(join(moved, 'check/state.json'), 'utf8')).stepStates[0].status, 'current')
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('native continuation blocks task commands and a second Run until the live agent is idle', async () => {
  for (const kind of ['turn', 'job', 'subagent']) {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-resumed-chat-')), fs = filesystem()
  try {
    await prepareProject(fs, noGit, cwd, config, signal())
    await createTask(fs, noGit, cwd, { taskIdentifier: 'check', title: 'Check', processId: 'manual', requestText: 'Check continuation' }, config, signal())
    const base = join(cwd, '.aicraft/tasks/check'), statePath = join(base, 'state.json'), runsPath = join(base, 'runs.json')
    const run = { id: 'old-run', stepId: 'analysis', sessionId: 'old-session', status: 'completed', startedAt: '2026-10-16T10:00:00Z', finishedAt: '2026-10-16T10:01:00Z', outputPath: '.aicraft/tasks/check/analysis', model: defaultStepModel(), error: null }
    await writeFile(runsPath, JSON.stringify([run]))
    const live = { status: kind === 'turn' ? 'running' : 'idle' }
    let activity = kind === 'turn' ? [] : [{ kind, items: [{ id: 'background' }] }]
    let created = 0
    const ctx = { fs, subprocess: noGit, effect() {}, on() {}, get() {}, async waterfall(event) { assert.equal(event, 'workspace/session-activity'); return activity }, agents: { get(id) { return id === run.sessionId ? live : undefined }, async create() { created++; throw new Error('Unexpected agent creation') } } }
    const controller = new RunController(ctx, config)
    const service = { ctx, config, runs: controller, projectPath() { return cwd } }
    const before = await readFile(statePath), history = await readFile(runsPath)
    assert.equal(await controller.isActive(run), true)
    await assert.rejects(controller.start('workspace', cwd, 'check', 'analysis', null, signal()), /already active/)
    const commands = [
      ['moveStep', ['implementation']], ['goToStep', ['implementation']], ['returnStep', ['analysis', 'implementation']],
      ['completeStep', ['analysis']], ['skipStep', ['analysis']], ['closeTask', []],
    ]
    for (const [method, args] of commands) {
      await assert.rejects(AicraftService.prototype[method].call(service, 'workspace', 'check', ...args, signal()), /active executor/)
    }
    await assert.rejects(controller.setStepModel(cwd, 'check', 'analysis', defaultStepModel(), signal()), /executor/)
    await assert.rejects(controller.deleteStepMaterials(cwd, 'check', 'analysis', signal()), /executor/)
    assert.equal(created, 0)
    assert.deepEqual(await readFile(statePath), before)
    assert.deepEqual(await readFile(runsPath), history)
    await assert.rejects(stat(join(base, 'analysis/input-prompt.md')), { code: 'ENOENT' })
    // Reopening also checks continued chats belonging to a closed task.
    await writeFile(statePath, JSON.stringify({ ...JSON.parse(before), status: 'completed' }))
    await assert.rejects(AicraftService.prototype.reopenTask.call(service, 'workspace', 'check', signal()), /active executor/)
    live.status = 'idle'
    activity = []
    assert.equal(await controller.isActive(run), false)
    await AicraftService.prototype.reopenTask.call(service, 'workspace', 'check', signal())
    const after = await AicraftService.prototype.completeStep.call(service, 'workspace', 'check', 'analysis', signal())
    assert.equal(after.task.tasks[0].steps[0].status, 'done')
    assert.deepEqual(await readFile(runsPath), history, 'Native continuation does not rewrite the historical run')
  } finally { await rm(cwd, { recursive: true, force: true }) }
  }
})

test('project rules rename preserves legacy content, stays read-only during queries and never overwrites both files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-rules-rename-')), fs = filesystem()
  try {
    await prepareProject(fs, noGit, cwd, config, signal())
    const canonical = join(cwd, '.aicraft/project-rules.md'), legacy = join(cwd, '.aicraft/agent-rules.md')
    assert.match(await readFile(canonical, 'utf8'), /Общие правила/)
    await assert.rejects(stat(legacy), { code: 'ENOENT' })
    const bytes = Buffer.from('### My existing rules\r\nDo not replace these instructions.\r\n')
    await rm(canonical); await writeFile(legacy, bytes)
    const before = await readProject(fs, noGit, cwd, config, signal())
    assert.equal(before.needsPreparation, false)
    await assert.rejects(stat(canonical), { code: 'ENOENT' })
    await createTask(fs, noGit, cwd, { taskIdentifier: 'check', title: 'Check', processId: 'manual', requestText: 'Check legacy rules' }, config, signal())
    assert.equal((await readExecutionInputs(fs, cwd, 'check', 'analyst', signal())).rules, bytes.toString())
    await assert.rejects(stat(canonical), { code: 'ENOENT' }, 'Reads and task creation do not migrate')
    const doc = await openProjectRules(fs, cwd, config.lockWaitMs, signal())
    assert.equal(doc.path, '.aicraft/project-rules.md')
    assert.deepEqual(await readFile(canonical), bytes, 'Rename preserves the exact bytes, including CRLF')
    await assert.rejects(stat(legacy), { code: 'ENOENT' })
    await writeFile(legacy, 'Different old rules')
    assert.equal((await openProjectRules(fs, cwd, config.lockWaitMs, signal())).text, bytes.toString())
    assert.equal(await readFile(legacy, 'utf8'), 'Different old rules', 'When both exist the old file is untouched')
    assert.equal((await readExecutionInputs(fs, cwd, 'check', 'analyst', signal())).rules, bytes.toString())
    await rm(canonical)
    await prepareProject(fs, noGit, cwd, config, signal())
    assert.equal(await readFile(canonical, 'utf8'), 'Different old rules', 'Preparation migrates old rules instead of writing defaults')
    await assert.rejects(stat(legacy), { code: 'ENOENT' })
    const base = join(cwd, '.aicraft/tasks/check'), other = join(cwd, '.aicraft/tasks/other')
    await cp(base, other, { recursive: true })
    const state = JSON.parse(await readFile(join(other, 'state.json'), 'utf8'))
    await writeFile(join(other, 'state.json'), JSON.stringify({ ...state, taskIdentifier: 'other' }))
    await rm(canonical); await writeFile(legacy, 'Ambiguous project must not rename')
    await assert.rejects(openProjectRules(fs, cwd, config.lockWaitMs, signal()), /Only one open task/)
    await assert.rejects(stat(canonical), { code: 'ENOENT' })
    assert.equal(await readFile(legacy, 'utf8'), 'Ambiguous project must not rename')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('rules migration refuses external rule file links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicraft-rules-boundaries-')), fs = filesystem()
  const cwd = join(root, 'project'), outside = join(root, 'outside.md')
  try {
    await mkdir(cwd); await prepareProject(fs, noGit, cwd, config, signal())
    const canonical = join(cwd, '.aicraft/project-rules.md'), legacy = join(cwd, '.aicraft/agent-rules.md')
    await rm(canonical); await writeFile(outside, 'Outside rules'); await symlink(outside, legacy)
    await assert.rejects(openProjectRules(fs, cwd, config.lockWaitMs, signal()), /outside/)
    assert.equal(await readFile(outside, 'utf8'), 'Outside rules')
    await assert.rejects(stat(canonical), { code: 'ENOENT' })
    await rm(legacy); await writeFile(legacy, 'Inside rules'); await symlink(outside, canonical)
    await assert.rejects(openProjectRules(fs, cwd, config.lockWaitMs, signal()), /outside/)
    assert.equal(await readFile(legacy, 'utf8'), 'Inside rules')
    assert.equal(await readFile(outside, 'utf8'), 'Outside rules')
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('completed and stopped chats stay live until archived; release preserves continuations, queues and background work', async () => {
  for (const scenario of ['idle', 'stopped', 'continued', 'release-race', 'queue', 'jobs', 'child', 'unarchive-race']) {
    const cwd = await mkdtemp(join(tmpdir(), 'aicraft-release-')), fs = filesystem()
    try {
      await prepareProject(fs, noGit, cwd, config, signal())
      await createTask(fs, noGit, cwd, { taskIdentifier: 'check', title: 'Check release', processId: 'manual', requestText: 'No real models' }, config, signal())
      const events = new Map(), effects = [], warnings = [], jobs = []
      let activity = Promise.resolve(), finishActivity = () => {}, agent, handle, closing, disposed = 0, registered, observations = 0, releaseRaceStarted = false, background = []
      const emit = (name, payload) => { for (const callback of events.get(name) ?? []) callback(payload) }
      const archive = value => emit('domain/changed', { domain: 'workspace', table: '', operation: 'put', value: { initialized: true, workspaceIds: [], archivedSessionIds: value ? [agent.session.id] : [] } })
      const startTurn = () => {
        agent.status = 'running'; agent.session.seq++
        activity = new Promise(resolve => { finishActivity = resolve })
      }
      const idle = () => { agent.status = 'idle'; agent.session.seq++; finishActivity(); emit('agent/status', { agent, status: 'idle' }) }
      let jobEvent
      const ctx = {
        fs, subprocess: noGit,
        effect(setup) { const cleanup = setup(); effects.push(cleanup); return () => cleanup?.() },
        on(name, callback) { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); return () => events.set(name, events.get(name).filter(item => item !== callback)) },
        get(name) { if (name === 'logger') return { warn(value) { warnings.push(value) } }; if (name === 'jobs') return { list() { return jobs }, events: { subscribe(_filter, callback) { jobEvent = callback; return () => {} } } } },
        async waterfall() {
          if (scenario === 'release-race' && !releaseRaceStarted) { releaseRaceStarted = true; startTurn() }
          if (scenario === 'unarchive-race' && !releaseRaceStarted) { releaseRaceStarted = true; archive(false) }
          return background
        },
        llm: { async resolveCallConfig(value) { return value } },
        agentPresets: { async resolve() { return { id: 'mock' } } },
        workspaceRegistry: { get() { return { async attachSession() {} } } },
        sessionTitle: { rename() {} },
        sessionQuery: { async observeSession() {
          if (scenario === 'continued' && observations++ === 0) startTurn()
          return { events: [{ type: 'turn/end', data: { reason: { kind: scenario === 'stopped' ? 'interrupted' : 'completed' } } }], [Symbol.dispose]() {} }
        } },
        agents: {
          get(id) { return registered?.session.id === id ? registered : undefined },
          async create({ sessionId }) {
            agent = { ctx, status: 'idle', session: { id: sessionId, seq: 0 }, inbox: { nextTurn: [], nextStep: [] }, followup() { startTurn() }, async whenIdle() { let observed; do { await (observed = activity) } while (observed !== activity) } }
            registered = agent
            handle = { agent, dispose() { return closing ??= (async () => { assert.equal(agent.status, 'idle', 'Never stop a running continuation'); assert.equal(agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0); disposed++; registered = undefined; emit('agent/disposed', { agent }) })() } }
            return handle
          },
        },
      }
      const controller = new RunController(ctx, config)
      const run = await controller.start('workspace', cwd, 'check', 'analysis', null, signal())
      if (scenario === 'queue') agent.inbox.nextTurn.push({ text: 'Pending user message' })
      if (scenario === 'jobs') jobs.push({ owner: agent.session.id, status: 'completed' })
      if (scenario === 'child') background = [{ kind: 'subagent' }]
      idle()
      const history = async () => JSON.parse(await readFile(join(cwd, '.aicraft/tasks/check/runs.json'), 'utf8'))
      await until(async () => controller.active.size === 0 && (await history())[0].status === (scenario === 'stopped' ? 'interrupted' : 'completed'))
      assert.equal(disposed, 0, 'Stopping or finishing must not dispose a non-archived chat')
      assert.equal(registered, agent)
      assert.equal(controller.handles.size, 1)
      archive(true)
      if (scenario !== 'idle' && scenario !== 'stopped') {
        // Wait until the first release attempt has decided to retain the owner.
        if (scenario === 'release-race' || scenario === 'unarchive-race') await until(() => releaseRaceStarted)
        else await until(() => controller.releasing.size === 0)
        assert.equal(disposed, 0, scenario)
        if (scenario === 'release-race') { assert.equal(agent.status, 'running'); idle() }
        if (scenario === 'unarchive-race') { await until(() => controller.releasing.size === 0); assert.equal(disposed, 0); archive(true) }
        if (scenario === 'continued') { assert.equal(agent.status, 'running'); idle() }
        if (scenario === 'queue') { assert.equal(agent.inbox.nextTurn[0].text, 'Pending user message'); agent.inbox.nextTurn.length = 0; emit('agent/inbox/discarded', { agent }) }
        if (scenario === 'jobs') { jobs.length = 0; jobEvent({ type: 'removed' }) }
        if (scenario === 'child') { background = []; emit('agent/status', { agent: { id: 'other-child' }, status: 'idle' }) }
      }
      await until(() => disposed === 1 && controller.handles.size === 0 && controller.releasing.size === 0)
      assert.equal(controller.active.size, 0)
      assert.equal((await history())[0].sessionId, run.sessionId)
      assert.equal((await history())[0].status, scenario === 'stopped' ? 'interrupted' : 'completed')
      for (const cleanup of effects) await cleanup?.()
      assert.equal(disposed, 1, 'Plugin teardown does not dispose a released handle twice')
      assert.deepEqual(warnings, [])
    } finally { await rm(cwd, { recursive: true, force: true }) }
  }
})

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for executor lifecycle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}


test('deep or unreadable artifacts remain a local error and never invalidate task state or block recovery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-deep-artifacts-')), fs = filesystem()
  try {
    await prepareProject(fs, noGit, cwd, config, signal())
    await createTask(fs, noGit, cwd, { taskIdentifier: 'deep', title: 'Deep artifacts', processId: 'manual', requestText: 'Inspect artifacts' }, config, signal())
    const base = join(cwd, '.aicraft/tasks/deep'), deep = join(base, 'analysis', ...Array(25).fill('nested'))
    await mkdir(deep, { recursive: true }); await writeFile(join(deep, 'report.md'), 'Preserved until explicit deletion')
    const view = await readProject(fs, noGit, cwd, config, signal())
    assert.equal(view.task.kind, 'task')
    assert.equal(view.task.tasks[0].steps[0].artifactCount, null)
    assert.match(view.task.tasks[0].steps[0].artifactIssue, /nesting/)
    assert.equal(view.task.tasks[0].steps[1].artifactCount, 0)
    const groups = await listMaterials(fs, cwd, 'deep', signal())
    assert.match(groups.find(group => group.id === 'step:analysis').issue, /nesting/)
    await updateTask(fs, noGit, cwd, 'deep', 'complete', 'analysis', config, signal())
    const controller = new RunController({ fs, effect() {}, on() {}, get() {} }, config)
    await controller.deleteStepMaterials(cwd, 'deep', 'analysis', signal())
    assert.equal((await readProject(fs, noGit, cwd, config, signal())).task.tasks[0].steps[0].artifactCount, 0)
    const list = fs.listDir
    fs.listDir = async path => { if (path.endsWith('/analysis')) throw new Error('Permission denied'); return list(path) }
    assert.match((await readProject(fs, noGit, cwd, config, signal())).task.tasks[0].steps[0].artifactIssue, /Permission denied/)
    fs.listDir = list
    await updateTask(fs, noGit, cwd, 'deep', 'close', null, config, signal())
    await mkdir(deep, { recursive: true }); await writeFile(join(deep, 'report.md'), 'Closed task')
    const fresh = await createTask(fs, noGit, cwd, { taskIdentifier: 'next', title: 'Next', processId: 'manual', requestText: 'Continue work' }, config, signal())
    assert.equal(fresh.task.kind, 'task')
    assert.equal(fresh.task.tasks[0].id, 'next')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('prompt language survives editing and task snapshots; legacy defaults are English and saved prompts remain untouched', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-prompt-language-')), fs = filesystem()
  try {
    await prepareProject(fs, noGit, cwd, config, signal(), { template: 'en', processId: 'feature', definition: null })
    const original = (await readSettings(fs, cwd, signal())).processes[0]
    const { language, ...edited } = original.definition
    await saveProcess(fs, cwd, 'feature', edited, original.version, config.lockWaitMs, signal())
    await createTask(fs, noGit, cwd, { taskIdentifier: 'language', title: 'Language', processId: 'feature', requestText: 'English requirements' }, config, signal())
    const state = await readTaskState(fs, cwd, 'language', signal())
    assert.equal(state.process.language, 'en')
    const runs = new RunController({ fs, effect() {}, on() {}, get() {} }, config)
    const path = '.aicraft/tasks/language/analysis/input-prompt.md'
    const text = await runs.prompt(cwd, 'language', 'analysis', signal())
    assert.match(text, /## Project rules/); assert.match(text, /Do not modify the task state.json/)
    assert.doesNotMatch(text, /[А-Яа-яЁё]/)
    await writeFile(join(cwd, path), 'Saved custom text')
    delete state.process.language
    await writeFile(join(cwd, '.aicraft/tasks/language/process.json'), JSON.stringify(state.process))
    assert.equal(await runs.prompt(cwd, 'language', 'analysis', signal()), 'Saved custom text')
    const loaded = await readMaterial(fs, cwd, path, signal())
    const reset = await runs.defaultPrompt(cwd, 'language', 'analysis', loaded.version, signal())
    assert.match(reset.text, /## Result of this run/); assert.doesNotMatch(reset.text, /[А-Яа-яЁё]/)
    assert.equal(await readFile(join(cwd, path), 'utf8'), 'Saved custom text')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
