import { processTemplate, defaultStepModel } from '../process-templates.ts'
import { RolesSettings } from './roles-settings.tsx'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, Modal, IconEditOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ProcessDefinition, ProcessDocument, ProjectSettings, RoleDocument, ProcessTemplateLanguage } from '../types.ts'

interface Props {
  externalRevision: number
  workspaceId: string
  back: ReactNode
  projectRules(): void
  load(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings>
  save(workspaceId: string, id: string, definition: ProcessDefinition, version: string | null, templateLanguage: ProcessTemplateLanguage | null): Promise<ProcessDocument>
  saveRole(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>
  deleteRole(workspaceId: string, id: string, version: string): Promise<void>
  modelCatalog(): Promise<ModelCatalog>
  dirtyChanged(dirty: boolean): void
  saved(): void
}
const field = { width: '100%', boxSizing: 'border-box' as const, padding: 8, border: '1px solid #8090a050', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }

/** Form editor for project templates; existing task processes are left intact. */
export function ProcessSettings({ externalRevision, workspaceId, back, projectRules, load, save, saveRole, deleteRole, modelCatalog, dirtyChanged, saved }: Props) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [document, setDocument] = useState<ProcessDocument | null>(null)
  const [draft, setDraft] = useState<ProcessDefinition | null>(null)
  const [id, setId] = useState('')
  const idHint = useId()
  const processFormId = useId()
  const validId = /^[a-z][a-z0-9-]*$/.test(id)
  const invalidId = id.length > 0 && !validId
  const [creating, setCreating] = useState(false)
  const [choosingTemplate, setChoosingTemplate] = useState(false)
  const [templateLanguage, setTemplateLanguage] = useState<ProcessTemplateLanguage | 'manual'>('manual')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [modelError, setModelError] = useState('')
  const [editing, setEditing] = useState<{ index: number | null; step: ProcessDefinition['steps'][number] } | null>(null)
  const [roleEditorActive, setRoleEditorActive] = useState(false)
  const [revision, setRevision] = useState(0)
  const dirty = draft !== null && (creating || JSON.stringify(draft) !== JSON.stringify(document?.definition))
  const unsaved = dirty || editing !== null || roleEditorActive || choosingTemplate
  useEffect(() => { dirtyChanged(unsaved); return () => dirtyChanged(false) }, [unsaved, dirtyChanged])
  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])
  const choose = (value: ProcessDocument) => { setDocument(value); setDraft(value.definition); setId(value.id); setCreating(false); setError('') }
  useEffect(() => {
    if (unsaved) return
    const controller = new AbortController()
    void load(workspaceId, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setSettings(value)
      const current = value.processes.find(process => process.id === id) ?? value.processes[0]
      if (current) choose(current)
      else { setDocument(null); setDraft(null) }
    }, error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) })
    return () => controller.abort()
  }, [workspaceId, load, revision, externalRevision, unsaved])
  useEffect(() => {
    const controller = new AbortController()
    void modelCatalog().then(value => { if (!controller.signal.aborted) { setCatalog(value); setModelError('') } }, error => { if (!controller.signal.aborted) setModelError(String(error)) })
    return () => controller.abort()
  }, [workspaceId, modelCatalog])
  const routes = catalog?.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model, key: JSON.stringify([group.id, model.id]), label: `${group.name} / ${model.name}` }))) ?? []
  const patchStep = (changes: Partial<ProcessDefinition['steps'][number]>) => setEditing(value => value && ({ ...value, step: { ...value.step, ...changes } }))
  const applyStep = () => {
    if (!editing || !editing.step.title.trim() || !editing.step.role) return
    const { index, step } = editing
    setDraft(value => value && ({ ...value, steps: index === null ? [...value.steps, step] : value.steps.map((old, i) => i === index ? step : old) }))
    setEditing(null)
  }
  const move = (index: number, offset: number) => setDraft(value => {
    if (!value) return value
    const steps = [...value.steps]; [steps[index], steps[index + offset]] = [steps[index + offset]!, steps[index]!]
    return { ...value, steps }
  })
  const persist = async () => {
    if (!draft || !dirty || busy || (creating && !validId)) return
    setBusy(true); setError('')
    try {
      const value = await save(workspaceId, id, draft, creating ? null : document!.version, creating && templateLanguage !== 'manual' ? templateLanguage : null)
      setSettings(current => current && ({ ...current, processes: [...current.processes.filter(item => item.id !== value.id), value].sort((a, b) => a.id.localeCompare(b.id)) }))
      choose(value); saved()
      const refreshed = await load(workspaceId, new AbortController().signal)
      setSettings(refreshed)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const reloadSteps = async () => {
    if (unsaved || busy || !document) return
    setBusy(true); setError('')
    try {
      const value = await load(workspaceId, new AbortController().signal)
      const process = value.processes.find(item => item.id === document.id)
      if (!process) throw new Error('Process no longer exists. Reload settings to choose another process.')
      setSettings(current => current && ({ ...current, processes: value.processes }))
      choose(process)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const route = editing?.step.model ? JSON.stringify([editing.step.model.provider, editing.step.model.model]) : ''
  const selected = routes.find(item => item.key === route)
  const rulesDisabled = !settings || busy || editing !== null || roleEditorActive
  return <section aria-label="Project configuration" style={{ fontSize: 13 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
      {back}
    </div>
    <section aria-label="Project-wide settings" style={{ borderTop: '1px solid #8090a030', borderBottom: '1px solid #8090a030', padding: '12px 0', marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>Project settings</h3>
      <button type="button" disabled={rulesDisabled} onClick={projectRules} style={{ border: 0, padding: 0, background: 'none', font: 'inherit', color: 'var(--dsw-alias-link)', textDecoration: 'underline', opacity: rulesDisabled ? 0.5 : 1, cursor: rulesDisabled ? 'default' : 'pointer' }}>Project rules</button>
    </section>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <h3 style={{ flex: 1, margin: 0 }}>Process settings</h3>
      <Button type="button" variant="outline" disabled={!settings || dirty || busy || editing !== null || roleEditorActive} onClick={() => setChoosingTemplate(true)}>New process</Button>
    </div>
    <p style={{ opacity: 0.65 }}>Process templates apply to new tasks. Existing tasks keep their saved process.</p>
    {choosingTemplate && <Modal open title="New process" closeLabel="Close" onClose={() => setChoosingTemplate(false)}>
      <p style={{ opacity: 0.65 }}>Opens an editable draft. Save the process to add it to this project.</p>
      <label style={{ display: 'block', marginBottom: 16 }}>Template<select aria-label="Template" value={templateLanguage} onChange={event => setTemplateLanguage(event.target.value as ProcessTemplateLanguage | 'manual')} style={field}>
        <option value="manual">Create a new process manually</option>
        <option value="ru">New feature — Ru (demo)</option>
        <option value="en">New feature — En (demo)</option>
      </select></label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button type="button" variant="ghost" onClick={() => setChoosingTemplate(false)}>Cancel</Button>
        <Button type="button" variant="outline" onClick={() => { setDocument(null); setId(''); setCreating(true); setDraft(templateLanguage === 'manual' ? { name: '', steps: [] } : processTemplate(templateLanguage)); setError(''); setChoosingTemplate(false) }}>{templateLanguage === 'manual' ? 'Create process' : 'Use template'}</Button>
      </div>
    </Modal>}
    {editing && settings && <Modal open title={editing.index === null ? 'Add step' : 'Edit step'} closeLabel="Close" onClose={() => setEditing(null)}>
      <form onSubmit={event => { event.preventDefault(); applyStep() }}>
        <label style={{ display: 'block', marginBottom: 12 }}>Step name<input data-modal-autofocus aria-label="Step name" required value={editing.step.title} onChange={event => patchStep({ title: event.target.value })} style={field} /></label>
        <label style={{ display: 'block', marginBottom: 12 }}>Role<select aria-label="Role" required value={editing.step.role} onChange={event => patchStep({ role: event.target.value })} style={field}>
          <option value="">Select a role</option>
          {!settings.roles.includes(editing.step.role) && editing.step.role && <option value={editing.step.role}>{editing.step.role}</option>}
          {settings.roles.map(role => <option key={role} value={role}>{role}</option>)}
        </select></label>
        <label style={{ display: 'block', marginBottom: 12 }}>Model<select aria-label="Model" value={route} onChange={event => { const value = routes.find(item => item.key === event.target.value); if (value) patchStep({ model: { provider: value.provider, model: value.model.id, reasoningEffort: null } }) }} style={field}>
          <option value="" disabled>Select a model</option>
          {route && !selected && <option value={route}>{editing.step.model!.provider} / {editing.step.model!.model} (unavailable)</option>}
          {routes.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select></label>
        {(selected?.model.reasoning || editing.step.model?.reasoningEffort) && <label style={{ display: 'block', marginBottom: 12 }}>Reasoning effort<select aria-label="Reasoning effort" value={editing.step.model?.reasoningEffort ?? ''} style={field} onChange={event => patchStep({ model: { ...editing.step.model!, reasoningEffort: event.target.value || null } })}>
          <option value="">Model default</option>
          {editing.step.model?.reasoningEffort && !selected?.model.reasoning?.efforts.some(effort => effort.id === editing.step.model?.reasoningEffort) && <option value={editing.step.model.reasoningEffort}>{editing.step.model.reasoningEffort}</option>}
          {selected?.model.reasoning?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
        </select></label>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button type="submit" variant="outline" disabled={!editing.step.title.trim() || !editing.step.role}>Apply step</Button>
        </div>
      </form>
    </Modal>}
    {error && <p role="alert" style={{ color: '#dc4545' }}>{error}</p>}
    {!settings ? <><p role="status">{error ? 'Settings could not be loaded.' : 'Loading settings…'}</p>{error && <Button type="button" variant="ghost" onClick={() => setRevision(value => value + 1)}>Reload settings</Button>}</>
      : <>
        <form id={processFormId} onSubmit={event => { event.preventDefault(); void persist() }}>
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'start', marginBottom: 16 }}>
          <label style={{ flex: '1 1 240px', minWidth: 0 }}>Process
            <select aria-label="Process" value={creating ? '' : document?.id ?? ''} disabled={dirty || busy} style={field} onChange={event => { const value = settings.processes.find(item => item.id === event.target.value); if (value) choose(value) }}>
              <option value="">{creating ? 'New process' : 'Select a process'}</option>
              {settings.processes.map(item => <option key={item.id} value={item.id}>{item.definition.name}</option>)}
            </select>
          </label>
          {draft && <label style={{ flex: '1 1 240px', minWidth: 0 }}>Process name<input aria-label="Process name" required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} style={field} /></label>}
        </div>
        {draft && <>
            {creating && <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block' }}>Process ID<input aria-label="Process ID" aria-describedby={idHint} aria-invalid={invalidId} required pattern="[a-z][a-z0-9-]*" value={id} onChange={event => setId(event.target.value)} style={{ ...field, ...(invalidId ? { borderColor: '#dc4545' } : {}) }} placeholder="new-process" /></label>
              <p id={idHint} role={invalidId ? 'alert' : undefined} style={{ margin: '4px 0 0', fontSize: 12, color: invalidId ? '#dc4545' : undefined, opacity: invalidId ? 1 : 0.65 }}>{invalidId ? 'Invalid Process ID. ' : ''}Start with a lowercase Latin letter; use lowercase Latin letters, digits and hyphens. Example: new-process.</p>
            </div>}
        </>}
          </fieldset>
        </form>
        <RolesSettings workspaceId={workspaceId} roles={settings.roleDocuments} usedByDraft={draft?.steps.map(step => step.role) ?? []} save={saveRole} remove={deleteRole} reload={async () => (await load(workspaceId, new AbortController().signal)).roleDocuments} status={setRoleEditorActive}
          updated={roles => { setSettings(value => value && ({ ...value, roleDocuments: roles, roles: roles.map(role => role.id) })); saved() }} />
        {draft && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: '24px 0 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h3 style={{ flex: 1, margin: 0 }}>Steps</h3>
              <Button type="button" variant="ghost" disabled={unsaved || busy} onClick={() => void reloadSteps()}>Reload steps</Button>
              <Button type="button" variant="outline" onClick={() => {
                let n = 1; while (draft.steps.some(step => step.id === `step-${n}`)) n++
                setEditing({ index: null, step: { id: `step-${n}`, title: '', role: settings.roles[0] ?? '', model: defaultStepModel() } })
              }}>New step</Button>
            </div>
            <div style={{ border: '1px solid #8090a030', borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
              <table aria-label="Process steps" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead style={{ background: '#8090a00c' }}><tr>
                  <th style={{ width: 24, padding: 8, opacity: 0.65 }}>#</th>
                  <th style={{ padding: 8, fontWeight: 500 }}>Step</th>
                  <th style={{ width: '18%', padding: 8, fontWeight: 500 }}>Role</th>
                  <th style={{ width: '25%', padding: 8, fontWeight: 500 }}>Model</th>
                  <th style={{ width: 112, padding: 8, fontWeight: 500 }}>Actions</th>
                </tr></thead>
                <tbody>{draft.steps.map((step, index) => {
                  const model = step.model ? `${step.model.provider} / ${step.model.model}${step.model.reasoningEffort ? ` / ${step.model.reasoningEffort}` : ''}` : `${defaultStepModel().provider} / ${defaultStepModel().model}`
                  const cell = { padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
                  return <tr key={step.id} style={{ borderTop: '1px solid #8090a030' }}>
                    <td style={{ ...cell, opacity: 0.65 }}>{index + 1}</td>
                    <td style={{ ...cell, fontWeight: 600 }} title={step.title}>{step.title}</td>
                    <td style={cell} title={step.role}>{step.role}</td>
                    <td style={{ ...cell, fontSize: 12, opacity: 0.65 }} title={model}>{model}</td>
                    <td style={{ padding: '4px 2px' }}><div style={{ display: 'flex' }}>
                      <Button type="button" variant="ghost" size="sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move step ${index + 1} up`} title="Move up" style={{ width: 28, padding: 0 }}>↑</Button>
                      <Button type="button" variant="ghost" size="sm" disabled={index === draft.steps.length - 1} onClick={() => move(index, 1)} aria-label={`Move step ${index + 1} down`} title="Move down" style={{ width: 28, padding: 0 }}>↓</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing({ index, step: { ...step, model: step.model ? { ...step.model } : null } })} aria-label={`Edit step ${index + 1}`} title="Edit step" style={{ width: 28, padding: 0 }}><IconEditOutlineRegular size={16} /></Button>
                      <Button type="button" variant="ghost" size="sm" disabled={draft.steps.length === 1} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })} aria-label={`Remove step ${index + 1}`} title="Remove step" style={{ width: 28, padding: 0 }}><IconTrashOutlineRegular size={16} /></Button>
                    </div></td>
                  </tr>
                })}</tbody>
              </table>
            </div>
        </fieldset>}
        {dirty && <p role="status" style={{ opacity: 0.65 }}>Save or cancel changes before switching projects or views.</p>}
        {modelError && <p role="alert">Model catalog unavailable: {modelError}</p>}
        {draft && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          <Button type="submit" form={processFormId} variant="outline" disabled={!dirty || busy || !draft.name.trim() || draft.steps.length === 0 || (creating && !validId)}>{busy ? 'Saving…' : 'Save process'}</Button>
          <Button type="button" variant="outline" disabled={!dirty || busy} onClick={() => { if (document) choose(document); else { setDraft(null); setCreating(false) } }}>Cancel changes</Button>
          <Button type="button" variant="outline" disabled={unsaved || busy} onClick={() => setRevision(value => value + 1)}>Reload settings</Button>
        </div>}
      </>}
  </section>
}
