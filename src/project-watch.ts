import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent'
import type { ProjectChange, SessionActivity } from './types.ts'
import { readTaskState } from './task-state.ts'
import { artifactSummary } from './artifact-files.ts'
import { currentBranch, gitDirectory, type ProjectConfig } from './project.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One bounded invalidation queue and directory-watch tree per visible project. */
export class ProjectWatch {
  private readonly owners = new Map<AbortController, () => Promise<void>>()
  constructor(private readonly ctx: Context, private readonly config: ProjectConfig) {
    ctx.effect(() => async () => {
      const owners = [...this.owners]
      for (const [owner] of owners) owner.abort()
      await Promise.all(owners.map(([, close]) => close()))
    }, 'aicraft: project watches')
  }

  async *follow(cwd: string, taskId: string | null, caller: AbortSignal): AsyncIterable<ProjectChange> {
    if (taskId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId)) throw new Error('Invalid task identifier')
    const owner = new AbortController(), signal = AbortSignal.any([caller, owner.signal])
    const watches = new Map<string, { close(): Promise<void>; entries: Map<string, string> }>()
    const previousEntries = new Map<string, Map<string, string>>()
    const dirty = new Set<string>(), paths = new Set<string>(), sessions = new Map<string, SessionActivity>()
    const nativeActivity = new Map<string, SessionActivity>()
    let initializing = true
    let knownSessions = new Set<string>(), failure: unknown, wake: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined, gitRoot: string | null = null
    let cleanup: Promise<void> | undefined
    const finish = () => cleanup ??= (async () => {
      clearTimeout(timer); wake?.()
      await Promise.all([...watches.values()].map(watch => watch.close()))
      watches.clear()
    })()
    this.owners.set(owner, finish)
    const cancel = () => { void finish().catch(error => { failure = error }) }
    signal.addEventListener('abort', cancel, { once: true })
    const notify = () => {
      // Flush from the first event; continuous writes must not postpone chat updates.
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; wake?.(); wake = undefined }, 200)
    }
    const changed = (directory: string, error?: Error) => {
      if (signal.aborted) return
      if (error) failure = error
      dirty.add(directory); notify()
    }
    const relevant = (path: string) => path === '.aicraft' || path.startsWith('.aicraft/') || path === '.git' || path === '$git/HEAD' || path === '$git/commondir'
    const descend = (path: string) => path === '.aicraft' || path === '.aicraft/config' || path.startsWith('.aicraft/config/')
      || path === '.aicraft/tasks' || /^\.aicraft\/tasks\/[^/]+$/.test(path)
      || (taskId !== null && path.startsWith(`.aicraft/tasks/${taskId}/`))
      || path === '.aicraft/knowledge-base' || path.startsWith('.aicraft/knowledge-base/')
    const drop = async (path: string, remember = false) => {
      if (!remember) for (const name of previousEntries.keys()) if (name === path || name.startsWith(path + '/')) previousEntries.delete(name)
      for (const [name, watch] of [...watches]) if (name === path || name.startsWith(path + '/')) {
        if (remember) previousEntries.set(name, watch.entries)
        else previousEntries.delete(name)
        watches.delete(name); await watch.close()
      }
    }
    const sync = async (directory: string, initial = false, depth = 0): Promise<void> => {
      signal.throwIfAborted()
      if (depth > 24) return // Deeper artifacts have an unavailable count; keep other subscriptions alive.
      const path = directory === '$git' ? gitRoot! : directory || '.'
      const info = await this.ctx.fs.lstat(path, { cwd }, signal)
      if (info?.type !== 'directory') { await drop(directory); return }
      const target = await this.ctx.fs.resolve(path, { cwd, signal })
      if (directory !== '$git') {
        const root = await this.ctx.fs.resolve(cwd, { signal })
        if (!this.ctx.fs.contains(root, target)) throw new Error('AICraft watch directory is outside the project')
      }
      let watch = watches.get(directory)
      if (!watch) {
        const close = await this.ctx.fs.watch(target, error => changed(directory, error), signal)
        if (signal.aborted) { await close(); return }
        watch = { close, entries: previousEntries.get(directory) ?? new Map() }; previousEntries.delete(directory); watches.set(directory, watch)
      }
      const entries = new Map<string, string>(), children: string[] = []
      for (const entry of await this.ctx.fs.listDir(target, signal)) {
        if (entry.name.startsWith('.creating-') || entry.name.endsWith('.lock') || entry.name === '.gitkeep') continue
        const child = directory ? `${directory}/${entry.name}` : entry.name
        if (!relevant(child) || (directory === '$git' && !['HEAD', 'commondir'].includes(entry.name))) continue
        const metadata = await this.ctx.fs.lstat(directory === '$git' ? `${gitRoot}/${entry.name}` : child, { cwd }, signal)
        if (!metadata || metadata.type === 'symlink' || metadata.type === 'other') continue
        entries.set(child, metadata.type === 'directory' ? `directory:${metadata.version}` : String(metadata.version))
        if (metadata.type === 'directory' && descend(child)) children.push(child)
      }
      if (!initial) for (const name of new Set([...watch.entries.keys(), ...entries.keys()])) {
        if (watch.entries.get(name) !== entries.get(name)) {
          const wasDirectory = watch.entries.get(name)?.startsWith('directory:')
          const isDirectory = entries.get(name)?.startsWith('directory:')
          // Rebind replaced directories while retaining snapshots for precise diffs.
          if (wasDirectory && isDirectory) await drop(name, true)
          else { paths.add(name); if (wasDirectory) await drop(name) }
        }
      }
      watch.entries = entries
      for (const child of children) if (!watches.has(child)) await sync(child, initial, depth + 1)
    }
    const activities = async () => {
      if (taskId === null) { knownSessions.clear(); initializing = false; return [] }
      const info = await this.ctx.fs.lstat(`.aicraft/tasks/${taskId}/state.json`, { cwd }, signal)
      if (!info) { knownSessions.clear(); return [] }
      const task = await readTaskState(this.ctx.fs, cwd, taskId, signal)
      knownSessions = new Set(task.runs.map(run => run.sessionId)); initializing = false
      return task.runs.map(run => {
        const agent = this.ctx.agents.get(brandString<SessionId>(run.sessionId))
        return nativeActivity.get(run.sessionId) ?? { id: run.sessionId, running: agent ? agent.status !== 'idle' : ['starting', 'running'].includes(run.status), revision: String(agent?.session.seq ?? run.finishedAt ?? run.startedAt) }
      })
    }
    const off = this.ctx.on('session/event', (session, event) => {
      if (taskId === null || (!knownSessions.has(session.id) && !(initializing && session.header.cwd === cwd)) || !['turn/start', 'turn/end'].includes(event.type)) return
      const activity = { id: session.id, running: event.type === 'turn/start', revision: String(event.seq + 1) }
      nativeActivity.set(session.id, activity); sessions.set(session.id, activity); notify()
    })
    signal.addEventListener('abort', off, { once: true })
    try {
      await sync('', true)
      gitRoot = await gitDirectory(this.ctx.subprocess, cwd, this.config, signal)
      if (gitRoot) await sync('$git', true)
      yield { kind: 'ready', paths: [], counts: [], sessions: await activities() }
      while (!signal.aborted) {
        // Events collected during setup/read are drained before sleeping.
        if (timer !== undefined || (!dirty.size && !sessions.size && !failure)) await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) resolve() })
        signal.throwIfAborted()
        if (failure) throw failure
        const directories = [...dirty]; dirty.clear()
        for (const directory of directories) await sync(directory)
        if ([...paths].some(path => path === '.git' || path.startsWith('.git/'))) {
          await drop('$git'); gitRoot = await gitDirectory(this.ctx.subprocess, cwd, this.config, signal)
          if (gitRoot) await sync('$git', true)
          paths.add('$git/HEAD')
        }
        const changedPaths = [...paths]; paths.clear()
        if (changedPaths.some(path => path.endsWith('/runs.json'))) {
          for (const activity of await activities()) if (!sessions.has(activity.id)) sessions.set(activity.id, activity)
        }
        const counts: ProjectChange['counts'] = []
        const stepIds = new Set(changedPaths.map(path => path.match(/^\.aicraft\/tasks\/([^/]+)\/([^/]+)(?:\/|$)/)).filter(match => match && match[1] === taskId && !match[2]!.includes('.')).map(match => match![2]!))
        for (const stepId of stepIds) {
          const summary = await artifactSummary(this.ctx.fs, cwd, `.aicraft/tasks/${taskId}/${stepId}`, signal)
          counts.push({ taskId: taskId!, stepId, count: summary.artifactCount, issue: summary.artifactIssue })
        }
        const activity = [...sessions.values()].filter(item => knownSessions.has(item.id)); sessions.clear()
        if (changedPaths.length || activity.length) yield { kind: 'change', paths: changedPaths, counts, sessions: activity, ...(changedPaths.some(path => path.startsWith('$git/')) ? { branch: await currentBranch(this.ctx.subprocess, cwd, this.config, signal) } : {}) }
      }
    } finally {
      off(); signal.removeEventListener('abort', off); signal.removeEventListener('abort', cancel)
      try { await finish() } finally { this.owners.delete(owner) }
    }
  }
}
