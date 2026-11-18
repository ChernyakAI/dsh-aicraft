/**
 * FILE: plugin/src/client/appearance-settings.tsx
 * DESCRIPTION: Present the profile-wide appearance choice and retained write outcomes
 */
import { useSyncExternalStore } from 'react'
import { IconCheckOutlineRegular, IconDarkOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppearanceSettings } from '../dsh-integration/appearance-settings.tsx'
import type { LocaleSource } from '../dsh-integration/client-locale.tsx'
import { messageText } from './messages.ts'
import { messageOf } from '../ui-message.ts'

/**
 * Render read availability independently of the retained write outcome, without repeating actions.
 */
export function AppearanceStatus({ settings, locale }: { settings: AppearanceSettings; locale: LocaleSource }) {
  const state = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const { t } = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  const key = state.writeOutcome === 'unknown' ? state.reconciled ? 'themeReconciled' : 'themeUnknown'
    : state.writeOutcome === 'rejected' ? 'themeRejected' : state.writeOutcome === 'pending' ? 'themePending' : null
  return <>{state.status === 'unavailable' && <p role="alert"
    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t('themeUnavailable')}
    {state.readReason !== undefined && <><br />{messageText(t, messageOf(state.readReason), typeof state.readReason === 'object' && state.readReason !== null
      && 'message' in state.readReason ? String(state.readReason.message) : String(state.readReason))}</>}</p>}
  {key && <p role={state.writeOutcome === 'pending' ? 'status' : 'alert'}
    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t(key)}
    {state.reason !== undefined && <><br />{messageText(t, messageOf(state.reason), typeof state.reason === 'object' && state.reason !== null
      && 'message' in state.reason ? String(state.reason.message) : String(state.reason))}</>}</p>}
  {!state.bridgeAvailable && <p role="alert">{t('themeBridgeUnavailable')}</p>}</>
}

/** Global settings remain usable with no project, task, or session. @backlink UC-212 UC-213 MIF-81 */
export function AppearancePage({ settings, locale }: { settings: AppearanceSettings; locale: LocaleSource }) {
  const state = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const { t } = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  return <section className="aicraft-text-surface" aria-label={t('themeAppearance')} style={{ padding: 24 }}>
    <style>{`
      .aicraft-theme-choices { display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap; max-width: 180px; }
      .aicraft-theme-tile { position: relative; box-sizing: border-box; flex: 1 1 180px; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 4px; padding: 20px 32px; border: .5px solid var(--dsw-alias-border-l4);
        border-radius: var(--dsw-radius-xl); background: transparent; font: inherit; font-size: 14px; line-height: 22px;
        color: var(--dsw-alias-label-primary); cursor: pointer; }
      @media (hover: hover) { .aicraft-theme-tile:hover:not([aria-pressed="true"]):not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover); } }
      .aicraft-theme-tile[aria-pressed="true"] { background: var(--dsw-alias-bg-module-platform);
        border-color: var(--dsw-static-neutral-bluish-400); }
      .aicraft-theme-tile:disabled { cursor: default; opacity: .65; }
    `}</style>
    <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 400, lineHeight: '22px',
      color: 'var(--dsw-alias-label-primary)' }}>{t('themeAppearance')}</h2>
    <div className="aicraft-theme-choices">
      <button type="button" className="aicraft-theme-tile" aria-label="OneC Dark" aria-pressed={state.oneCDark ?? false}
        disabled={state.status !== 'ready' || !state.writable || state.writeOutcome === 'pending'
          || state.writeOutcome === 'unknown' && !state.reconciled}
        onClick={() => { void settings.setOneCDark(!state.oneCDark) }}>
        <IconDarkOutlineMedium />
        <span>OneC Dark</span>
        {state.oneCDark && <span data-aicraft-theme-active="true" aria-hidden="true"
          style={{ position: 'absolute', top: 8, right: 8, color: 'var(--aicraft-success, #22a06b)', display: 'flex' }}>
          <IconCheckOutlineRegular size={14} />
        </span>}
      </button>
    </div>
    {state.status === 'loading' && <p role="status">{t('themeLoading')}</p>}
    <AppearanceStatus settings={settings} locale={locale} />
  </section>
}
