import { readTaskSnapshot } from '../.build/host/task-state.js'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, lstat, realpath, symlink, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { resolve, relative, join, dirname, isAbsolute, sep } from 'node:path'
import { readSettings, saveProcess, saveRole, deleteRole } from '../.build/host/settings.js'
import { listMaterials, readMaterial, saveMaterial } from '../.build/host/materials.js'
const signal = () => new AbortController().signal
function filesystem() {
  const info = async (s, path, links = false) => ({ type: links && s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size, version: s.isFile() && !s.isSymbolicLink() ? createHash('sha256').update(await readFile(path)).digest('hex') : 'test' })
  return {
    fileUrl(path) { return pathToFileURL(path).href },
    processPath(path) { return path },
    processPathFromHostPath(path) { return path },
    async resolve(path, { cwd = process.cwd() } = {}) { const p = resolve(cwd, path); try { return await realpath(p) } catch (e) { if (e.code === 'ENOENT') return p; throw e } },
    contains(root, target) { const p = relative(root, target); return p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p) },
    async lstat(path, { cwd } = {}) { try { return info(await lstat(resolve(cwd, path)), resolve(cwd, path), true) } catch (e) { if (e.code === 'ENOENT') return undefined; throw e } },
    async stat(path) { try { return info(await stat(path), path) } catch (e) { if (e.code === 'ENOENT') return undefined; throw e } },
    async listDir(path) { return (await readdir(path, { withFileTypes: true })).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'symlink', target: join(path, e.name) })) },
    async writeText(path, text, guard, signal, actor) { signal?.throwIfAborted(); assert.equal(actor.mode, 'workspace-write'); if (guard.kind === 'createIfAbsent') { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { flag: 'wx' }); return { version: createHash('sha256').update(text).digest('hex'), after: text, operation: 'create' } } assert.equal(guard.kind, 'replaceIfVersion'); const before = await readFile(path, 'utf8'); assert.equal(createHash('sha256').update(before).digest('hex'), guard.version); await writeFile(path, text); return { version: createHash('sha256').update(text).digest('hex'), after: text, before, operation: 'update' } },
    async readText(path) { return readFile(path, 'utf8') },
    async readBytes(path, signal, limit) { signal?.throwIfAborted(); if ((await stat(path)).size > limit) throw new Error('File too large'); return readFile(path) },
  }
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-materials-'))
  const route = { name: 'Process', steps: [{ id: 'analysis', title: 'Анализ', role: 'analyst' }, { id: 'development', title: 'Разработка', role: 'developer' }] }
  const files = {
    '.aicraft/tasks/example/state.json': JSON.stringify({ taskType: 'feature', taskIdentifier: 'example', taskTitle: 'Example task', status: 'completed', stepStates: [{ id: 'analysis', status: 'done' }, { id: 'development', status: 'pending' }] }),
    '.aicraft/tasks/example/request.md': '# Требования\n\nПроверить материалы.',
    '.aicraft/tasks/example/analysis/report.md': '# Отчёт анализа',
    '.aicraft/tasks/example/analysis/runs/run-1/report.md': '# Отчёт запуска',
    '.aicraft/tasks/example/previous-step/report.md': '# Сохранённый материал',
    '.aicraft/config/processes/feature.jsonc': JSON.stringify(route),
    '.aicraft/config/roles/analyst.md': '# Аналитик',
    '.aicraft/knowledge-base/design.md': '# Проект',
    '.aicraft/project-rules.md': '# Правила',
  }
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), text) }
  return { cwd, files, fs: filesystem() }
}
test('closed-task requirements, nested runs, retained old stages and project materials are readable without writes', async () => {
  const { cwd, files, fs } = await fixture()
  try {
    const groups = await listMaterials(fs, cwd, 'example', signal())
    assert.equal(groups.find(g => g.id === 'request').files[0].name, 'request.md')
    assert.deepEqual(groups.find(g => g.id === 'step:analysis').files.map(f => f.name), ['report.md', 'runs/run-1/report.md'])
    assert.equal(groups.find(g => g.id === 'step:development').files.length, 0)
    assert.deepEqual(groups.map(g => g.id), ['request','step:analysis','step:development','knowledge'])
    assert.ok(groups.every(g => g.files.every(f => !f.path.includes('/previous-step/'))))
    assert.equal(groups.find(g => g.id === 'knowledge').files[0].name, 'design.md')
    assert.ok(groups.every(g => !['roles','processes','rules'].includes(g.id)))
    assert.equal((await readMaterial(fs, cwd, '.aicraft/tasks/example/request.md', signal())).format, 'markdown')
    assert.equal((await readMaterial(fs, cwd, '.aicraft/tasks/example/state.json', signal())).format, 'text')
    assert.ok((await listMaterials(fs, cwd, null, signal())).every(g => !g.id.startsWith('step:')))
    for (const [path, text] of Object.entries(files)) assert.equal(await readFile(join(cwd, path), 'utf8'), text)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
test('path traversal and symlink escapes are refused; linked documents are skipped when listing', async () => {
  const { cwd, fs } = await fixture(), outside = await mkdtemp(join(tmpdir(), 'aicraft-outside-'))
  try {
    await writeFile(join(outside, 'secret.md'), '# Outside project')
    await symlink(join(outside, 'secret.md'), join(cwd, '.aicraft/knowledge-base/linked.md'))
    await symlink(outside, join(cwd, '.aicraft/knowledge-base/linked-dir'))
    for (const path of ['.aicraft/../outside.md', '/etc/passwd', '.aicraft/knowledge-base/linked.md', '.aicraft/knowledge-base/linked-dir/secret.md']) await assert.rejects(readMaterial(fs, cwd, path, signal()))
    assert.deepEqual((await listMaterials(fs, cwd, 'example', signal())).find(g => g.id === 'knowledge').files.map(f => f.name), ['design.md'])
    await assert.rejects(listMaterials(fs, cwd, '../example', signal()))
    await symlink(outside, join(cwd, '.aicraft/tasks/escaped'))
    await assert.rejects(listMaterials(fs, cwd, 'escaped', signal()))
    const route = join(cwd, '.aicraft/config/processes/feature.jsonc')
    await writeFile(join(outside, 'feature.jsonc'), await readFile(route))
    await rm(route); await symlink(join(outside, 'feature.jsonc'), route)
    await assert.rejects(listMaterials(fs, cwd, 'example', signal()))
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})
test('binary, invalid UTF-8 and oversized documents fail; cancelled listing stops', async () => {
  const { cwd, fs } = await fixture()
  try {
    for (const [name, content] of [['binary.dat', Buffer.from([0, 1, 2])], ['invalid.dat', Buffer.from([255])], ['large.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 97)]]) {
      const path = '.aicraft/knowledge-base/' + name; await writeFile(join(cwd, path), content)
      await assert.rejects(readMaterial(fs, cwd, path, signal()))
    }
    const controller = new AbortController(); controller.abort()
    await assert.rejects(listMaterials(fs, cwd, 'example', controller.signal))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})


test('Markdown saves use the loaded version; stale, non-md, escaped and oversized writes are refused', async () => {
  const { cwd, fs } = await fixture()
  try {
    const path = '.aicraft/tasks/example/request.md'
    const original = await readMaterial(fs, cwd, path, signal())
    const saved = await saveMaterial(fs, cwd, path, '# Обновлено', original.version, 1000, signal())
    assert.equal(await readFile(join(cwd, path), 'utf8'), '# Обновлено')
    assert.notEqual(saved.version, original.version)
    await assert.rejects(saveMaterial(fs, cwd, path, '# Не перезаписывать', original.version, 1000, signal()), /changed outside/)
    assert.equal(await readFile(join(cwd, path), 'utf8'), '# Обновлено')
    for (const invalid of ['.aicraft/config/processes/feature.jsonc', '.aicraft/tasks/example/state.json', '.aicraft/../outside.md']) {
      await assert.rejects(saveMaterial(fs, cwd, invalid, 'text', saved.version, 1000, signal()))
    }
    await assert.rejects(saveMaterial(fs, cwd, path, 'x'.repeat(2 * 1024 * 1024 + 1), saved.version, 1000, signal()))
    await assert.rejects(saveMaterial(fs, cwd, path, 'binary\0text', saved.version, 1000, signal()))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a file changed during loading is never returned with a misleading save version', async () => {
  const { cwd, fs } = await fixture()
  try {
    const originalRead = fs.readBytes
    fs.readBytes = async (...args) => { const bytes = await originalRead(...args); await writeFile(args[0], '# External change'); return bytes }
    await assert.rejects(readMaterial(fs, cwd, '.aicraft/tasks/example/request.md', signal()), /changed while reading/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('process settings create/edit templates, preserve metadata and leave task snapshots unchanged', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-settings-'))
  try {
    const fs = filesystem()
    await assert.rejects(saveProcess(fs, cwd, 'missing', { name: 'Process', steps: [{ id: 'build', title: 'Build', role: 'developer' }] }, null, 1000, signal()), /Initialize/)
    await mkdir(join(cwd, '.aicraft/config/roles'), { recursive: true })
    await writeFile(join(cwd, '.aicraft/config/roles/developer.md'), '# Developer')
    await mkdir(join(cwd, '.aicraft/tasks/existing'), { recursive: true })
    await writeFile(join(cwd, '.aicraft/tasks/existing/process.json'), 'saved task snapshot')
    const input = { name: 'My process', steps: [{ id: 'implementation', title: 'Build', role: 'developer', model: null }] }
    const created = await saveProcess(fs, cwd, 'feature', input, null, 1000, signal())
    assert.equal(created.definition.steps[0].title, 'Build')
    await assert.rejects(saveProcess(fs, cwd, 'feature', input, null, 1000, signal()), /changed/)
    const file = join(cwd, '.aicraft/config/processes/feature.jsonc')
    await writeFile(file, JSON.stringify({ ...input, custom: 'retain', steps: [{ ...input.steps[0], customStep: 'retain' }] }))
    const current = (await readSettings(fs, cwd, signal())).processes[0]
    const changed = await saveProcess(fs, cwd, 'feature', { ...input, name: 'Changed', steps: [{ ...input.steps[0], title: 'Implement', model: { provider: 'local', model: 'coder', reasoningEffort: null } }] }, current.version, 1000, signal())
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.custom, 'retain'); assert.equal(saved.steps[0].customStep, 'retain')
    assert.equal(changed.definition.name, 'Changed')
    assert.deepEqual((await readSettings(fs, cwd, signal())).roles, ['developer'])
    assert.equal(await readFile(join(cwd, '.aicraft/tasks/existing/process.json'), 'utf8'), 'saved task snapshot')
    await assert.rejects(saveProcess(fs, cwd, 'feature', input, current.version, 1000, signal()), /changed/)
    await assert.rejects(saveProcess(fs, cwd, '../escape', input, null, 1000, signal()))
    await assert.rejects(saveProcess(fs, cwd, 'empty', { ...input, steps: [] }, null, 1000, signal()))
    await assert.rejects(saveProcess(fs, cwd, 'duplicate', { ...input, steps: [input.steps[0], input.steps[0]] }, null, 1000, signal()))
    await assert.rejects(saveProcess(fs, cwd, 'missing-role', { ...input, steps: [{ ...input.steps[0], role: 'absent' }] }, null, 1000, signal()))
    const outside = join(cwd, 'outside.jsonc'); await writeFile(outside, JSON.stringify(input))
    await symlink(outside, join(cwd, '.aicraft/config/processes/linked.jsonc'))
    await assert.rejects(saveProcess(fs, cwd, 'linked', input, null, 1000, signal()))
    assert.equal(await readFile(outside, 'utf8'), JSON.stringify(input))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('roles create/edit/delete with version guards and protected template/task references', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-roles-'))
  try {
    const fs = filesystem(); await mkdir(join(cwd, '.aicraft'), { recursive: true })
    const role = await saveRole(fs, cwd, 'builder', '# Builder\n\nBuild the requested feature.', null, 1000, signal())
    assert.equal((await readSettings(fs, cwd, signal())).roleDocuments[0].text, role.text)
    await assert.rejects(saveRole(fs, cwd, 'builder', role.text, null, 1000, signal()), /already exists/)
    const edited = await saveRole(fs, cwd, 'builder', '# Builder\n\nUpdated instructions.', role.version, 1000, signal())
    await assert.rejects(saveRole(fs, cwd, 'builder', 'Stale edit', role.version, 1000, signal()), /changed/)
    await assert.rejects(deleteRole(fs, cwd, 'builder', role.version, 1000, signal()), /changed/)
    const process = { name: 'Build process', steps: [{ id: 'build', title: 'Build', role: 'builder' }] }
    await saveProcess(fs, cwd, 'feature', process, null, 1000, signal())
    await assert.rejects(deleteRole(fs, cwd, 'builder', edited.version, 1000, signal()), /used by process/)
    await rm(join(cwd, '.aicraft/config/processes/feature.jsonc'))
    await mkdir(join(cwd, '.aicraft/tasks/closed'), { recursive: true })
    await writeFile(join(cwd, '.aicraft/tasks/closed/state.json'), JSON.stringify({ taskType: 'feature', status: 'completed' }))
    await writeFile(join(cwd, '.aicraft/tasks/closed/process.json'), JSON.stringify(process))
    await assert.rejects(deleteRole(fs, cwd, 'builder', edited.version, 1000, signal()), /used by task/)
    const unused = await saveRole(fs, cwd, 'unused', '# Unused role', null, 1000, signal())
    await deleteRole(fs, cwd, 'unused', unused.version, 1000, signal())
    assert.equal(await fs.stat(join(cwd, '.aicraft/config/roles/unused.md')), undefined)
    assert.equal(await readFile(join(cwd, '.aicraft/config/roles/builder.md'), 'utf8'), edited.text)
    await assert.rejects(saveRole(fs, cwd, '../escape', 'Role text', null, 1000, signal()))
    await assert.rejects(saveRole(fs, cwd, 'empty', '   ', null, 1000, signal()))
    const outside = join(cwd, 'outside.md'); await writeFile(outside, '# Outside')
    await symlink(outside, join(cwd, '.aicraft/config/roles/escape.md'))
    await assert.rejects(saveRole(fs, cwd, 'escape', '# Changed', null, 1000, signal()))
    await assert.rejects(deleteRole(fs, cwd, 'escape', 'fake-version', 1000, signal()))
    assert.equal(await readFile(outside, 'utf8'), '# Outside')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})


test('bundled Ru/En process templates share the route and default model, with independent editable copies', async () => {
  const { processTemplate, templateRoleInstructions } = await import('../.build/host/process-templates.js')
  const { processSchema } = await import('../.build/host/schemas.js')
  const ru = processTemplate('ru'), en = processTemplate('en')
  processSchema.parse(ru); processSchema.parse(en)
  assert.equal(ru.steps.length, 6)
  const route = value => value.steps.map(({ id, role, model }) => ({ id, role, model }))
  assert.deepEqual(route(ru), route(en))
  assert.deepEqual(ru.steps.slice(0, 3).map(step => step.role), ['analyst', 'plan-reviewer', 'developer'])
  assert.deepEqual(ru.steps.map(step => step.model), Array.from({ length: 6 }, () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null })))
  const legacy = processSchema.parse({ name: 'Legacy', steps: [{ id: 'old', title: 'Old', role: 'analyst', model: null }, { id: 'missing', title: 'Missing', role: 'developer' }, { id: 'explicit', title: 'Explicit', role: 'developer', model: { provider: 'custom', model: 'pro' } }] })
  assert.deepEqual(legacy.steps[0].model, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null })
  assert.deepEqual(legacy.steps[1].model, legacy.steps[0].model)
  assert.equal(legacy.steps[2].model.model, 'pro')
  ru.steps[0].model.model = 'changed'
  assert.equal(processTemplate('ru').steps[0].model.model, 'deepseek-flash')
  assert.ok(ru.steps.every((step, index) => step.title !== en.steps[index].title))
  ru.steps[0].title = 'Edited'; ru.steps.pop()
  assert.equal(processTemplate('ru').steps.length, 6)
  assert.equal(processTemplate('ru').steps[0].title, 'Анализ / планирование')
  assert.equal(en.steps[3].role, 'qa')
  assert.equal(en.steps[4].title, 'Implementation review')
  assert.equal(processTemplate('ru').steps[4].title, 'Ревью реализации')
  assert.deepEqual(en.steps.map(step => step.id), ['analysis', 'plan-review', 'development', 'testing', 'review', 'delivery'])
  assert.match(templateRoleInstructions('ru')['release-manager'], /Обнови необходимую документацию/)
  assert.match(templateRoleInstructions('en')['release-manager'], /Update necessary documentation/)
  assert.deepEqual(Object.keys(templateRoleInstructions('ru')), Object.keys(templateRoleInstructions('en')))
  assert.match(templateRoleInstructions('ru').analyst, /Подготовь минимальный достаточный анализ/)
  assert.match(templateRoleInstructions('en').analyst, /Prepare the minimum sufficient analysis/)
  for (const language of ['ru', 'en']) for (const text of Object.values(templateRoleInstructions(language))) {
    assert.doesNotMatch(text, /^#/m)
    assert.ok(text.includes('\n\n'), 'Role-specific assignments are editable paragraphs in the role file')
    assert.match(text, /^[^\n]+\. /)
  }
  for (const language of ['ru', 'en']) {
    const cwd = await mkdtemp(join(tmpdir(), 'aicraft-template-'))
    try {
      const fs = filesystem()
      await mkdir(join(cwd, '.aicraft/config/roles'), { recursive: true })
      await writeFile(join(cwd, '.aicraft/config/roles/developer.md'), '# Custom developer')
      const input = processTemplate(language)
      const saved = await saveProcess(fs, cwd, 'feature', input, null, 1000, signal(), language)
      assert.deepEqual(saved.definition, input)
      assert.equal(await readFile(join(cwd, '.aicraft/config/roles/developer.md'), 'utf8'), '# Custom developer')
      const instructions = templateRoleInstructions(language)
      assert.equal(await readFile(join(cwd, '.aicraft/config/roles/qa.md'), 'utf8'), instructions.qa)
      assert.equal(await readFile(join(cwd, '.aicraft/config/roles/plan-reviewer.md'), 'utf8'), instructions['plan-reviewer'])
      assert.deepEqual(await readdir(join(cwd, '.aicraft/config/processes')), ['feature.jsonc'])
      await assert.rejects(saveProcess(fs, cwd, 'feature', input, saved.version, 1000, signal(), language), /only for a new process/)
    } finally { await rm(cwd, { recursive: true, force: true }) }
  }

})

test('step material deletion is confined, preserves state/history, blocks active executors and allows a fresh run', async () => {
  const { RunController } = await import('../.build/host/runs.js')
  const { cwd, fs } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'aicraft-clear-outside-'))
  let agentStatus = 'idle'
  const controller = new RunController({ fs, effect() {}, on() {}, get() {}, async waterfall() { return [] }, agents: { get() { return { status: agentStatus } } } }, { lockWaitMs: 1000 })
  try {
    const statePath = join(cwd, '.aicraft/tasks/example/state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')); state.status = 'open'; state.stepStates[0].status = 'current'
    await writeFile(statePath, JSON.stringify(state))
    const historyPath = join(cwd, '.aicraft/tasks/example/runs.json')
    const run = { id: 'run-1', stepId: 'analysis', sessionId: 'session-1', status: 'completed', startedAt: '2026-10-14T10:00:00.000Z', finishedAt: '2026-10-14T10:01:00.000Z', outputPath: '.aicraft/tasks/example/analysis/runs/run-1', model: { provider: 'test', model: 'test', reasoningEffort: null }, error: null }
    await writeFile(historyPath, JSON.stringify([run]))
    const reportPath = join(cwd, '.aicraft/tasks/example/analysis/report.md')
    for (const status of ['starting', 'running']) {
      await writeFile(historyPath, JSON.stringify([{ ...run, status }]))
      await assert.rejects(controller.deleteStepMaterials(cwd, 'example', 'analysis', signal()), /Stop/)
      assert.ok(await readFile(reportPath))
    }
    await writeFile(historyPath, JSON.stringify([run])); agentStatus = 'running'
    await assert.rejects(controller.deleteStepMaterials(cwd, 'example', 'analysis', signal()), /Stop/)
    agentStatus = 'idle'
    await assert.rejects(controller.deleteStepMaterials(cwd, '../example', 'analysis', signal()), /Invalid/)
    await assert.rejects(controller.deleteStepMaterials(cwd, 'example', '../analysis', signal()), /Invalid/)
    await assert.rejects(controller.deleteStepMaterials(cwd, 'example', 'missing', signal()), /missing/)
    const victim = join(outside, 'keep.md'); await writeFile(victim, 'Keep outside')
    await symlink(outside, join(cwd, '.aicraft/tasks/example/development'))
    await assert.rejects(controller.deleteStepMaterials(cwd, 'example', 'development', signal()), /outside/)
    await symlink(victim, join(cwd, '.aicraft/tasks/example/analysis/linked.md'))
    await writeFile(join(cwd, '.aicraft/tasks/example/analysis/.gitkeep'), '')
    const inputPath = join(cwd, '.aicraft/tasks/example/analysis/input-prompt.md')
    const editedPrompt = Buffer.from('# Изменённое задание\r\nСохранить пользовательские правки.\r\n')
    await writeFile(inputPath, editedPrompt)
    const stateBefore = await readFile(statePath, 'utf8'), historyBefore = await readFile(historyPath, 'utf8')
    const requestBefore = await readFile(join(cwd, '.aicraft/tasks/example/request.md'), 'utf8')
    await controller.deleteStepMaterials(cwd, 'example', 'analysis', signal())
    assert.deepEqual((await readdir(join(cwd, '.aicraft/tasks/example/analysis'))).sort(), ['.gitkeep','input-prompt.md'])
    assert.deepEqual(await readFile(inputPath), editedPrompt)
    assert.equal(await readFile(statePath, 'utf8'), stateBefore)
    assert.equal(await readFile(historyPath, 'utf8'), historyBefore)
    assert.equal(await readFile(join(cwd, '.aicraft/tasks/example/request.md'), 'utf8'), requestBefore)
    assert.equal(await readFile(victim, 'utf8'), 'Keep outside')
    // A repeated cleanup is harmless; the directory remains available for new results.
    await controller.deleteStepMaterials(cwd, 'example', 'analysis', signal())
    assert.deepEqual(await readFile(inputPath), editedPrompt)
    await writeFile(reportPath, 'Fresh report'); assert.equal(await readFile(reportPath, 'utf8'), 'Fresh report')
    await writeFile(statePath, JSON.stringify({ ...state, status: 'completed' }))
    await assert.rejects(controller.deleteStepMaterials(cwd, 'example', 'analysis', signal()), /open/)
    assert.equal(await readFile(reportPath, 'utf8'), 'Fresh report')
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})


test('artifact counts match recursive artifact lists, ignore placeholders/links and update after file changes', async () => {
  const { cwd, fs } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'aicraft-count-outside-'))
  try {
    const base = join(cwd, '.aicraft/tasks/example')
    await mkdir(join(base, 'development'), { recursive: true })
    await writeFile(join(base, 'development/.gitkeep'), '')
    await writeFile(join(base, 'analysis/input-prompt.md'), '# Input')
    await writeFile(join(outside, 'keep.md'), '# Outside')
    await symlink(join(outside, 'keep.md'), join(base, 'analysis/linked.md'))
    await symlink(outside, join(base, 'analysis/linked-dir'))
    const view = await readTaskSnapshot(fs, cwd, signal())
    assert.equal(view.kind, 'empty') // fixture contains a closed task, still shown in the picker.
    const task = view.allTasks[0]
    assert.equal(task.steps.find(s => s.id === 'analysis').artifactCount, 3)
    assert.equal(task.steps.find(s => s.id === 'development').artifactCount, 0)
    const groups = await listMaterials(fs, cwd, 'example', signal())
    for (const step of task.steps) assert.equal(step.artifactCount, groups.find(g => g.id === 'step:' + step.id).files.length)
    await writeFile(join(base, 'development/report.md'), '# New report')
    assert.equal((await readTaskSnapshot(fs, cwd, signal())).allTasks[0].steps.find(s => s.id === 'development').artifactCount, 1)
    await rm(join(base, 'analysis/report.md'))
    assert.equal((await readTaskSnapshot(fs, cwd, signal())).allTasks[0].steps.find(s => s.id === 'analysis').artifactCount, 2)
    assert.equal(await readFile(join(outside, 'keep.md'), 'utf8'), '# Outside')
    await Promise.all(Array.from({ length: 500 }, (_,i) => writeFile(join(base, 'development', `artifact-${i}.txt`), 'data')))
    assert.equal((await readTaskSnapshot(fs, cwd, signal())).allTasks[0].steps.find(s => s.id === 'development').artifactCount, 501)
    assert.match((await listMaterials(fs, cwd, 'example', signal())).find(group => group.id === 'step:development').issue, /500 files/)
  } finally { await rm(cwd, { recursive:true, force:true }); await rm(outside, { recursive:true, force:true }) }
})
