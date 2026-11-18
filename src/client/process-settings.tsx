/**
 * FILE: plugin/src/client/process-settings.tsx
 * DESCRIPTION: Edit project processes and role references
 */
import { notice, noticeText, type Notice } from './messages.ts'
import type { Translator } from './messages.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { Button,IconEditOutlineRegular,IconTrashOutlineRegular,Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect,useId,useState,type ReactNode } from 'react'
import { defaultStepModel,processTemplate } from '../project-settings/templates.ts'
import type { ProcessDefinition,ProcessDocument,ProcessTemplateLanguage,ProjectSettings,RoleDocument } from '../types.ts'
import { RolesSettings } from './roles-settings.tsx'

interface Props {
  t: Translator
  externalRevision: number
  workspaceId: string
  back: ReactNode
  projectRules(): void
  load(workspaceId: string, signal: AbortSignal): Promise<ProjectSettings>
  save(workspaceId: string, id: string, definition: ProcessDefinition, version: string | null, templateLanguage:
     ProcessTemplateLanguage | null): Promise<ProcessDocument>
  saveRole(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>
  deleteRole(workspaceId: string, id: string, version: string): Promise<void>
  modelCatalog(): Promise<ModelCatalog>
  dirtyChanged(dirty: boolean): void
  saved(): void
}
const field = { width: '100%', boxSizing: 'border-box' as const, padding: 8, border: '1px solid var(--aicraft-border, #8090a050)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }

/**
 * Form editor for project templates; existing task processes are left intact.
 */
export function ProcessSettings({ t, externalRevision, workspaceId, back, projectRules, load, save, saveRole, deleteRole,
  modelCatalog, dirtyChanged, saved }: Props) {
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
  const [error, setError] = useState<Notice | null>(null)
  const [modelError, setModelError] = useState<Notice | null>(null)
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
  const choose = (value: ProcessDocument) => {
    setDocument(value); setDraft(value.definition); setId(value.id); setCreating(false); setError(null)
  }
  useEffect(() => {
    if (unsaved) return
    const controller = new AbortController()
    void load(workspaceId, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setSettings(value)
      const current = value.processes.find(process => process.id === id) ?? value.processes[0]
      if (current) choose(current)
      else { setDocument(null); setDraft(null) }
    }, (error) => { if (!controller.signal.aborted) setError(notice(error, { key: 'settingsLoadFailed' })) })
    return () => controller.abort()
  }, [workspaceId, load, revision, externalRevision, unsaved])
  useEffect(() => {
    const controller = new AbortController()
    void modelCatalog().then((value) => { if (!controller.signal.aborted) { setCatalog(value); setModelError(null) } }, (error) => { if (!controller.signal.aborted) setModelError(notice(error, { key: 'uiModelCatalogUnavailable' })) })
    return () => controller.abort()
  }, [workspaceId, modelCatalog])
  const routes = catalog?.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model, key: JSON.stringify([group.id, model.id]), label: `${group.name} / ${model.name}` }))) ?? []
  const patchStep = (changes: Partial<ProcessDefinition['steps'][number]>) => setEditing(value => value && ({ ...value, step: { ...value.step, ...changes } }))
  const applyStep = () => {
    if (!editing || !editing.step.title.trim() || !editing.step.role) return
    const { index, step } = editing
    setDraft(value => value && ({ ...value, steps: index === null ? [...value.steps, step] : value.steps.map((old, i) =>
      i === index ? step : old) }))
    setEditing(null)
  }
  const move = (index: number, offset: number) => setDraft((value) => {
    if (!value) return value
    const steps = [...value.steps]; [steps[index], steps[index + offset]] = [steps[index + offset]!, steps[index]!]
    return { ...value, steps }
  })
  /** Preserve the confirmed process document when refreshing settings fails.
   */
  const persist = async () => {
    if (!draft || !dirty || busy || (creating && !validId)) return
    setBusy(true); setError(null)
    try {
      const value = await save(workspaceId, id, draft, creating ? null : document!.version, creating && templateLanguage !== 'manual' ? templateLanguage : null)
      setSettings(current => current && ({ ...current, processes: [...current.processes.filter(item => item.id !== value.id),
        value].sort((a, b) => a.id.localeCompare(b.id)) }))
      choose(value); saved()
      try {
        const refreshed = await load(workspaceId, new AbortController().signal)
        setSettings(refreshed)
      } catch (error) { setError(notice(error, { key: 'savedRefreshFailed' })) }
    } catch (error) { setError(notice(error, { key: 'processSaveFailed' })) }
    finally { setBusy(false) }
  }
  const reloadSteps = async () => {
    if (unsaved || busy || !document) return
    setBusy(true); setError(null)
    try {
      const value = await load(workspaceId, new AbortController().signal)
      const process = value.processes.find(item => item.id === document.id)
      if (!process) throw { key: 'processMissing' }
      setSettings(current => current && ({ ...current, processes: value.processes }))
      choose(process)
    } catch (error) { setError(notice(error, { key: 'settingsLoadFailed' })) }
    finally { setBusy(false) }
  }
  const route = editing?.step.model ? JSON.stringify([editing.step.model.provider, editing.step.model.model]) : ''
  const selected = routes.find(item => item.key === route)
  const rulesDisabled = !settings || busy || editing !== null || roleEditorActive
  return <section aria-label={t('uiProjectConfiguration')} style={{ fontSize: 13 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
      {back}
    </div>
    <section aria-label={t('uiProjectWideSettings')} style={{ borderTop: '1px solid var(--aicraft-border-subtle, #8090a030)', borderBottom: '1px solid var(--aicraft-border-subtle, #8090a030)', padding: '12px 0', marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>{t('settings')}</h3>
      <button type="button" disabled={rulesDisabled} onClick={projectRules} style={{ border: 0, padding: 0, background: 'none', font: 'inherit', color: 'var(--dsw-alias-link)', textDecoration: 'underline', opacity: rulesDisabled ? 0.5 : 1, cursor: rulesDisabled ? 'default' : 'pointer' }}>{t('uiProjectRules')}</button>
    </section>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <h3 style={{ flex: 1, margin: 0 }}>{t('uiProcessSettings')}</h3>
      <Button type="button" variant="outline" disabled={!settings || dirty || busy || editing !== null || roleEditorActive} onClick={() => setChoosingTemplate(true)}>{t('uiNewProcess')}</Button>
    </div>
    <p style={{ opacity: 0.65 }}>{t('processScopeHint')}</p>
    {choosingTemplate && <Modal className="aicraft-text-surface" open title={t('uiNewProcess')} closeLabel={t('close')} onClose={() => setChoosingTemplate(false)}>
      <p style={{ opacity: 0.65 }}>{t('newProcessHint')}</p>
      <label style={{ display: 'block', marginBottom: 16 }}>{t('uiTemplate')}<select aria-label={t('uiTemplate')} value={templateLanguage} onChange={event => setTemplateLanguage(event.target.value as ProcessTemplateLanguage | 'manual')} style={field}>
        <option value="manual">{t('uiCreateANewProcessManually')}</option>
        <option value="ru">{t('uiNewFeatureRuDemo')}</option>
        <option value="en">{t('uiNewFeatureEnDemo')}</option>
      </select></label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button type="button" variant="ghost" onClick={() => setChoosingTemplate(false)}>{t('cancel')}</Button>
        <Button type="button" variant="outline" onClick={() => { setDocument(null); setId(''); setCreating(true); setDraft(templateLanguage === 'manual' ? { name: '', steps: [] } : processTemplate(templateLanguage)); setError(null); setChoosingTemplate(false) }}>{templateLanguage === 'manual' ? t('createProcess') : t('useTemplate')}</Button>
      </div>
    </Modal>}
    {editing && settings && <Modal className="aicraft-text-surface" open title={editing.index === null ? t('addStep') : t('editStep')} closeLabel={t('close')} onClose={() => setEditing(null)}>
      <form onSubmit={(event) => { event.preventDefault(); applyStep() }}>
        <label style={{ display: 'block', marginBottom: 12 }}>{t('uiStepName')}<input data-modal-autofocus aria-label={t('uiStepName')} required value={editing.step.title} onChange={event => patchStep({ title: event.target.value })} style={field} /></label>
        <label style={{ display: 'block', marginBottom: 12 }}>{t('role')}<select aria-label={t('role')} required value={editing.step.role} onChange={event => patchStep({ role: event.target.value })} style={field}>
          <option value="">{t('uiSelectARole')}</option>
          {!settings.roles.includes(editing.step.role) && editing.step.role && <option value={editing.step.role}>{
            editing.step.role}</option>}
          {settings.roles.map(role => <option key={role} value={role}>{role}</option>)}
        </select></label>
        <label style={{ display: 'block', marginBottom: 12 }}>{t('model')}<select aria-label={t('model')} value={route} onChange={(event) => { const value = routes.find(item => item.key === event.target.value); if (value) patchStep({ model: { provider: value.provider, model: value.model.id, reasoningEffort: null } }) }} style={field}>
          <option value="" disabled>{t('chooseModel')}</option>
          {route && !selected && <option value={route}>{editing.step.model!.provider} / {editing.step.model!.model} {t('uiUnavailable')}</option>}
          {routes.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select></label>
        {(selected?.model.reasoning || editing.step.model?.reasoningEffort) && <label style={{ display: 'block', marginBottom: 12 }}>{t('uiReasoningEffort')}<select aria-label={t('uiReasoningEffort')} value={editing.step.model?.reasoningEffort ?? ''} style={field} onChange={event => patchStep({ model: { ...editing.step.model!, reasoningEffort: event.target.value || null } })}>
          <option value="">{t('uiModelDefault')}</option>
          {editing.step.model?.reasoningEffort && !selected?.model.reasoning?.efforts.some(effort =>
            effort.id === editing.step.model?.reasoningEffort) && <option value={editing.step.model.reasoningEffort}>{
            editing.step.model.reasoningEffort}</option>}
          {selected?.model.reasoning?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
        </select></label>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button type="button" variant="ghost" onClick={() => setEditing(null)}>{t('cancel')}</Button>
          <Button type="submit" variant="outline" disabled={!editing.step.title.trim() || !editing.step.role}>{t('uiApplyStep')}</Button>
        </div>
      </form>
    </Modal>}
    {error && <p role="alert" style={{ color: 'var(--aicraft-error, #dc4545)' , overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{noticeText(t, error)}</p>}
    {!settings ? <><p role="status">{error ? t('settingsLoadFailed') : t('loadingSettings')}</p>{error && <Button type="button" variant="ghost" onClick={() => setRevision(value => value + 1)}>{t('uiReloadSettings')}</Button>}</>
      : <>
        <form id={processFormId} onSubmit={(event) => { event.preventDefault(); void persist() }}>
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'start', marginBottom: 16 }}>
              <label style={{ flex: '1 1 240px', minWidth: 0 }}>{t('process')}
                <select aria-label={t('process')} value={creating ? '' : document?.id ?? ''} disabled={dirty || busy} style={field} onChange={(event) => { const value = settings.processes.find(item => item.id === event.target.value); if (value) choose(value) }}>
                  <option value="">{creating ? t('uiNewProcess') : t('selectProcess')}</option>
                  {settings.processes.map(item => <option key={item.id} value={item.id}>{item.definition.name}</option>)}
                </select>
              </label>
              {draft && <label style={{ flex: '1 1 240px', minWidth: 0 }}>{t('uiProcessName')}<input aria-label={t('uiProcessName')} required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} style={field} /></label>}
            </div>
            {draft && <>
              {creating && <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block' }}>{t('uiProcessID')}<input aria-label={t('uiProcessID')} aria-describedby={idHint} aria-invalid={invalidId} required pattern="[a-z][a-z0-9-]*" value={id} onChange={event => setId(event.target.value)} style={{ ...field, ...(invalidId ? { borderColor: 'var(--aicraft-error, #dc4545)' } : {}) }} placeholder="new-process" /></label>
                <p id={idHint} role={invalidId ? 'alert' : undefined} style={{ margin: '4px 0 0', fontSize: 12, color: invalidId ? 'var(--aicraft-error, #dc4545)' : undefined, opacity: invalidId ? 1 : 0.65 }}>{invalidId ? t('invalidProcessId') : ''}{t('processIdHint')}</p>
              </div>}
            </>}
          </fieldset>
        </form>
        <RolesSettings t={t} workspaceId={workspaceId} roles={settings.roleDocuments}
          save={saveRole} remove={deleteRole} reload={async () => (await load(workspaceId,
            new AbortController().signal)).roleDocuments} status={setRoleEditorActive}
          updated={(roles) => { setSettings(value => value && ({ ...value, roleDocuments: roles, roles: roles.map(role =>
            role.id) })); saved() }} />
        {draft && <fieldset disabled={busy} style={{ border: 0, minWidth: 0, padding: 0, margin: '24px 0 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <h3 style={{ flex: 1, margin: 0 }}>{t('stages')}</h3>
            <Button type="button" variant="ghost" disabled={unsaved || busy} onClick={() => void reloadSteps()}>{t('uiReloadSteps')}</Button>
            <Button type="button" variant="outline" onClick={() => {
              let n = 1; while (draft.steps.some(step => step.id === `step-${n}`)) n++
              setEditing({ index: null, step: { id: `step-${n}`, title: '', role: settings.roles[0] ?? '', model: defaultStepModel() } })
            }}>{t('uiNewStep')}</Button>
          </div>
          <div style={{ border: '1px solid var(--aicraft-border-subtle, #8090a030)', borderRadius: 10, overflowX: 'auto', marginBottom: 12 }}>
            <table aria-label={t('uiProcessSteps')} style={{ width: '100%', minWidth: 640, tableLayout: 'fixed', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead style={{ background: 'var(--aicraft-header, #8090a00c)' }}><tr>
                <th style={{ width: 24, padding: 8, opacity: 0.65 }}>#</th>
                <th style={{ padding: 8, fontWeight: 500, overflowWrap: 'normal' }}>{t('returnTarget')}</th>
                <th style={{ width: '18%', padding: 8, fontWeight: 500, overflowWrap: 'normal' }}>{t('role')}</th>
                <th style={{ width: '25%', padding: 8, fontWeight: 500, overflowWrap: 'normal' }}>{t('modelColumn')}</th>
                <th style={{ width: 112, padding: 8, fontWeight: 500, overflowWrap: 'normal', whiteSpace: 'nowrap' }}>{t('actions')}</th>
              </tr></thead>
              <tbody>{draft.steps.map((step, index) => {
                const model = step.model ? `${step.model.provider} / ${step.model.model}${step.model.reasoningEffort ? ` / ${step.model.reasoningEffort}` : ''}` : `${defaultStepModel().provider} / ${defaultStepModel().model}`
                const cell = { padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
                return <tr key={step.id} style={{ borderTop: '1px solid var(--aicraft-border-subtle, #8090a030)' }}>
                  <td style={{ ...cell, opacity: 0.65 }}>{index + 1}</td>
                  <td style={{ ...cell, fontWeight: 600 }} title={step.title}>{step.title}</td>
                  <td style={cell} title={step.role}>{step.role}</td>
                  <td style={{ ...cell, fontSize: 12, opacity: 0.65 }} title={model}>{model}</td>
                  <td style={{ padding: '4px 2px' }}><div style={{ display: 'flex' }}>
                    <Button type="button" variant="ghost" size="sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t('moveStepUp', { number: index + 1 })} title={t('uiMoveUp')} style={{ width: 28, padding: 0 }}>↑</Button>
                    <Button type="button" variant="ghost" size="sm" disabled={index === draft.steps.length - 1} onClick={() => move(index, 1)} aria-label={t('moveStepDown', { number: index + 1 })} title={t('uiMoveDown')} style={{ width: 28, padding: 0 }}>↓</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing({ index, step: { ...step, model: step.model ? { ...step.model } : null } })} aria-label={t('editStepNumber', { number: index + 1 })} title={t('uiEditStep')} style={{ width: 28, padding: 0 }}><IconEditOutlineRegular size={16} /></Button>
                    <Button type="button" variant="ghost" size="sm" disabled={draft.steps.length === 1} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })} aria-label={t('removeStepNumber', { number: index + 1 })} title={t('uiRemoveStep')} style={{ width: 28, padding: 0 }}><IconTrashOutlineRegular size={16} /></Button>
                  </div></td>
                </tr>
              })}</tbody>
            </table>
          </div>
        </fieldset>}
        {dirty && <p role="status" style={{ opacity: 0.65 }}>{t('unsavedNavigationHint')}</p>}
        {modelError && <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t('uiModelCatalogUnavailable')} {noticeText(t, modelError)}</p>}
        {draft && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          <Button type="submit" form={processFormId} variant="outline" disabled={!dirty || busy || !draft.name.trim() || draft.steps.length === 0 || (creating && !validId)}>{busy ? t('saving') : t('saveProcess')}</Button>
          <Button type="button" variant="outline" disabled={!dirty || busy} onClick={() => { if (document) choose(document); else { setDraft(null); setCreating(false) } }}>{t('uiCancelChanges')}</Button>
          <Button type="button" variant="outline" disabled={unsaved || busy} onClick={() => setRevision(value => value + 1)}>{t('uiReloadSettings')}</Button>
        </div>}
      </>}
  </section>
}
