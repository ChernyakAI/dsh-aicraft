/**
 * FILE: plugin/src/execution-accounting/session-source.ts
 * DESCRIPTION: Read version-guarded project-local session folds without retaining cold logs
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { interruptedTurnClosers, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import { readdir, realpath, stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { diagnosticOperation } from '../dsh-integration/diagnostics.ts'
import { accountingSchema, record, type AccountingState } from './accounting.ts'

export interface StatisticsPacket { state: AccountingState; stats: Record<string, unknown>; catalog: unknown; live: boolean }
interface Stamp { owner: object | symbol; revision: string | number; key: string }
export interface CachedPacket { stamp: Stamp; packet: StatisticsPacket }
interface Backend {
  identity: object | symbol
  name: string
  root: string
  compression: 'none' | 'zstd'
  readStoredLog(path: string, id: SessionId, signal?: AbortSignal): Promise<unknown>
}
interface Selection {
  mode: 'direct' | 'ordinary' | 'live'
  backend?: Backend
  live?: object
  path?: string
  stamp?: Stamp
  address?: string
}
class SourceChanged extends Error {}
const version = '0.2.1-rc.5'
const providerName = '@deepseek-ai/dsh-session-persistence-jsonl'
const absent = (error: unknown) => record(error).code === 'ENOENT'
const physicalRevision = (info: BigIntStats) =>
  [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')

/** Encode UTF-16 units as the pinned JSONL layout does, including isolated surrogates. */
export function encodeSessionSegment(value: string): string {
  if (!value) throw new Error('Empty session path segment')
  if (value === '.' || value === '..') return '~002E'.repeat(value.length)
  let output = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    output += /^[A-Za-z0-9._-]$/.test(char) ? char : '~' + value.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return output
}

/** The readable project key is lossy; it must never replace header cwd validation. */
export function sessionProjectKey(cwd: string): string {
  if (!cwd) throw new Error('Empty session project path')
  const slug = encodeSessionSegment(cwd.replace(/[\\/:]+/g, '-')).replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}
const sameStamp = (a?: Stamp, b?: Stamp) => !!a && !!b && a.owner === b.owner && a.revision === b.revision && a.key === b.key
const asBackend = (value: unknown) => value as Backend | undefined

/** One-shot source; the controller owns the only LRU and admission queue. */
export class SessionSource {
  constructor(private readonly ctx: Context) {}

  private backend() { return asBackend(this.ctx.get('sessionPersistence')) }
  private live(id: SessionId) { return this.ctx.get('sessions')?.get(id) }
  private check(id: SessionId, selected: Selection, signal: AbortSignal) {
    signal.throwIfAborted()
    const live = this.live(id), backend = this.backend()
    if (live !== selected.live || backend?.identity !== selected.backend?.identity
      || JSON.stringify([backend?.root, backend?.compression]) !== selected.address) throw new SourceChanged()
  }

  /** Resolve metadata from the provider's own Loader tree and verify the loaded module identity. */
  private async compatible(storage: Backend): Promise<boolean> {
    try {
      if (storage.name !== 'session-persistence-jsonl' || typeof storage.readStoredLog !== 'function'
        || typeof storage.root !== 'string' || !isAbsolute(storage.root)
        || !['none', 'zstd'].includes(storage.compression)) return false
      // Cordis service proxies overlay .ctx with the caller. Its own descriptor retains the provider context.
      const origin = Object.getOwnPropertyDescriptor(storage, 'ctx')?.value as { fiber?: { entry?: unknown } } | undefined
      const entry = record(origin?.fiber?.entry), options = record(entry.options)
      const anchor = record(record(record(entry.parent).tree).ctx).baseUrl
      const resolver = this.ctx.get('pluginPackages' as never) as unknown as {
        packageOf(specifier: string, parent: string): {
          name: string
          version?: string
          dir: string
          manifestPath: string
          manifest: Record<string, unknown>
        } | undefined
      } | undefined
      if (!resolver || options.name !== providerName || typeof anchor !== 'string' || !entry.moduleNamespace) return false
      const pkg = resolver.packageOf(providerName, anchor)
      if (pkg?.name !== providerName || pkg.version !== version) return false
      const core = resolver.packageOf('@deepseek-ai/dsh-session', pathToFileURL(pkg.manifestPath).href)
      if (core?.name !== '@deepseek-ai/dsh-session' || core.version !== version) return false
      const main = pkg.manifest.main
      if (typeof main !== 'string' || !main.startsWith('lib/')) return false
      const loaded = await import(pathToFileURL(join(pkg.dir, main)).href) as unknown
      // A refreshed resolver can point at a different installation while the old provider is still mounted.
      return loaded === entry.moduleNamespace
    } catch { return false }
  }

  private async select(cwd: string, id: SessionId, signal: AbortSignal, direct: boolean): Promise<Selection> {
    signal.throwIfAborted()
    const backend = this.backend(), live = this.live(id)
    const selected: Selection = { mode: live ? 'live' : 'ordinary', backend, live,
      address: JSON.stringify([backend?.root, backend?.compression]) }
    const checked = async <T>(work: Promise<T>): Promise<T> => {
      try { return await work }
      // Selection can fail before read receives it; recheck live/backend and cancellation on rejection too.
      finally { this.check(id, selected, signal) }
    }
    if (live) {
      selected.stamp = { owner: live, revision: live.seq, key: JSON.stringify(['live', cwd, id]) }
      return selected
    }
    if (backend && direct && await checked(this.compatible(backend))) {
      const root = normalize(backend.root), project = join(root, sessionProjectKey(cwd))
      const directory = join(project, encodeSessionSegment(id))
      const suffix = backend.compression === 'zstd' ? '.zstd' : ''
      const path = join(directory, `session.v4.jsonl${suffix}`)
      const rel = relative(root, path)
      if (rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) {
        try {
          const legacy = await checked(readdir(project))
          const encoded = encodeSessionSegment(id)
          if (!legacy.includes(encoded + '.jsonl') && !legacy.includes(encoded + '.jsonl.zstd')) {
            const names = await checked(readdir(directory))
            const generations = names.filter(name => name === 'session.jsonl' || name === 'session.jsonl.zstd'
              || /^session\.v[1-9][0-9]*\.jsonl(?:\.zstd)?$/.test(name))
            // Any opposite encoding conflicts. Lower generations may coexist; the highest is authoritative.
            const opposite = generations.some(name => name.endsWith('.zstd') !== (suffix === '.zstd'))
            const highest = Math.max(...generations.map(name => Number(/^session\.v([1-9][0-9]*)\./.exec(name)?.[1] ?? 0)))
            if (!opposite && highest === 4 && names.includes(`session.v4.jsonl${suffix}`)) {
              const realRoot = await checked(realpath(root)), realFile = await checked(realpath(path))
              if (realRoot === root && realFile === path) {
                const info = await checked(stat(path, { bigint: true }))
                if (info.isFile()) return { ...selected, mode: 'direct', path, stamp: { owner: backend.identity,
                  revision: physicalRevision(info), key: JSON.stringify(['direct', cwd, id, root, backend.compression, path]) } }
              }
            }
          }
        } catch (error) { if (!absent(error)) throw error }
      }
    }
    if (backend) {
      const info = await checked((this.ctx.get('sessionPersistence')!).stat(id, { signal }))
      if (info?.revision !== undefined) selected.stamp = { owner: backend.identity, revision: info.revision,
        key: JSON.stringify(['ordinary', cwd, id]) }
    }
    return selected
  }

  private packet(values: unknown, live: boolean): StatisticsPacket | null {
    const value = record(values), parsed = accountingSchema.safeParse(value.aicraftAccounting)
    return parsed.success ? { state: parsed.data, stats: record(value.sessionStats), catalog: value.subagentCatalog, live } : null
  }

  /** Prepare and fold from zero; persistent DSH checkpoints cannot identify a replaced physical file. */
  private async direct(cwd: string, id: SessionId, selected: Selection, signal: AbortSignal): Promise<StatisticsPacket | null> {
    return diagnosticOperation({ path: 'src/execution-accounting/session-source.ts' }, { sessionId: id }, async () => {
      const raw = record(await selected.backend!.readStoredLog(selected.path!, id, signal))
      this.check(id, selected, signal)
      const meta = record(raw.meta), events = raw.events
      const boundary = raw.inheritedEventCount
      if (raw.status !== 'current' || meta.id !== id || meta.version !== 4 || !Array.isArray(events)
        || raw.eventState !== 'shared-frozen' || !Number.isSafeInteger(boundary) || (boundary as number) < 0
        || (boundary as number) > events.length || (!meta.isSeeded && boundary !== 0)) throw new Error('Invalid stored session snapshot')
      if (raw.revision !== selected.stamp?.revision) throw new SourceChanged()
      if (typeof meta.cwd !== 'string' || !isAbsolute(meta.cwd)) throw new Error('Stored session has no valid project')
      if (normalize(meta.cwd) !== normalize(cwd)) {
        const actual = await realpath(meta.cwd), expected = await realpath(cwd)
        this.check(id, selected, signal)
        if (actual !== expected) throw new Error('Stored session belongs to another project')
      }
      const balanced = [...events as SessionEvent[], ...interruptedTurnClosers(events as SessionEvent[])]
      const prepared = this.ctx.get('sessions')!.prepare(id, { meta: structuredClone(meta) as unknown as SessionHeader,
        seed: balanced, inheritedEventCount: SessionLogOffset(boundary as number), eventState: 'shared-frozen' })
      const snapshot = this.ctx.sessionProjections.hydrate(prepared, {}, balanced, SessionLogOffset(0))
      this.check(id, selected, signal)
      return this.packet(snapshot.values, false)
    })
  }

  /** Read or validate a compact packet with one shared retry budget for source and physical changes. */
  async read(cwd: string, value: string, signal: AbortSignal, cached?: CachedPacket)
    : Promise<{ packet: StatisticsPacket | null; stamp?: Stamp }> {
    const id = brandString<SessionId>(value)
    cwd = normalize(cwd)
    let allowDirect = true
    for (let attempt = 0; attempt < 2; attempt++) {
      let selected: Selection | undefined
      try {
        selected = await this.select(cwd, id, signal, allowDirect)
        let packet: StatisticsPacket | null
        let stamp = selected.stamp
        if (sameStamp(stamp, cached?.stamp)) packet = cached!.packet
        else if (selected.mode === 'direct') packet = await this.direct(cwd, id, selected, signal)
        else {
          using observation = await this.ctx.sessionQuery.observeSession(id, { signal })
          this.check(id, selected, signal)
          packet = this.packet(observation.projections?.values, observation.source === 'live')
          const current = this.live(id)
          stamp = observation.source === 'live' && current && current.seq === observation.cursor + 1
            ? { owner: current, revision: current.seq, key: JSON.stringify(['live', cwd, id]) }
            : observation.source === 'prepared' && selected.backend && observation.revision
              ? { owner: selected.backend.identity, revision: observation.revision, key: JSON.stringify(['ordinary', cwd, id]) } : undefined
        }
        const after = await this.select(cwd, id, signal, allowDirect)
        this.check(id, selected, signal)
        if (stamp && !sameStamp(stamp, after.stamp)) throw new SourceChanged()
        signal.throwIfAborted()
        return { packet, stamp }
      } catch (error) {
        signal.throwIfAborted()
        let changed = error instanceof SourceChanged || absent(error)
        if (selected) {
          try { this.check(id, selected, signal) } catch { changed = true }
        }
        if (!changed && selected?.mode === 'direct' && record(error).name === 'SessionFormatUnsupportedError') {
          allowDirect = false
          changed = true
        }
        if (!changed || attempt === 1) throw error
      }
    }
    throw new Error('Session source remained unstable')
  }
}
