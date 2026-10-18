import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, lstat, realpath, rm, readFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { ProjectWatch } from '../.build/host/project-watch.js'

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'aicraft-watch-')), callbacks = new Map(), events = new Map(), effects = []
  const root = '.aicraft/tasks/check', step = `${root}/analysis`
  await mkdir(join(cwd, step), { recursive: true })
  await writeFile(join(cwd, root, 'state.json'), JSON.stringify({ taskIdentifier: 'check', taskType: 'feature', taskTitle: 'Watch check', status: 'open', stepStates: [{ id: 'analysis', status: 'current' }] }))
  await writeFile(join(cwd, root, 'process.json'), JSON.stringify({ name: 'Feature', steps: [{ id: 'analysis', title: 'Analysis', role: 'analyst' }] }))
  await writeFile(join(cwd, root, 'runs.json'), '[]')
  const metadata = async path => {
    try { const s = await lstat(path); return { type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : 'file', version: `${s.mtimeNs ?? s.mtimeMs}:${s.size}` } }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  const ctx = {
    fs: {
      async resolve(path, { cwd: base = cwd } = {}) { const p = resolve(base, path); try { return await realpath(p) } catch { return p } },
      contains(root, target) { const r = relative(root, target); return r !== '..' && !r.startsWith('../') && !isAbsolute(r) },
      processPath(path) { return path },
      lstat(path, { cwd: base = cwd } = {}) { return metadata(resolve(base, path)) }, stat: metadata,
      readText(path) { return readFile(path, 'utf8') },
      async listDir(path) { return (await readdir(path, { withFileTypes: true })).map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : 'file', target: join(path, item.name) })) },
      async watch(path, callback) {
        assert.equal(callbacks.has(path), false, 'only one watch per directory')
        callbacks.set(path, callback)
        return async () => { callbacks.delete(path) }
      },
    },
    agents: { get() { return undefined } },
    subprocess: { async resolveExecutable() { return 'git' }, spawn() { return { done: Promise.resolve({ exitCode: 1 }) } } },
    on(event, callback) { events.set(event, callback); return () => events.delete(event) },
    effect(setup) { effects.push(setup()) },
  }
  const owner = new ProjectWatch(ctx, { gitTimeoutMs: 1000, gitGraceMs: 100, lockWaitMs: 1000 })
  const abort = new AbortController(), stream = owner.follow(cwd, 'check', abort.signal)[Symbol.asyncIterator]()
  const change = path => { const callback = callbacks.get(resolve(cwd, path)); assert.ok(callback, `watch missing: ${path}`); callback() }
  const next = () => Promise.race([stream.next(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Watch frame timed out')), 3000); timer.unref() })])
  const close = async () => { abort.abort(); await stream.return(); assert.equal(callbacks.size, 0); assert.equal(events.size, 0); await rm(cwd, { recursive: true, force: true }) }
  return { cwd, ctx, effects, callbacks, events, stream, change, next, close, root, step, abort }
}

test('watch tree counts nested creation, atomic replacement, removal and recreation; closes on cancellation', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.next()).value.kind, 'ready')
    await mkdir(join(f.cwd, f.step, 'nested'))
    await writeFile(join(f.cwd, f.step, 'nested', 'report.md'), 'first')
    const pending = f.next(); f.change(f.step)
    const first = (await pending).value
    assert.deepEqual(first.counts, [{ taskId: 'check', stepId: 'analysis', count: 1, issue: null }])
    assert.ok(f.callbacks.has(join(f.cwd, f.step, 'nested')))
    await writeFile(join(f.cwd, f.step, 'nested', 'temporary'), 'replacement')
    await rename(join(f.cwd, f.step, 'nested', 'temporary'), join(f.cwd, f.step, 'nested', 'report.md'))
    f.change(`${f.step}/nested`)
    assert.equal((await f.next()).value.counts[0].count, 1)
    await rm(join(f.cwd, f.step), { recursive: true })
    f.change(f.root)
    assert.equal((await f.next()).value.counts[0].count, 0)
    assert.equal(f.callbacks.has(join(f.cwd, f.step, 'nested')), false)
    await mkdir(join(f.cwd, f.step), { recursive: true }); await writeFile(join(f.cwd, f.step, 'new.txt'), 'new')
    f.change(f.root)
    assert.equal((await f.next()).value.counts[0].count, 1)
    // Cancellation closes OS watchers even while the generator is suspended at yield.
    f.abort.abort(); await Promise.resolve(); await Promise.resolve()
    assert.equal(f.callbacks.size, 0)
  } finally { await f.close() }
})

test('initialization failure releases acquired watchers; no polling fallback', async () => {
  const f = await fixture(), watch = f.ctx.fs.watch
  f.ctx.fs.watch = async (...args) => {
    if (f.callbacks.size === 2) throw new Error('watch unsupported')
    return watch(...args)
  }
  try { await assert.rejects(f.next(), /watch unsupported/); assert.equal(f.callbacks.size, 0) }
  finally { await f.close() }
})

test('native chat continuation produces start/end notifications; teardown closes a stalled consumer', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, f.root, 'runs.json'), JSON.stringify([{ id: 'run-check', stepId: 'analysis', sessionId: 'session-check', status: 'completed', startedAt: '2026-10-16T10:00:00.000Z', finishedAt: '2026-10-16T10:01:00.000Z', outputPath: f.step, model: { provider: 'test', model: 'test', reasoningEffort: null }, error: null }]))
    const ready = (await f.next()).value
    assert.equal(ready.sessions[0].running, false)
    const session = { id: 'session-check' }
    f.events.get('session/event')(session, { type: 'turn/start', seq: 10 })
    assert.deepEqual((await f.next()).value.sessions, [{ id: 'session-check', running: true, revision: '11' }])
    f.events.get('session/event')(session, { type: 'turn/end', seq: 20 })
    assert.deepEqual((await f.next()).value.sessions, [{ id: 'session-check', running: false, revision: '21' }])
    for (const effect of f.effects) await effect()
    assert.equal(f.callbacks.size, 0); assert.equal(f.events.size, 0)
  } finally { await f.close() }
})

test('Git HEAD uses the resolved worktree metadata directory', async () => {
  const f = await fixture(), git = join(f.cwd, '.metadata', 'worktree')
  await mkdir(git, { recursive: true }); await writeFile(join(git, 'HEAD'), 'ref: refs/heads/first')
  await writeFile(join(f.cwd, '.git'), `gitdir: ${git}`)
  let branch = 'first'
  f.ctx.subprocess.spawn = ({ argv }) => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: argv.includes('--absolute-git-dir') ? git : branch, lossy: false }) } } })
  try {
    assert.equal((await f.next()).value.kind, 'ready')
    assert.ok(f.callbacks.has(git), 'actual worktree HEAD is watched')
    branch = 'second'; await writeFile(join(git, 'HEAD'), 'ref: refs/heads/second')
    f.callbacks.get(git)()
    const frame = (await f.next()).value
    assert.equal(frame.branch, 'second')
    assert.deepEqual(frame.paths, ['$git/HEAD'])
    assert.deepEqual(frame.counts, [])
  } finally { await f.close() }
})

test('completion arriving during the opening read wins over a still-settling agent status', async () => {
  const f = await fixture(), read = f.ctx.fs.readText
  const run = { id: 'race-run', stepId: 'analysis', sessionId: 'race-session', status: 'completed', startedAt: '2026-10-16T10:00:00.000Z', finishedAt: '2026-10-16T10:01:00.000Z', outputPath: f.step, model: { provider: 'test', model: 'test', reasoningEffort: null }, error: null }
  await writeFile(join(f.cwd, f.root, 'runs.json'), JSON.stringify([run]))
  f.ctx.agents.get = () => ({ status: 'running', session: { seq: 21 } })
  f.ctx.fs.readText = async path => {
    if (path.endsWith('/runs.json')) f.events.get('session/event')({ id: run.sessionId, header: { cwd: f.cwd } }, { type: 'turn/end', seq: 20 })
    return read(path)
  }
  try {
    const frame = (await f.next()).value
    assert.deepEqual(frame.sessions, [{ id: 'race-session', running: false, revision: '21' }])
  } finally { await f.close() }
})

test('public DSH session events notify the watcher without inserting chat metadata', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SessionStore, SessionId } = await import('@deepseek-ai/dsh-session')
  const native = new Context(), f = await fixture()
  await native.plugin(SessionStore)
  const id = SessionId('native-watch-session')
  const session = native.sessions.create(id, { meta: { cwd: f.cwd } })
  await writeFile(join(f.cwd, f.root, 'runs.json'), JSON.stringify([{ id: 'native-run', stepId: 'analysis', sessionId: id, status: 'completed', startedAt: '2026-10-16T10:00:00.000Z', finishedAt: '2026-10-16T10:01:00.000Z', outputPath: f.step, model: { provider: 'test', model: 'test', reasoningEffort: null }, error: null }]))
  f.ctx.on = native.on.bind(native)
  try {
    await f.next()
    session.append('turn/start', { turn: 1 })
    assert.equal((await f.next()).value.sessions[0].running, true)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.equal((await f.next()).value.sessions[0].running, false)
    assert.deepEqual(session.snapshotEvents().map(event => event.type), ['turn/start', 'turn/end'])
  } finally { await f.close(); await native.fiber.dispose() }
})


test('continuous events cannot postpone artifact and chat updates; no idle timer polling', { timeout: 5000 }, async t => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, f.root, 'runs.json'), JSON.stringify([{ id: 'run-check', stepId: 'analysis', sessionId: 'session-check', status: 'completed', startedAt: '2026-10-16T10:00:00Z', finishedAt: '2026-10-16T10:01:00Z', outputPath: f.step, model: { provider: 'test', model: 'test', reasoningEffort: null }, error: null }]))
    await f.next()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    await writeFile(join(f.cwd, f.step, 'report.md'), 'ready')
    const pending = f.stream.next()
    f.change(f.step)
    f.events.get('session/event')({ id: 'session-check' }, { type: 'turn/end', seq: 20 })
    for (let i = 0; i < 4; i++) { f.change(''); t.mock.timers.tick(50) }
    const frame = (await pending).value
    assert.ok(frame.paths.includes(`${f.step}/report.md`))
    assert.deepEqual(frame.counts, [{ taskId: 'check', stepId: 'analysis', count: 1, issue: null }])
    assert.deepEqual(frame.sessions, [{ id: 'session-check', running: false, revision: '21' }])
    // A subsequent batch also flushes without a quiet period.
    const second = f.stream.next()
    f.events.get('session/event')({ id: 'session-check' }, { type: 'turn/start', seq: 21 })
    for (let i = 0; i < 4; i++) { f.change(''); t.mock.timers.tick(50) }
    assert.deepEqual((await second).value.sessions, [{ id: 'session-check', running: true, revision: '22' }])
    let emitted = false
    const idle = f.stream.next().then(result => { emitted = !result.done; return result })
    t.mock.timers.tick(10000)
    await Promise.resolve()
    assert.equal(emitted, false, 'No changes are emitted without new events')
    f.abort.abort(); await assert.rejects(idle, { name: 'AbortError' })
  } finally { await f.close() }
})


test('deep artifact errors update only their count and do not terminate the subscription', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.next()).value.kind, 'ready')
    const deep = join(f.cwd, f.step, ...Array(26).fill('nested'))
    await mkdir(deep, { recursive: true }); await writeFile(join(deep, 'report.md'), 'Deep')
    f.change(f.step)
    const frame = (await f.next()).value
    assert.equal(frame.counts[0].count, null); assert.match(frame.counts[0].issue, /nesting/)
    await rm(join(f.cwd, f.step, 'nested'), { recursive: true }); f.change(f.step)
    assert.equal((await f.next()).value.counts[0].count, 0)
  } finally { await f.close() }
})
