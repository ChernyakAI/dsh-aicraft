/**
 * FILE: plugin/src/client/initialize-project.tsx
 * DESCRIPTION: Choose the initial project process
 */
import type { Translator } from './messages.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect,useId,useState } from 'react'
import type { InitializeProjectRequest,ProcessDefinition } from '../types.ts'

const field = { width: '100%', boxSizing: 'border-box' as const, padding: 8, border: '1px solid var(--aicraft-border, #8090a050)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }

/**
 * Choose a demo process or create an empty process for project settings.
 */
export function InitializeProject({ t, busy, submit, cancel, dirtyChanged }: {
  t: Translator
  busy: boolean
  submit(request: InitializeProjectRequest): Promise<void>
  cancel(): void
  dirtyChanged(dirty: boolean): void
}) {
  const [template, setTemplate] = useState<InitializeProjectRequest['template']>('manual')
  const [id, setId] = useState('custom')
  const idHint = useId()
  const validId = /^[a-z][a-z0-9-]*$/.test(id)
  const invalidId = id.length > 0 && !validId
  const [draft, setDraft] = useState<ProcessDefinition>({ name: '', steps: [] })
  useEffect(() => { dirtyChanged(true); return () => dirtyChanged(false) }, [dirtyChanged])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  const valid = template !== 'manual' || (validId && draft.name.trim())
  return <section aria-label={t('uiInitializeAICraftProject')} style={{ marginTop: 20, fontSize: 13 }}>
    <h3>{t('uiInitializeAICraftProject')}</h3>
    <p style={{ opacity: 0.65 }}>
      {t('initializeHint')}
    </p>
    <form onSubmit={(event) => { event.preventDefault(); if (!valid || busy) return; void submit({ template, processId: template === 'manual' ? id : 'feature', definition: template === 'manual' ? draft : null }) }}>
      <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
        <label style={{ display: 'block', marginBottom: 16 }}>{t('uiProcessTemplate')}
          <select aria-label={t('uiProcessTemplate')} value={template} onChange={event => setTemplate(event.target.value as InitializeProjectRequest['template'])} style={field}>
            <option value="manual">{t('uiCreateANewProcessManually')}</option>
            <option value="ru">{t('uiNewFeatureRuDemo')}</option>
            <option value="en">{t('uiNewFeatureEnDemo')}</option>
          </select>
        </label>
        {template === 'manual' && <>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block' }}>{t('uiProcessID')}<input aria-label={t('uiProcessID')} aria-describedby={idHint} aria-invalid={invalidId} required pattern="[a-z][a-z0-9-]*" value={id} onChange={event => setId(event.target.value)} style={{ ...field, ...(invalidId ? { borderColor: 'var(--aicraft-error, #dc4545)' } : {}) }} /></label>
            <p id={idHint} role={invalidId ? 'alert' : undefined} style={{ margin: '4px 0 0', fontSize: 12, color: invalidId ? 'var(--aicraft-error, #dc4545)' : undefined, opacity: invalidId ? 1 : 0.65 }}>{invalidId ? t('invalidProcessId') : ''}{t('processIdHint')}</p>
          </div>
          <label style={{ display: 'block', marginBottom: 16 }}>{t('uiProcessName')}<input aria-label={t('uiProcessName')} required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} style={field} /></label>
        </>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button type="submit" variant="outline" disabled={!valid}>{busy ? t('initializing') : t('initializeProject')}</Button>
          <Button type="button" variant="outline" onClick={cancel}>{t('cancel')}</Button>
        </div>
      </fieldset>
    </form>
  </section>
}
