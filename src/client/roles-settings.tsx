import { useEffect, useId, useState } from 'react'
import { Button, Modal, MarkdownText, SegmentedControl, IconEditOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RoleDocument } from '../types.ts'

interface Props {
  workspaceId: string
  roles: RoleDocument[]
  usedByDraft: string[]
  save(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>
  remove(workspaceId: string, id: string, version: string): Promise<void>
  reload(): Promise<RoleDocument[]>
  updated(roles: RoleDocument[]): void
  status(active: boolean): void
}
const field = { width: '100%', boxSizing: 'border-box' as const, padding: 8, border: '1px solid #8090a050', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }
const markdownLabels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }

/** Shared role instructions, edited in a versioned Markdown modal. */
export function RolesSettings({ workspaceId, roles, usedByDraft, save, remove, reload, updated, status }: Props) {
  const modeId = useId()
  const [editing, setEditing] = useState<{ id: string; text: string; version: string | null } | null>(null)
  const [deleting, setDeleting] = useState<RoleDocument | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [error, setError] = useState('')
  const active = editing !== null || deleting !== null || busy
  useEffect(() => { status(active); return () => status(false) }, [active, status])
  useEffect(() => {
    if (!editing) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [Boolean(editing)])
  const persist = async () => {
    if (!editing || busy) return
    setBusy(true); setError('')
    try {
      const value = await save(workspaceId, editing.id, editing.text, editing.version)
      updated([...roles.filter(role => role.id !== value.id), value].sort((a, b) => a.id.localeCompare(b.id)))
      setEditing(null); setConfirmDiscard(false)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const discard = () => { if (!busy) { setEditing(null); setDeleting(null); setError(''); setConfirmDiscard(false) } }
  const requestClose = () => {
    if (busy) return
    const changed = editing && (editing.version === null ? Boolean(editing.id || editing.text !== '# New role\n\n') : editing.text !== roles.find(role => role.id === editing.id)?.text)
    if (changed) setConfirmDiscard(true)
    else discard()
  }
  return <section aria-label="Project roles" style={{ marginTop: 24 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <h3 style={{ flex: 1, margin: 0 }}>Roles</h3>
      <Button variant="ghost" disabled={active} onClick={() => {
        setBusy(true); setError('')
        void reload().then(updated, error => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false))
      }}>Reload roles</Button>
      <Button variant="outline" disabled={busy} onClick={() => { setError(''); setMode('edit'); setEditing({ id: '', text: '# New role\n\n', version: null }) }}>New role</Button>
    </div>
    <div style={{ border: '1px solid #8090a030', borderRadius: 10, overflow: 'hidden' }}>
      <table aria-label="Project roles" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', textAlign: 'left' }}>
        <thead style={{ background: '#8090a00c' }}><tr><th style={{ width: '35%', padding: 8, fontWeight: 500 }}>Role</th><th style={{ padding: 8, fontWeight: 500 }}>Name</th><th style={{ width: 64, padding: 8, fontWeight: 500 }}>Actions</th></tr></thead>
        <tbody>{roles.map(role => {
          const name = role.text.match(/^#\s+(.+)$/m)?.[1]?.trim() || role.id
          const used = usedByDraft.includes(role.id)
          return <tr key={role.id} style={{ borderTop: '1px solid #8090a030' }}>
            <td style={{ padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={role.id}>{role.id}</td>
            <td style={{ padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={name}>{name}</td>
            <td style={{ padding: '4px 2px' }}><div style={{ display: 'flex' }}>
              <Button variant="ghost" size="sm" disabled={busy} title="Edit role" aria-label={`Edit role ${role.id}`} style={{ width: 28, padding: 0 }} onClick={() => { setError(''); setMode('preview'); setEditing({ ...role }) }}><IconEditOutlineRegular size={16} /></Button>
              <Button variant="ghost" size="sm" disabled={busy || used} title={used ? 'This role is used by the current process draft' : 'Delete role'} aria-label={`Delete role ${role.id}`} style={{ width: 28, padding: 0 }} onClick={() => { setError(''); setDeleting(role) }}><IconTrashOutlineRegular size={16} /></Button>
            </div></td>
          </tr>
        })}</tbody>
      </table>
    </div>
    {error && !editing && !deleting && <p role="alert" style={{ color: '#dc4545' }}>{error}</p>}
    {editing && <Modal open title={editing.version === null ? 'New role' : 'Edit role'} closeLabel="Close" onClose={requestClose}>
      <form onSubmit={event => { event.preventDefault(); void persist() }}>
        <label style={{ display: 'block', marginBottom: 12 }}>Role ID<input aria-label="Role ID" required pattern="[a-z][a-z0-9-]*" readOnly={editing.version !== null} disabled={busy} value={editing.id} onChange={event => setEditing({ ...editing, id: event.target.value })} placeholder="analyst" style={field} /></label>
        <div style={{ width: 220, marginBottom: 12 }}><SegmentedControl id={modeId} value={mode} label="Document mode" disabled={busy} options={[{ value: 'edit', label: 'Editor' }, { value: 'preview', label: 'Preview' }]} onChange={setMode} /></div>
        <div id={`${modeId}-${mode}-panel`} role="tabpanel" aria-labelledby={`${modeId}-${mode}`} style={{ height: 'min(45vh, 360px)', minHeight: 180, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {mode === 'edit' ? <textarea aria-label="Markdown source" disabled={busy} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} spellCheck={false}
            style={{ ...field, flex: 1, resize: 'none', minHeight: 180, fontFamily: 'monospace', lineHeight: 1.6 }} /> : <MarkdownText text={editing.text} labels={markdownLabels} />}
        </div>
        {confirmDiscard && <div role="alert" style={{ border: '1px solid #8090a050', borderRadius: 7, padding: 10, marginTop: 12 }}>
          <p>Discard unsaved role changes?</p>
          <Button variant="outline" onClick={discard}>Discard changes</Button>
          <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
        </div>}
        {error && <p role="alert" style={{ color: '#dc4545' }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="ghost" disabled={busy} onClick={discard}>Cancel</Button>
          <Button type="submit" variant="outline" disabled={busy || !editing.id.trim() || !editing.text.trim()}>{busy ? 'Saving…' : 'Save role'}</Button>
        </div>
      </form>
    </Modal>}
    {deleting && <Modal open title="Delete role" closeLabel="Close" onClose={discard} description={`Delete role "${deleting.id}"? This is allowed only when no process or task uses it.`}
      footer={<><Button variant="ghost" disabled={busy} onClick={discard}>Cancel</Button><Button variant="outline" className="aicraft-destructive-confirm" disabled={busy} onClick={() => {
        if (busy) return
        setBusy(true); setError('')
        void remove(workspaceId, deleting.id, deleting.version).then(() => { updated(roles.filter(role => role.id !== deleting.id)); setDeleting(null) }, error => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false))
      }}>{busy ? 'Deleting…' : 'Delete role'}</Button></>}>
      {error && <p role="alert" style={{ color: '#dc4545' }}>{error}</p>}
    </Modal>}
  </section>
}
