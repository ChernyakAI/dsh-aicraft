/**
 * FILE: plugin/src/client/roles-settings.tsx
 * DESCRIPTION: Edit shared role instructions with version guards
 */
import { notice, noticeText, type Notice } from './messages.ts'
import type { Translator } from './messages.ts'
import { Button,IconEditOutlineRegular,IconTrashOutlineRegular,MarkdownText,Modal,SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect,useId,useState } from 'react'
import type { RoleDocument } from '../types.ts'

interface Props {
  t: Translator
  workspaceId: string
  roles: RoleDocument[]
  save(workspaceId: string, id: string, text: string, version: string | null): Promise<RoleDocument>
  remove(workspaceId: string, id: string, version: string): Promise<void>
  reload(): Promise<RoleDocument[]>
  updated(roles: RoleDocument[]): void
  status(active: boolean): void
}
const field = { width: '100%', boxSizing: 'border-box' as const, padding: 8, border: '1px solid var(--aicraft-border, #8090a050)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' }


/** Derive the list label from the first nonempty ATX heading outside fenced code.
 */
function roleName({ id, text }: RoleDocument): string {
  let fence: { marker: string; length: number } | undefined
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined
      continue
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length }
      continue
    }
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.*)$/)
    const name = heading?.[1].replace(/(?:^|[ \t])#+[ \t]*$/, '').trim()
    if (name) return name
  }
  return id
}

/** Shared role instructions and confirmed deletion, without changing process drafts.
 */
export function RolesSettings({ t, workspaceId, roles, save, remove, reload, updated, status }: Props) {
  const markdownLabels = { code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }
  const modeId = useId()
  const [editing, setEditing] = useState<{ id: string; text: string; version: string | null } | null>(null)
  const [deleting, setDeleting] = useState<RoleDocument | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [error, setError] = useState<Notice | null>(null)
  const active = editing !== null || deleting !== null || busy
  useEffect(() => { status(active); return () => status(false) }, [active, status])
  useEffect(() => {
    if (!editing) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn)
  }, [Boolean(editing)])
  const persist = async () => {
    if (!editing || busy) return
    setBusy(true); setError(null)
    try {
      const value = await save(workspaceId, editing.id, editing.text, editing.version)
      updated([...roles.filter(role => role.id !== value.id), value].sort((a, b) => a.id.localeCompare(b.id)))
      setEditing(null); setConfirmDiscard(false)
    } catch (error) { setError(notice(error, { key: 'roleSaveFailed' })) }
    finally { setBusy(false) }
  }
  const discard = () => { if (!busy) { setEditing(null); setDeleting(null); setError(null); setConfirmDiscard(false) } }
  const requestClose = () => {
    if (busy) return
    const changed = editing && (editing.version === null ? Boolean(editing.id || editing.text !== '# New role\n\n') : editing.text !== roles.find(role => role.id === editing.id)?.text)
    if (changed) setConfirmDiscard(true)
    else discard()
  }
  return <section aria-label={t('uiProjectRoles')} style={{ marginTop: 24 }}>
    <style>{`
      /* Center the initial size once in the available area; resizing must not recenter the card. */
      [role="presentation"]:has(> .aicraft-role-dialog) {
        --aicraft-role-width: 720px; --aicraft-role-height: 700px;
        align-items: flex-start; justify-content: flex-start;
        padding-left: max(24px, calc((100vw - var(--aicraft-role-width)) / 2));
        padding-top: max(24px, var(--dsh-frame-overlay-top, 24px), calc((100dvh - var(--aicraft-role-height)) / 2));
      }
      .aicraft-role-dialog {
        width: min(var(--aicraft-role-width), 100%); height: min(var(--aicraft-role-height), 100%);
        min-width: min(360px, 100%); min-height: min(440px, 100%);
        max-width: 100%; max-height: 100%; resize: both; overflow: auto;
      }
      .aicraft-role-content { flex: 1; min-height: 0; overflow: auto; }
      .aicraft-role-content > :last-child { flex: 1; min-height: 0; }
      .aicraft-role-form { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .aicraft-role-form > :not([role="tabpanel"]) { flex-shrink: 0; }
    `}</style>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <h3 style={{ flex: 1, margin: 0 }}>{t('uiRoles')}</h3>
      <Button variant="ghost" disabled={active} onClick={() => {
        setBusy(true); setError(null)
        void reload().then(updated, error => setError(notice(error, { key: 'rolesReadFailed' }))).finally(() => setBusy(false))
      }}>{t('uiReloadRoles')}</Button>
      <Button variant="outline" disabled={busy} onClick={() => { setError(null); setMode('edit'); setEditing({ id: '', text: '# New role\n\n', version: null }) }}>{t('uiNewRole')}</Button>
    </div>
    <div style={{ border: '1px solid var(--aicraft-border-subtle, #8090a030)', borderRadius: 10, overflow: 'hidden' }}>
      <table aria-label={t('uiProjectRoles')} style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', textAlign: 'left' }}>
        <thead style={{ background: 'var(--aicraft-header, #8090a00c)' }}><tr><th style={{ width: '35%', padding: 8, fontWeight: 500 }}>{t('role')}</th><th style={{ padding: 8, fontWeight: 500 }}>{t('uiName')}</th><th style={{ width: 64, padding: 8, fontWeight: 500 }}>{t('actions')}</th></tr></thead>
        <tbody>{roles.map((role) => {
          const name = roleName(role)
          return <tr key={role.id} style={{ borderTop: '1px solid var(--aicraft-border-subtle, #8090a030)' }}>
            <td style={{ padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={role.id}>{role.id}</td>
            <td style={{ padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={name}>{name}</td>
            <td style={{ padding: '4px 2px' }}><div style={{ display: 'flex' }}>
              <Button variant="ghost" size="sm" disabled={busy} title={t('uiEditRole')} aria-label={t('editRoleId', { id: role.id })} style={{ width: 28, padding: 0 }} onClick={() => { setError(null); setMode('preview'); setEditing({ ...role }) }}><IconEditOutlineRegular size={16} /></Button>
              <Button variant="ghost" size="sm" disabled={busy} title={t('uiDeleteRole')} aria-label={t('deleteRoleId', { id: role.id })} style={{ width: 28, padding: 0 }} onClick={() => { setError(null); setDeleting(role) }}><IconTrashOutlineRegular size={16} /></Button>
            </div></td>
          </tr>
        })}</tbody>
      </table>
    </div>
    {error && !editing && !deleting && <p role="alert" style={{ color: 'var(--aicraft-error, #dc4545)' , overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{noticeText(t, error)}</p>}
    {editing && <Modal open className="aicraft-role-dialog aicraft-text-surface" contentClassName="aicraft-role-content"
      title={editing.version === null ? t('uiNewRole') : t('uiEditRole')} closeLabel={t('close')} onClose={requestClose}>
      <form className="aicraft-role-form" onSubmit={(event) => { event.preventDefault(); void persist() }}>
        <label style={{ display: 'block', marginBottom: 12 }}>{t('uiRoleID')}<input aria-label={t('uiRoleID')} required pattern="[a-z][a-z0-9-]*" readOnly={editing.version !== null} disabled={busy} value={editing.id} onChange={event => setEditing({ ...editing, id: event.target.value })} placeholder="analyst" style={field} /></label>
        <div style={{ width: 220, marginBottom: 12 }}><SegmentedControl id={modeId} value={mode} label={t('editorMode')} disabled={busy} options={[{ value: 'edit', label: t('editor') }, { value: 'preview', label: t('preview') }]} onChange={setMode} /></div>
        <div id={`${modeId}-${mode}-panel`} role="tabpanel" aria-labelledby={`${modeId}-${mode}`} style={{ flex: '1 0 120px', minHeight: 120, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {mode === 'edit' ? <textarea aria-label={t('markdownSource')} disabled={busy} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} spellCheck={false}
            style={{ ...field, flex: 1, resize: 'none', minHeight: 120, fontFamily: 'monospace', lineHeight: 1.6 }} /> : <MarkdownText text={editing.text} labels={markdownLabels} />}
        </div>
        {confirmDiscard && <div role="alert" style={{ border: '1px solid var(--aicraft-border, #8090a050)', borderRadius: 7, padding: 10, marginTop: 12 }}>
          <p>{t('uiDiscardUnsavedRoleChanges')}</p>
          <Button variant="outline" onClick={discard}>{t('discardChanges')}</Button>
          <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>{t('keepEditing')}</Button>
        </div>}
        {error && <p role="alert" style={{ color: 'var(--aicraft-error, #dc4545)' , overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{noticeText(t, error)}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="ghost" disabled={busy} onClick={discard}>{t('cancel')}</Button>
          <Button type="submit" variant="outline" disabled={busy || !editing.id.trim() || !editing.text.trim()}>{busy ? t('saving') : t('saveRole')}</Button>
        </div>
      </form>
    </Modal>}
    {deleting && <Modal className="aicraft-text-surface" open title={t('uiDeleteRole')} closeLabel={t('close')} onClose={discard} description={t('deleteRolePrompt', { id: deleting.id })}
      footer={<><Button variant="ghost" disabled={busy} onClick={discard}>{t('cancel')}</Button><Button variant="outline" className="aicraft-destructive-confirm" disabled={busy} onClick={() => {
        if (busy) return
        setBusy(true); setError(null)
        void remove(workspaceId, deleting.id, deleting.version).then(() => { updated(roles.filter(role =>
          role.id !== deleting.id)); setDeleting(null) }, error => setError(notice(error, { key: 'roleDeleteFailed' }))).finally(() => setBusy(false))
      }}>{busy ? t('deleting') : t('uiDeleteRole')}</Button></>}>
      {error && <p role="alert" style={{ color: 'var(--aicraft-error, #dc4545)' , overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{noticeText(t, error)}</p>}
    </Modal>}
  </section>
}
