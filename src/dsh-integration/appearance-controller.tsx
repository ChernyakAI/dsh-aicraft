/**
 * FILE: plugin/src/dsh-integration/appearance-controller.tsx
 * DESCRIPTION: Own OneC Dark registration, native choice bridge and teardown outside panel lifetime
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType } from 'react'
import { oneCDark } from '../client/onec-dark.ts'
import { oneCSelectStyles } from '../client/select-theme.ts'
import { AppearancePage, AppearanceStatus } from '../client/appearance-settings.tsx'
import { editorLocale } from './client-locale.tsx'
import { AppearanceSettings } from './appearance-settings.tsx'

/** Connect native profile settings to presentation without changing task or editor owners. @backlink MIF-81 MIF-82 */
export function mountAppearance(ctx: Context): () => void {
  const settings = new AppearanceSettings(ctx)
  const locale = editorLocale(ctx.locale)
  let alive = true, queued = false
  const unregister = ctx.theme.register(oneCDark)
  const pickerStyle = document.createElement('style')
  pickerStyle.dataset.aicraftSelectTheme = 'true'
  document.head.appendChild(pickerStyle)
  /** Keep picker CSS tied to the actual active theme, including font adoption and native-mode return. @backlink MIF-82 TDEC-16 */
  const syncPickerStyle = () => {
    const css = alive && ctx.theme.getTheme().active.id === oneCDark.id ? oneCSelectStyles : ''
    if (pickerStyle.textContent !== css) pickerStyle.textContent = css
  }
  /** Let the native picker consume Escape before the surrounding DSH modal sees it. @backlink MIF-82 UC-212-AC-3 QR-7 */
  const preservePickerEscape = (event: KeyboardEvent) => {
    if (!alive || !pickerStyle.textContent || event.defaultPrevented || event.key !== 'Escape'
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || !CSS.supports('appearance', 'base-select') || !CSS.supports('selector(select:open)')) return
    if (document.querySelector('select:open')) event.stopPropagation()
  }
  document.addEventListener('keydown', preservePickerEscape, true)
  /** Coalesce theme reconciliation into one microtask using the live context and latest accepted settings. @backlink MIF-82 TDEC-16 */
  const reconcile = () => {
    if (!alive || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      const state = settings.getSnapshot()
      if (!alive || state.oneCDark === undefined || !state.nativePreference) return
      const active = ctx.theme.getTheme().active.id
      if (state.oneCDark && active !== oneCDark.id) ctx.theme.setTheme(oneCDark.id)
      else if (!state.oneCDark && active === oneCDark.id) ctx.theme.setTheme(state.nativePreference)
    })
  }
  const offSettings = settings.subscribe(reconcile)
  const offTheme = ctx.on('theme/change', () => { syncPickerStyle(); reconcile() })
  syncPickerStyle()
  let shadow: (() => void) | undefined, original: StoredEntry | undefined
  let installing = false
  /** Track the native appearance row, replace or release its shadow, and delegate choices after confirmed disablement.
   */
  const syncBridge = () => {
    if (!alive || installing) return
    const native = ctx.slots.entries('settings.general.item').find(entry => entry.options.id === 'appearance'
      && entry.registrant !== 'aicraft-onec-bridge')
    if (native === original) return
    installing = true
    try {
      shadow?.(); shadow = undefined; original = native
      settings.setBridgeAvailable(false)
      if (!native || typeof native.component !== 'function' || typeof native.inject !== 'function' || !native.store || !native.locale) return
      const Native = native.component as ComponentType<Record<string, unknown>>
      const inject = native.inject
      // SlotCore erases a stored entry's proved store/owner types; reuse that exact registration at this boundary.
      const register = ctx.slots.register.bind(ctx.slots) as unknown as (options: Record<string, unknown>,
        component: ComponentType<Record<string, unknown>>) => () => void
      shadow = register({ name: 'settings.general.item', ...native.options, priority: (native.options.priority ?? 0) - 1,
        store: native.store, locale: native.locale, registrant: 'aicraft-onec-bridge',
        inject: (...args: never[]) => {
          const face = inject(...args)
          if (typeof face.setTheme !== 'function') {
            settings.setBridgeAvailable(false)
            return { ...face, setTheme: () => {} }
          }
          settings.setBridgeAvailable(true)
          const action = face.setTheme as (id: string) => void
          return { ...face, setTheme: (id: string) => {
            const state = settings.getSnapshot()
            if (!alive || state.status !== 'ready' || state.writeOutcome === 'pending'
              || state.writeOutcome === 'unknown' && !state.reconciled) return
            if (!state.oneCDark) { action(id); return }
            void settings.setOneCDark(false).then((confirmed) => {
              if (confirmed && alive && !settings.getSnapshot().oneCDark) action(id)
            })
          } }
        },
      }, props => <><Native {...props} /><AppearanceStatus settings={settings} locale={locale} /></>)
      settings.setBridgeAvailable(true)
    } finally { installing = false }
  }
  const offSlots = ctx.slots.subscribe('settings.general.item', syncBridge)
  syncBridge()
  const offPage = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section',
    id: 'aicraft', order: 65, label: 'AICraft' }, () => <AppearancePage settings={settings} locale={locale} />))
  reconcile()
  return () => {
    alive = false
    offSettings(); offTheme(); offSlots(); settings.dispose()
    document.removeEventListener('keydown', preservePickerEscape, true)
    pickerStyle.remove()
    const state = settings.getSnapshot()
    if (ctx.theme.getTheme().active.id === oneCDark.id && state.nativePreference) ctx.theme.setTheme(state.nativePreference)
    unregister(); shadow?.(); offPage()
  }
}
