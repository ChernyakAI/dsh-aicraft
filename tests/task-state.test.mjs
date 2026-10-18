import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTaskSnapshot, serializeState } from '../.build/host/task-state.js'

const process = { name: 'Process', steps: ['analysis', 'planning', 'implementation', 'review', 'delivery'].map(id => ({ id, title: id, role: 'developer' })) }
function fixture() {
  return {
    taskType: 'feature', taskIdentifier: 'task', taskTitle: 'Task title', status: 'open',
    stepStates: process.steps.map((step, index) => ({ id: step.id, status: ['done', 'pending', 'current', 'pending', 'cancelled'][index] })),
  }
}
async function snapshot(state, route = process, request = '# Task title\n\nRequirements') {
  const states = Array.isArray(state) ? state : [state]
  const fs = {
    async resolve(path, { cwd = '' } = {}) { return { path: path.startsWith('/') ? path : `${cwd}/${path}` } },
    contains(root, target) { return target.path === root.path || target.path.startsWith(root.path + '/') },
    async lstat() { return undefined },
    async stat(target) { return target.path.endsWith('process.json') || target.path.endsWith('runs.json') ? undefined : { type: 'directory' } },
    async listDir() { return states.map((item, index) => ({ name: Array.isArray(state) ? item.taskIdentifier : 'task', type: 'directory', target: { path: `/project/.aicraft/tasks/${Array.isArray(state) ? item.taskIdentifier : 'task'}` } })) },
    processPath(target) { return target.path },
    async readText(target) {
      if (target.path.endsWith('request.md')) return request
      if (target.path.endsWith('.jsonc')) return JSON.stringify(route)
      return JSON.stringify(states.find(item => target.path.endsWith(`/${item.taskIdentifier}/state.json`)) ?? states[0])
    },
  }
  return readTaskSnapshot(fs, '/project', new AbortController().signal)
}

test('state derives models from the process and task title from metadata without writing', async () => {
  const state = fixture(), original = JSON.stringify(state)
  const route = structuredClone(process)
  route.steps[2].model = { provider: 'local', model: 'coder' }
  const view = await snapshot(state, route)
  assert.equal(view.kind, 'task')
  assert.equal(view.tasks[0].title, 'Task title')
  assert.equal(view.tasks[0].currentStep, 'implementation')
  assert.deepEqual(view.tasks[0].steps.map(step => step.status), ['done', 'pending', 'current', 'pending', 'cancelled'])
  assert.equal(view.tasks[0].steps[2].model.model, 'coder')
  assert.equal(JSON.stringify(state), original)
})

test('optional metadata is supported and terminal tasks are excluded', async () => {
  const state = fixture()
  state.createdBranch = 'feature/task'
  state.updatedAt = '2026-10-13T10:00:00.000Z'
  assert.equal((await snapshot(state)).tasks[0].createdBranch, 'feature/task')
  for (const status of ['completed', 'cancelled']) {
    state.status = status
    const view = await snapshot(state)
    assert.equal(view.kind, 'empty')
    assert.equal(view.allTasks[0].status, status)
  }
})

test('invalid statuses, duplicate/current IDs, mismatched identity/route and invalid timestamps are rejected', async () => {
  for (const mutate of [
    s => { s.stepStates[4].status = 'failed' },
    s => { s.stepStates[0].status = 'current' },
    s => { s.stepStates[0].id = 'planning' },
    s => { s.stepStates.pop() },
    s => { s.taskIdentifier = 'other' },
    s => { s.taskType = '../feature' },
    s => { s.updatedAt = 'yesterday' },
  ]) {
    const state = fixture(); mutate(state)
    assert.equal((await snapshot(state)).kind, 'invalid')
  }
})

test('done stage remains selected until an explicit move and future pending stays pending', async () => {
  const state = fixture(); state.stepStates[2].status = 'done'
  const view = await snapshot(state)
  assert.equal(view.tasks[0].currentStep, 'implementation')
  assert.equal(view.tasks[0].steps[3].status, 'pending')
})


test('all tasks sort by updatedAt descending, undated last, without changing the single-open restriction', async () => {
  const states = [
    { ...fixture(), taskIdentifier: 'older', status: 'completed', updatedAt: '2026-10-12T10:00:00.000Z' },
    { ...fixture(), taskIdentifier: 'undated' },
    { ...fixture(), taskIdentifier: 'newer', status: 'cancelled', updatedAt: '2026-10-13T10:00:00.000Z' },
    { ...fixture(), taskIdentifier: 'undated-a', status: 'completed' },
  ]
  const view = await snapshot(states)
  assert.equal(view.kind, 'task')
  assert.deepEqual(view.tasks.map(task => task.id), ['undated'])
  assert.deepEqual(view.allTasks.map(task => task.id), ['newer', 'older', 'undated', 'undated-a'])
  states[0].status = 'open'
  assert.equal((await snapshot(states)).kind, 'ambiguous')
})

test('taskTitle is independent of Markdown headings, preserved by state writes, and legacy states remain readable', async () => {
  const state = { ...fixture(), taskTitle: 'Customer feature' }
  for (const request of ['Plain customer request.', '# A different heading\n\nRequest text.', '']) {
    assert.equal((await snapshot(state, process, request)).tasks[0].title, 'Customer feature')
  }
  const saved = JSON.parse(serializeState({ ...state, status: 'completed' }))
  assert.equal(saved.taskTitle, 'Customer feature')
  const legacy = fixture(); delete legacy.taskTitle
  assert.equal((await snapshot(legacy)).tasks[0].title, 'Task title')
  assert.equal((await snapshot(legacy, process, 'No heading')).tasks[0].title, 'task')
  assert.equal((await snapshot(legacy, process, '#    ')).tasks[0].title, 'task')
  assert.equal((await snapshot({ ...state, taskTitle: '   ' })).kind, 'invalid')
})
