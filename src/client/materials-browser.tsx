/**
 * FILE: plugin/src/client/materials-browser.tsx
 * DESCRIPTION: Browse material groups without loading document bodies
 */
import type { PanelFace } from './panel.tsx'
import { Button,classifyFileType,FileTypeIcon,Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MaterialGroup,StepView,TaskView } from 'dsh-aicraft/types'
import { useEffect,useState,type ReactNode } from 'react'

/** Material catalog stays visible while documents open in independent floating panels. */
export function MaterialsBrowser({ active, workspaceId, workspaceTitle, task, canDelete, busy, deleteArtifacts, initialGroup,
  refresh, resetScroll, t, loadMaterials, openMaterial }: {
  active: boolean
  workspaceId: string
  workspaceTitle: string
  task: TaskView | null
  canDelete: boolean
  busy: boolean
  deleteArtifacts(stepId: string): Promise<void>
  initialGroup: string | null
  refresh: number
  resetScroll(): void
  t: PropsLocale<'aicraft'>['t']
  loadMaterials: PanelFace['loadMaterials']
  openMaterial: PanelFace['openMaterial']
}): ReactNode {
  const taskId = task?.id ?? null
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const deletingStep = task?.steps.find(step => step.id === deleteTarget)
  const canClear = (step: StepView) => canDelete && !busy && step.status !== 'skipped' && step.status !== 'cancelled'
  const [groups, setGroups] = useState<MaterialGroup[] | null>(null)
  const [groupId, setGroupId] = useState(initialGroup)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(resetScroll, [groupId, resetScroll])
  useEffect(() => {
    if (busy || !active) return
    const controller = new AbortController()
    const read = async () => {
      try {
        const value = await loadMaterials(workspaceId, taskId, controller.signal)
        if (!controller.signal.aborted) {
          setGroups(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value)
          setError('')
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error))
      }
    }
    void read()
    return () => controller.abort()
  }, [workspaceId, taskId, refresh, retry, loadMaterials, busy, active])
  return <section aria-label={t('materials')} style={{ minWidth: 0, marginTop: 16 }}>
    {groupId !== null && <Button variant="ghost" onClick={() => setGroupId(null)}>← {t('allMaterials')}</Button>}
    {error && <div role="alert"><p>{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>{t('retry')}</Button></div>}
    {!error && (groups === null ? <p role="status">{t('loadingMaterials')}</p>
      : groups.filter(group => (group.id === 'request' || group.id === 'knowledge' || group.issue || group.files.length > 0) && (groupId === null || group.id === groupId)).map((group) => {
        const step = task?.steps.find(item => group.id === `step:${item.id}`)
        return <details key={group.id} open={groupId !== null || group.id === 'request'} style={{ borderBottom: '1px solid #8090a030', padding: '10px 0' }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>{group.title} <span style={{ opacity: 0.55 }}>({group.issue ? '?' : group.files.length})</span></summary>
          {step && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <Button type="button" variant="outline" disabled={!canClear(step) || (!group.issue && !group.files.some(file => file.name !== 'input-prompt.md'))} onClick={() => setDeleteTarget(step.id)}>{t('deleteStepMaterials')}</Button>
          </div>}
          {group.issue ? <p role="alert">{group.issue}</p> : group.files.length === 0 ? <p style={{ fontSize: 12, opacity: 0.65 }}>{t('noMaterials')}</p>
            : <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>{group.files.map(file => <li key={file.path}>
              <Button variant="ghost" title={file.path} onClick={() => openMaterial(workspaceId, workspaceTitle, file.path)} style={{ width: '100%', minWidth: 0, justifyContent: 'flex-start', fontSize: 13 }}>
                <FileTypeIcon kind={classifyFileType(file.name)} size={16} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
              </Button>
            </li>)}</ul>}
        </details>}))}
    {deletingStep && <Modal open title={t('deleteStepMaterials')} description={deletingStep.title} closeLabel={t('close')}
      onClose={() => { if (!busy) setDeleteTarget(null) }}>
      <p>
        Delete all artifacts for this step except input-prompt.md? Reports and previous run instructions will be
        deleted. This cannot be undone. The input prompt, chat history and step status will be kept.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>{t('cancel')}</Button>
        <Button type="button" variant="outline" className="aicraft-destructive-confirm" disabled={!canClear(deletingStep)} onClick={() => {
          void deleteArtifacts(deletingStep.id).then(() => { setDeleteTarget(null); setRetry(value => value + 1) })
        }}>{busy ? 'Deleting…' : t('deleteStepMaterials')}</Button>
      </div>
    </Modal>}
  </section>
}
