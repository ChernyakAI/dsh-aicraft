import { useEffect, useId, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InitializeProjectRequest, ProcessDefinition } from '../types.ts'

const field = { width: '100%', boxSizing: 'border-box' as const, padding: 8, border: '1px solid #8090a050', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }

/** Choose a demo process or create an empty process for project settings. */
export function InitializeProject({ busy, submit, cancel, dirtyChanged }: {
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
  return <section aria-label="Initialize AICraft project" style={{ marginTop: 20, fontSize: 13 }}>
    <h3>Initialize AICraft project</h3>
    <p style={{ opacity: 0.65 }}>Create an empty process or choose a demo. Configure project rules, roles and steps in Project settings after initialization.</p>
    <form onSubmit={event => { event.preventDefault(); if (!valid || busy) return; void submit({ template, processId: template === 'manual' ? id : 'feature', definition: template === 'manual' ? draft : null }) }}>
      <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
        <label style={{ display: 'block', marginBottom: 16 }}>Process template
          <select aria-label="Process template" value={template} onChange={event => setTemplate(event.target.value as InitializeProjectRequest['template'])} style={field}>
            <option value="manual">Create a new process manually</option>
            <option value="ru">New feature — Ru (demo)</option>
            <option value="en">New feature — En (demo)</option>
          </select>
        </label>
        {template === 'manual' && <>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block' }}>Process ID<input aria-label="Process ID" aria-describedby={idHint} aria-invalid={invalidId} required pattern="[a-z][a-z0-9-]*" value={id} onChange={event => setId(event.target.value)} style={{ ...field, ...(invalidId ? { borderColor: '#dc4545' } : {}) }} /></label>
            <p id={idHint} role={invalidId ? 'alert' : undefined} style={{ margin: '4px 0 0', fontSize: 12, color: invalidId ? '#dc4545' : undefined, opacity: invalidId ? 1 : 0.65 }}>{invalidId ? 'Invalid Process ID. ' : ''}Start with a lowercase Latin letter; use lowercase Latin letters, digits and hyphens. Example: new-process.</p>
          </div>
          <label style={{ display: 'block', marginBottom: 16 }}>Process name<input aria-label="Process name" required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} style={field} /></label>
        </>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button type="submit" variant="outline" disabled={!valid}>{busy ? 'Initializing…' : 'Initialize project'}</Button>
          <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>
        </div>
      </fieldset>
    </form>
  </section>
}
