import { createRoot } from 'react-dom/client'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { DockController, FloatLayer, type DockIntents, type DockLabels, type TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { Button, MarkdownText, SegmentedControl, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MaterialDocument } from '../types.ts'

export interface MaterialEditorApi {
  t: PropsLocale<'aicraft'>['t']
  load(workspaceId: string, path: string, signal: AbortSignal): Promise<MaterialDocument>
  save(workspaceId: string, path: string, text: string, version: string, signal: AbortSignal): Promise<MaterialDocument>
  resetPrompt?(workspaceId: string, taskId: string, stepId: string, version: string, signal: AbortSignal): Promise<MaterialDocument>
  saved(workspaceId: string, path: string): void
}
interface Entry {
  workspaceId: string; workspaceTitle: string; path: string; preview?: MaterialDocument; dirty: boolean; saving: boolean; confirmClose: boolean
  status(dirty: boolean, saving: boolean): void
  close(): void
  keep(): void
}

/** DSH's own floating layout, independent of a chat or the selected project. */
export function mountMaterialEditors(api: MaterialEditorApi): { open(workspaceId: string, workspaceTitle: string, path: string, preview?: MaterialDocument): void; dispose(): void } {
  const controller = new DockController()
  const entries = new Map<TabId, Entry>()
  const listeners = new Set<() => void>()
  let revision = 0
  const notify = () => { revision++; [...listeners].forEach(listener => listener()) }
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const getRevision = () => revision
  const close = (id: TabId) => { controller.closeTab(id); entries.delete(id); notify() }
  const requestClose = (id: TabId) => {
    const entry = entries.get(id)
    if (!entry || entry.saving) return
    if (entry.dirty) { entry.confirmClose = true; notify() }
    else close(id)
  }
  const intents: DockIntents = {
    focusTab: id => controller.focusTab(id), focusPane: id => controller.focusPane(id),
    splitPane: id => { controller.splitPane(id) }, addTab: id => { controller.addTab(id) },
    closeTab: requestClose, duplicateTab: id => { controller.duplicateTab(id) },
    floatTab: (id, rect) => { controller.floatTab(id, rect) }, unfloatPane: id => { controller.unfloatPane(id) },
    placeTab: (id, pane, index) => { controller.placeTab(id, pane, index) }, dropTab: (id, pane, zone) => { controller.dropTab(id, pane, zone) },
    moveFloat: (id, x, y) => controller.moveFloat(id, x, y), resizeFloat: (id, rect) => controller.resizeFloat(id, rect),
    resizeSplit: (id, sizes) => controller.resizeSplit(id, sizes),
  }
  const element = document.createElement('div')
  element.className = 'aicraft-editor-windows'
  Object.assign(element.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '1000', fontFamily: 'system-ui, sans-serif', fontSize: '14px' })
  document.body.appendChild(element)
  const root = createRoot(element)
  function Layer(): ReactNode {
    const { state } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    useSyncExternalStore(subscribe, getRevision)
    const { t } = api
    const labels: DockLabels = { emptyPane: '', splitPane: '', splitPaneDisabled: '', splitPaneNarrow: '', addTab: '', dockFloat: '', closeTab: t('closeMaterial'), closeFloat: t('closeMaterial'), dropZone: { center: '', left: '', right: '', top: '', bottom: '' } }
    return <>
      <style>{'.aicraft-editor-windows [data-dockkit-float-dock] { display: none; }'}</style>
      <FloatLayer state={state} intents={intents} labels={labels} canCloseTab={id => !entries.get(id)?.saving}
        renderTabTitle={tab => <span>{tab.title}{entries.get(tab.id)?.dirty ? ' *' : ''}</span>}
        renderTab={tab => { const entry = entries.get(tab.id); return entry ? <MaterialEditor key={tab.id} entry={entry} api={api} /> : null }} />
    </>
  }
  root.render(<Layer />)
  const unload = (event: BeforeUnloadEvent) => {
    if ([...entries.values()].some(entry => entry.dirty || entry.saving)) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', unload)
  return {
    open(workspaceId, workspaceTitle, path, preview) {
      const existing = [...entries].find(([, entry]) => entry.workspaceId === workspaceId && entry.path === path)
      if (existing && !preview) { controller.focusTab(existing[0]); return }
      if (existing) close(existing[0])
      const id = controller.openContent({ contentId: JSON.stringify([workspaceId, path]), title: `${path.split('/').at(-1)} — ${workspaceTitle}`, kind: 'aicraft-material' })
      const entry: Entry = { workspaceId, workspaceTitle, path, preview, dirty: false, saving: false, confirmClose: false,
        status(dirty, saving) {
          if (entry.dirty === dirty && entry.saving === saving) return
          entry.dirty = dirty; entry.saving = saving
          if (!dirty) entry.confirmClose = false
          notify()
        }, close: () => close(id), keep: () => { entry.confirmClose = false; notify() },
      }
      entries.set(id, entry)
      const width = Math.min(850, window.innerWidth - 40), height = Math.min(650, window.innerHeight - 80)
      controller.floatTab(id, { x: Math.max(20, (window.innerWidth - width) / 2), y: 40, width, height })
      notify()
    },
    dispose() { window.removeEventListener('beforeunload', unload); root.unmount(); element.remove(); entries.clear() },
  }
}

/** The task request uses the same versioned Markdown editor in a modal. */
export function TaskRequestDialog({ workspaceId, workspaceTitle, taskId, taskTitle, t, load, save, close }: {
  workspaceId: string; workspaceTitle: string; taskId: string; taskTitle: string
  t: MaterialEditorApi['t']; load: MaterialEditorApi['load']; save: MaterialEditorApi['save']; close(): void
}): ReactNode {
  const [, setRevision] = useState(0)
  const [confirmClose, setConfirmClose] = useState(false)
  const [entry] = useState<Entry>(() => ({
    workspaceId, workspaceTitle, path: `.aicraft/tasks/${taskId}/request.md`,
    dirty: false, saving: false, confirmClose: false, close, keep: () => setConfirmClose(false),
    status(dirty, saving) {
      if (entry.dirty === dirty && entry.saving === saving) return
      entry.dirty = dirty; entry.saving = saving
      if (!dirty) setConfirmClose(false)
      setRevision(value => value + 1)
    },
  }))
  const api = useMemo<MaterialEditorApi>(() => ({ t, load, save,
    saved: (workspaceId, path) => window.dispatchEvent(new CustomEvent('aicraft:material-saved', { detail: { workspaceId, path } })),
  }), [t, load, save])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (entry.dirty || entry.saving) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [entry])
  return <>
    <style>{'.aicraft-request-dialog { width: min(850px, 100%); max-height: 100%; }'}</style>
    <Modal open title={`Task request — ${taskTitle}`} closeLabel={t('closeMaterial')} className="aicraft-request-dialog"
      onClose={() => { if (!entry.saving) { if (entry.dirty) setConfirmClose(true); else close() } }}>
      <div style={{ height: 'min(55vh, 500px)', minHeight: 0 }}><MaterialEditor entry={entry} api={api} /></div>
      {confirmClose && <div role="alert">
        <p>{t('discardClosePrompt')}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="button" variant="outline" disabled={entry.saving} onClick={close}>{t('discardChanges')}</Button>
          <Button type="button" variant="outline" disabled={entry.saving} onClick={() => setConfirmClose(false)}>{t('keepEditing')}</Button>
        </div>
      </div>}
    </Modal>
  </>
}

/** Markdown source/preview with guarded saving; other documents remain read-only. */
function MaterialEditor({ entry, api }: { entry: Entry; api: MaterialEditorApi }): ReactNode {
  const { t } = api
  const modeId = useId()
  const [document, setDocument] = useState<MaterialDocument | null>(null)
  const [projectReadOnly, setProjectReadOnly] = useState<boolean | undefined>()
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; readOnly: boolean }>).detail
      if (detail?.workspaceId === entry.workspaceId) setProjectReadOnly(detail.readOnly)
    }
    window.addEventListener('aicraft:project-readonly', changed)
    return () => window.removeEventListener('aicraft:project-readonly', changed)
  }, [entry.workspaceId])
  const [draft, setDraft] = useState('')
  const editable = !entry.preview && !(projectReadOnly ?? document?.readOnly) && /\.md$/i.test(entry.path)
  const markdown = /\.md$/i.test(entry.path) || entry.preview?.format === 'markdown'
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)
  const [confirmReload, setConfirmReload] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const promptPath = /^\.aicraft\/tasks\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/([a-z][a-z0-9-]*)\/input-prompt\.md$/.exec(entry.path)
  const abort = useRef<AbortController | null>(null)
  const dirty = document !== null && draft !== document.text
  const labels = useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }), [t])
  useEffect(() => {
    const controller = new AbortController(); abort.current = controller
    setDocument(null); setError(''); setSaved(false); entry.status(false, false)
    void (entry.preview ? Promise.resolve(entry.preview) : api.load(entry.workspaceId, entry.path, controller.signal)).then(value => {
      if (!controller.signal.aborted) { setDocument(value); setDraft(value.text) }
    }, error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)) })
    return () => controller.abort()
  }, [entry, api, revision])
  const reload = () => { setConfirmReload(false); setRevision(value => value + 1) }
  const save = async (): Promise<boolean> => {
    if (!document || !dirty || confirmReset || saving || !editable) return false
    const signal = abort.current!.signal
    setSaving(true); setError(''); setSaved(false); entry.status(dirty, true)
    try {
      const value = await api.save(entry.workspaceId, entry.path, draft, document.version, signal)
      if (signal.aborted) return false
      setDocument(value); setDraft(value.text); setSaved(true); entry.status(false, false)
      api.saved(entry.workspaceId, entry.path)
      return true
    } catch (error) {
      if (!signal.aborted) { setError(error instanceof Error ? error.message : String(error)); entry.status(dirty, false) }
      return false
    } finally { if (!signal.aborted) setSaving(false) }
  }
  const reset = async () => {
    if (!document || saving || !editable || !promptPath || !api.resetPrompt) return
    setConfirmReset(false)
    const signal = abort.current!.signal
    setSaving(true); setError(''); setSaved(false); entry.status(dirty, true)
    try {
      const value = await api.resetPrompt(entry.workspaceId, promptPath[1]!, promptPath[2]!, document.version, signal)
      if (signal.aborted) return
      setDraft(value.text); setMode('edit'); entry.status(value.text !== document.text, false)
    } catch (error) {
      if (!signal.aborted) { setError(error instanceof Error ? error.message : String(error)); entry.status(dirty, false) }
    } finally { if (!signal.aborted) setSaving(false) }
  }
  return <section aria-label={`${t('materialWindow')}: ${entry.workspaceTitle} — ${entry.path}`} onKeyDown={event => { if (editable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void save() } }} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 16, boxSizing: 'border-box' }}>
    <p title={entry.path} style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.65, overflowWrap: 'anywhere' }}>{entry.path}</p>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      {markdown ? <>
        <div style={{ width: 220 }}><SegmentedControl id={modeId} value={mode} label={t('editorMode')} disabled={saving}
          options={[{ value: 'edit', label: t('editor') }, { value: 'preview', label: t('preview') }]} onChange={setMode} /></div>
        {editable ? <Button variant="outline" disabled={!dirty || saving || !document} onClick={() => { void save() }}>{t(saving ? 'saving' : 'save')}</Button> : <span style={{ fontSize: 12, opacity: 0.65 }}>{t('readOnly')}</span>}
      </> : <span style={{ fontSize: 12, opacity: 0.65 }}>{t('readOnly')}</span>}
      {!entry.preview && <Button variant="ghost" disabled={saving} onClick={() => { if (dirty) setConfirmReload(true); else reload() }}>{t('reload')}</Button>}
      {editable && promptPath && api.resetPrompt && <Button type="button" variant="outline" disabled={saving || !document} onClick={() => setConfirmReset(true)}>Reset to default</Button>}
      {dirty && !saving && <span role="status" style={{ fontSize: 12, opacity: 0.65 }}>Unsaved changes</span>}
      {saved && <span role="status" style={{ fontSize: 12, color: '#22a06b' }}>{t('saved')}</span>}
    </div>
    {confirmReset && <Modal open title="Reset input prompt?" closeLabel="Close" onClose={() => setConfirmReset(false)}
      footer={<><Button type="button" variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button>
        <Button type="button" variant="outline" className="aicraft-destructive-confirm" onClick={() => { void reset() }}>Reset to default</Button></>}>
      <p>Replace the text in this editor with a default prompt using the current project rules, role instructions and task requirements?</p>
      <p>Unsaved editor changes will be replaced. The saved file stays unchanged until you choose Save.</p>
    </Modal>}
    {(entry.confirmClose || confirmReload) && <div role="alert" style={{ padding: 10, marginBottom: 12, border: '1px solid #8090a050', borderRadius: 7 }}>
      <p style={{ margin: '0 0 8px' }}>{entry.confirmClose ? 'Save changes before closing?' : t('discardReloadPrompt')}</p>
      {entry.confirmClose && editable && <Button variant="outline" disabled={saving || !dirty} onClick={() => { void save().then(ok => { if (ok) entry.close() }) }}>Save and close</Button>}
      <Button variant="outline" disabled={saving} onClick={() => { if (entry.confirmClose) entry.close(); else reload() }}>{t('discardChanges')}</Button>
      <Button variant="ghost" disabled={saving} onClick={() => { entry.keep(); setConfirmReload(false) }}>{t('keepEditing')}</Button>
    </div>}
    {error && <p role="alert" style={{ color: '#dc4545', margin: '0 0 12px' }}>{error}</p>}
    <div id={markdown ? `${modeId}-${mode}-panel` : undefined} role={markdown ? 'tabpanel' : undefined} aria-labelledby={markdown ? `${modeId}-${mode}` : undefined} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    {document === null ? !error && <p role="status">{t('loadingDocument')}</p>
      : markdown && mode === 'edit' ? <textarea autoFocus aria-label={t('markdownSource')} value={draft} readOnly={!editable} disabled={saving} spellCheck={false}
        onChange={event => { if (!editable) return; const text = event.target.value; setDraft(text); setSaved(false); entry.status(text !== document.text, saving) }}
        style={{ flex: 1, minHeight: 80, width: '100%', boxSizing: 'border-box', resize: 'none', padding: 12, border: '1px solid #8090a040', borderRadius: 7, background: 'transparent', color: 'inherit', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }} />
      : <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {document.format === 'markdown' ? <MarkdownText text={editable ? draft : document.text} labels={labels} />
          : <pre style={{ margin: 0, padding: 12, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{document.text}</pre>}
      </div>}
    </div>
  </section>
}
