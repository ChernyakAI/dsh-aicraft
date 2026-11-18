/**
 * FILE: plugin/src/dsh-integration/appearance-settings.tsx
 * DESCRIPTION: Reconcile profile appearance with native settings revisions and connection generations
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-settings/types'
import { ownMessage, withUiMessage } from '../ui-message.ts'

export type NativePreference = 'light' | 'dark' | 'system'
/** Immutable profile facts; an unanswered read is never a false preference. @backlink DATA-18 */
export interface AppearanceSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  oneCDark?: boolean
  nativePreference?: NativePreference
  revision?: number
  generation: number
  writable: boolean
  writeOutcome: 'idle' | 'pending' | 'confirmed' | 'rejected' | 'unknown'
  /** Keep the last write cause independent of subsequent profile reads. */
  reason?: unknown
  readReason?: unknown
  reconciled: boolean
  bridgeAvailable: boolean
}

/**
 * Own native profile observation independently of the settings page.
 */
export class AppearanceSettings {
  private state: AppearanceSnapshot = Object.freeze({ status: 'loading', generation: 0, writable: false,
    writeOutcome: 'idle', reconciled: false, bridgeAvailable: false })
  private listeners = new Set<() => void>()
  private alive = true
  private readonly mirror
  private readonly disposers: (() => void)[] = []
  private own?: SettingsNamespaceView
  private native?: SettingsNamespaceView
  private reading?: Promise<void>
  private reread = false
  private mirrorTrusted = true
  private readSequence = 0
  private unknownAfterRead = 0

  /** Subscribe before the first read and keep the shared DSH mirror as the native settings source. @backlink MIF-81 */
  constructor(private readonly ctx: Context) {
    this.mirror = ctx.configForms.describe()
    this.disposers.push(this.mirror.subscribe(() => this.adoptMirror()),
      ctx.on('connection/reset', () => this.reset()),
      ctx.remote.$on('settings/document-updated', () => { void this.refresh() }))
    this.adoptMirror()
    void this.refresh()
  }
  /** Read the immutable accepted profile facts. @backlink MIF-81 DATA-18 */
  getSnapshot = (): AppearanceSnapshot => this.state
  /** Observe changes until the caller releases its subscription. @backlink MIF-81 QR-7 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(value: Partial<AppearanceSnapshot>): void {
    if (!this.alive || Object.entries(value).every(([key, item]) => this.state[key as keyof AppearanceSnapshot] === item)) return
    this.state = Object.freeze({ ...this.state, ...value })
    for (const listener of this.listeners) listener()
  }
  setBridgeAvailable(value: boolean): void { this.publish({ bridgeAvailable: value }) }
  /** Start a new connection generation without comparing its revisions to the previous server. @backlink MIF-81 */
  private reset(): void {
    this.own = this.native = undefined
    this.mirrorTrusted = false
    this.publish({ generation: this.state.generation + 1, revision: undefined, status: 'loading', writable: false })
    void this.refresh()
  }
  /** Discard stale namespace answers before folding them into the shared mirror. @backlink MIF-81 DATA-18 */
  private accept(view: SettingsNamespaceView): boolean {
    const before = view.ns === 'aicraft' ? this.own : view.ns === 'ui-theme' ? this.native : undefined
    if (before && view.revision < before.revision) return false
    if (view.ns === 'aicraft') this.own = view
    else if (view.ns === 'ui-theme') this.native = view
    return true
  }
  /** Publish only complete, valid profile facts; a missing namespace is not a default false. @backlink MIF-81 */
  private derive(writable: boolean): void {
    const own = this.own?.value as { oneCDark?: unknown } | undefined
    const native = this.native?.value as { preference?: unknown } | undefined
    const preference = native?.preference
    if (typeof own?.oneCDark !== 'boolean' || !['light', 'dark', 'system'].includes(String(preference))) {
      this.publish({ status: 'unavailable', writable: false })
      return
    }
    this.publish({ status: 'ready', oneCDark: own.oneCDark, revision: this.own!.revision,
      nativePreference: preference as NativePreference, writable, readReason: undefined })
  }
  /** Reconcile ordinary native updates while preserving the connection-generation fence. @backlink MIF-81 */
  private adoptMirror(): void {
    // A reset invalidates old held mirror revisions until our fresh read settles.
    if (!this.mirrorTrusted) return
    const snapshot = this.mirror.getSnapshot()
    if (snapshot.error) {
      this.publish({ status: 'unavailable', writable: false, readReason: snapshot.error })
      return
    }
    if (snapshot.status !== 'ready' || !snapshot.view) return
    for (const row of snapshot.view.namespaces) if (['aicraft', 'ui-theme'].includes(row.ns)) this.accept(row)
    this.derive(snapshot.view.writable)
  }
  /** Read fresh Host facts, without repeating a mutation after an uncertain settlement. @backlink MIF-81 UC-218 */
  refresh = (): Promise<void> => {
    if (!this.alive) return Promise.resolve()
    if (this.reading) { this.reread = true; return this.reading }
    this.reading = Promise.resolve().then(async () => {
      do {
        this.reread = false
        const generation = this.state.generation
        const readSequence = ++this.readSequence
        try {
          const result = await this.ctx.remote.settings.describe()
          if (!this.alive || generation !== this.state.generation) continue
          if (!result.ok) throw result.error
          const rows = result.value.namespaces.filter(row => ['aicraft', 'ui-theme'].includes(row.ns))
          if (rows.length !== 2) throw withUiMessage(new Error('Appearance settings namespaces are unavailable'),
            ownMessage({ key: 'themeNamespacesUnavailable' }))
          for (const row of rows) if (this.accept(row)) this.mirror.acceptView(row)
          this.mirrorTrusted = true
          this.derive(result.value.writable)
          if (this.state.status === 'ready' && this.state.writeOutcome === 'unknown'
            && readSequence > this.unknownAfterRead) this.publish({ reconciled: true })
        } catch (reason) {
          if (this.alive && generation === this.state.generation) this.publish({ status: 'unavailable', writable: false,
            readReason: reason })
        }
      } while (this.alive && this.reread)
    }).finally(() => { this.reading = undefined })
    return this.reading
  }
  /** Submit exactly one revision-fenced write and preserve the native failure. @backlink MIF-81 UC-217 UC-218 */
  async setOneCDark(value: boolean): Promise<boolean> {
    if (!this.alive || this.state.status !== 'ready' || !this.state.writable || this.state.writeOutcome === 'pending'
      || this.state.revision === undefined) return false
    const generation = this.state.generation, revision = this.state.revision
    this.publish({ writeOutcome: 'pending', reason: undefined, reconciled: false })
    try {
      const result = await this.ctx.remote.settings.mutate('aicraft', [{ op: 'set', path: ['oneCDark'], value }], revision)
      if (!this.alive) return false
      if (generation !== this.state.generation) throw withUiMessage(new Error('Connection changed before the write was confirmed'),
        ownMessage({ key: 'themeConnectionChanged' }))
      if (!result.ok) {
        // Only the native conflict establishes refusal BEFORE persistence. Generic rejection may follow a write.
        if (result.error.code === 'settings/conflict') {
          this.publish({ writeOutcome: 'rejected', reason: result.error })
          return false
        }
        throw result.error
      }
      if (this.accept(result.value)) this.mirror.acceptView(result.value)
      this.derive(this.mirror.getSnapshot().view?.writable ?? this.state.writable)
      this.publish({ writeOutcome: 'confirmed', reason: undefined })
      return true
    } catch (reason) {
      if (this.alive) {
        this.unknownAfterRead = this.readSequence
        this.publish({ writeOutcome: 'unknown', reason, reconciled: false })
        void this.refresh()
      }
      return false
    }
  }
  /** End observation without deleting the saved profile preference. @backlink MIF-81 QR-7 */
  dispose(): void {
    this.alive = false
    for (const off of this.disposers.splice(0)) off()
    this.listeners.clear()
  }
}
