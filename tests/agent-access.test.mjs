import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerAgentTools } from '../.build/host/tools.js'

const mutations = {
  aicraft_prepare_project: { template: 'en', processId: 'feature' },
  aicraft_create_task: { taskIdentifier: 'task', title: 'Task', processId: 'feature', requestText: 'Work' },
  aicraft_move_step: { taskId: 'task', stepId: 'step' },
  aicraft_complete_step: { taskId: 'task', stepId: 'step' },
  aicraft_go_to_step: { taskId: 'task', stepId: 'step' },
  aicraft_return_step: { taskId: 'task', stepId: 'step', fromStepId: 'later' },
  aicraft_skip_step: { taskId: 'task', stepId: 'step' },
  aicraft_close_task: { taskId: 'task' },
  aicraft_reopen_task: { taskId: 'task' },
  aicraft_start_step: { taskId: 'task', stepId: 'step' },
}
function setup(mode, outcome = 'rejected') {
  const tools = new Map(), calls = [], approvals = []
  const agent = { session: { header: { cwd: '/project' } } }
  let decision = outcome
  const policy = { resolve({ session }) { assert.equal(session, agent.session); return { mode, workspaceRoot: '/project' } } }
  const approval = { async request(request) { approvals.push(request); return typeof decision === 'function' ? decision(request) : decision } }
  const service = new Proxy({ workspaceForAgent(cwd) { assert.equal(cwd, '/project'); return 'workspace' } }, {
    get(target, name) { return name in target ? target[name] : async (...args) => { calls.push({ name, args }); return { ok: true } } },
  })
  registerAgentTools({ tools: { register(tool) { tools.set(tool.name, tool) } }, aicraft: service,
    get(name) { return name === 'sandboxPolicy' ? policy : name === 'approval' ? approval : undefined } })
  return { tools, calls, approvals, agent, setDecision(value) { decision = value },
    execute(name, signal = new AbortController().signal) { return tools.get(name).execute(mutations[name] ?? {}, { agent, callId: name, signal }) } }
}

test('every agent mutation fails closed without a per-call read-only grant', async () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const fixture = setup('read-only', outcome)
    assert.equal(fixture.tools.size, Object.keys(mutations).length + 1, 'New mutating tools must join the authorization matrix')
    for (const name of Object.keys(mutations)) await assert.rejects(fixture.execute(name))
    assert.equal(fixture.calls.length, 0, outcome)
    assert.equal(fixture.approvals.length, 10)
    assert.ok(fixture.approvals.every(call => call.agent === fixture.agent && call.reason.includes('workspace-write')))
  }
})

test('approval is one-call only, and new executors inherit standing permissions', async () => {
  const fixture = setup('read-only', 'allowed-once')
  for (const name of Object.keys(mutations)) await fixture.execute(name)
  assert.equal(fixture.calls.length, 10)
  assert.equal(fixture.approvals.length, 10)
  const start = fixture.calls.find(call => call.name === 'startStepForAgent')
  assert.equal(start.args[3], 'read-only', 'The one-shot grant must not become the child standing mode')
  fixture.setDecision('rejected')
  await assert.rejects(fixture.execute('aicraft_create_task'))
  assert.equal(fixture.calls.length, 10)
})

test('workspace-write and full-access use their standing capability without asking', async () => {
  for (const mode of ['workspace-write', 'danger-full-access']) {
    const fixture = setup(mode)
    for (const name of Object.keys(mutations)) await fixture.execute(name)
    assert.equal(fixture.calls.length, 10)
    assert.equal(fixture.approvals.length, 0)
    assert.equal(fixture.calls.find(call => call.name === 'startStepForAgent').args[3], mode)
  }
})

test('agent state reads use the non-reconciling entry and do not request write access', async () => {
  const fixture = setup('read-only')
  await fixture.execute('aicraft_project')
  assert.deepEqual(fixture.calls.map(call => call.name), ['projectForAgent'])
  assert.equal(fixture.approvals.length, 0)
})

test('missing policy, missing approval and cancellation cannot reach a mutation', async () => {
  const tools = new Map(); let entered = false
  const agent = { session: { header: { cwd: '/project' } } }
  let policy
  registerAgentTools({ tools: { register(tool) { tools.set(tool.name, tool) } }, get() { return policy },
    aicraft: { workspaceForAgent() { return 'workspace' }, async closeTask() { entered = true } } })
  const exec = { agent, callId: 'denied', signal: new AbortController().signal }
  await assert.rejects(tools.get('aicraft_close_task').execute({ taskId: 'task' }, exec), /policy service/)
  policy = { resolve() { return { mode: 'read-only', workspaceRoot: '/project' } } }
  // Only policy is composed; get('approval') must be undefined.
  const fresh = new Map()
  registerAgentTools({ tools: { register(tool) { fresh.set(tool.name, tool) } }, get(name) { return name === 'sandboxPolicy' ? policy : undefined },
    aicraft: { workspaceForAgent() { return 'workspace' }, async closeTask() { entered = true } } })
  await assert.rejects(fresh.get('aicraft_close_task').execute({ taskId: 'task' }, exec), /no approval service/)
  const controller = new AbortController();controller.abort()
  await assert.rejects(fresh.get('aicraft_close_task').execute({ taskId: 'task' }, { ...exec, signal: controller.signal }))
  const afterApproval = new AbortController()
  const aborted = setup('read-only', () => { afterApproval.abort(); return 'allowed-once' })
  await assert.rejects(aborted.execute('aicraft_create_task', afterApproval.signal))
  assert.equal(aborted.calls.length, 0, 'Cancellation after approval still prevents the operation')
  assert.equal(entered, false)
})
