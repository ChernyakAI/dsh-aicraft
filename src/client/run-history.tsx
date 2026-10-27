/**
 * FILE: plugin/src/client/run-history.tsx
 * DESCRIPTION: Render executor history and user confirmations
 */
import type { PanelFace } from './panel.tsx'
import { Button,IconArchiveOutlineRegular,IconQueueOutlineRegular,IconStopFillRegular,Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RunView,SessionActivity,TaskView } from 'dsh-aicraft/types'
import { useState,type ReactNode } from 'react'
import { ExecutionStatistics } from './execution-statistics.tsx'
import { modelLabel } from './step-model-dialog.tsx'

/** Latest executor chats first, with theme-aware activity on the complete heading. */
export function RunHistory({ readOnly, task, workspaceId, statistics, active, sessionActivity, archivedSessionIds, t,
  openExecutor, stopGenerating, archiveChat }: {
  readOnly: boolean
  task: TaskView
  workspaceId: string
  statistics: PanelFace['statistics']
  active: boolean
  sessionActivity: Record<string, SessionActivity & { completed: string }>
  archivedSessionIds: readonly SessionId[]
  stopGenerating(sessionId: string): Promise<void>
  archiveChat(sessionId: string): Promise<void>
  t: PropsLocale<'aicraft'>['t']
  openExecutor(sessionId: string): void
}): ReactNode {
  const [visibleCount, setVisibleCount] = useState(3)
  const [confirmation, setConfirmation] = useState<{ kind: 'stop' | 'archive'; run: RunView } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    if (!confirmation || busy || readOnly) return
    setBusy(true); setError('')
    try {
      await (confirmation.kind === 'stop' ? stopGenerating(confirmation.run.sessionId) : archiveChat(confirmation.run.sessionId))
      setConfirmation(null)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const runs = task.runs.map((run, index) => {
    const running = sessionActivity[run.sessionId]?.running ?? ['starting', 'running'].includes(run.status)
    const status = running ? (run.status === 'starting' ? 'starting' : 'running') : run.status
    return { run, number: index + 1, running, status }
  })
    .filter(({ run }) => !archivedSessionIds.includes(run.sessionId as SessionId))
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt) || b.number - a.number)
  if (!runs.length && !confirmation) return null
  return <section style={{ marginTop: 24 }} aria-label={t('runHistory')}>
    <style>{`
      @keyframes aicraft-run-wave {
        from { background-position: 100% 0; }
        to { background-position: 0% 0; }
      }
      /* Animate only the text colour, without a duplicate layer or glyph motion. */
      .aicraft-run-wave {
        background-image: linear-gradient(110deg, var(--dsw-alias-label-primary) 40%, var(--dsw-alias-label-secondary) 50%, var(--dsw-alias-label-primary) 60%);
        background-size: 250% 100%;
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
        animation: aicraft-run-wave 2.8s linear infinite;
      }
    `}</style>
    {runs.slice(0, visibleCount).map(({ run, number, running, status }) => <div key={run.id} data-run-id={run.id} style={{ borderTop: '1px solid #8090a040', padding: '12px 0', overflowWrap: 'anywhere' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong><span className={running ? 'aicraft-run-wave' : undefined}>{`#${number} · ${task.steps.find(step => step.id === run.stepId)?.title ?? run.stepId} · ${t(status === 'failed' ? 'runFailed' : status)}`}</span></strong>
        <Button variant="ghost" size="sm" title={t('openRun')} aria-label={t('openRun')} onClick={() => openExecutor(run.sessionId)} style={{ width: 28, padding: 0, flexShrink: 0 }}>
          <IconQueueOutlineRegular size={16} />
        </Button>
        <Button variant="ghost" size="sm" title={t('stopGenerating')} aria-label={t('stopGenerating')} disabled={readOnly || busy || !running}
          onClick={() => { setError(''); setConfirmation({ kind: 'stop', run }) }} style={{ width: 28, padding: 0, flexShrink: 0 }}>
          <IconStopFillRegular size={16} />
        </Button>
        <Button variant="ghost" size="sm" title={t('archiveChat')} aria-label={t('archiveChat')} disabled={readOnly || busy}
          onClick={() => { setError(''); setConfirmation({ kind: 'archive', run }) }} style={{ width: 28, padding: 0, flexShrink: 0 }}>
          <IconArchiveOutlineRegular size={16} />
        </Button>
      </div>
      <p style={{ fontSize: 12 }}>{new Date(run.startedAt).toLocaleString()} · {modelLabel(run.model)}</p>
      <ExecutionStatistics key={`${workspaceId}:${task.id}:${run.sessionId}`} workspaceId={workspaceId} taskId={task.id} sessionId={run.sessionId}
        active={active} running={running} revision={sessionActivity[run.sessionId]?.completed ?? run.finishedAt ??
           run.startedAt} load={statistics} />
      {run.error && <p role="alert">{run.error}</p>}
    </div>)}
    {runs.length > visibleCount && <button type="button" onClick={() => setVisibleCount(count => count + 3)}
      style={{ border: 0, padding: '8px 0', background: 'transparent', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>{t('showMoreChats')}</button>}
    {confirmation && <Modal open onClose={() => { if (!busy) setConfirmation(null) }} title={t(confirmation.kind === 'stop' ? 'stopGenerating' : 'archiveChat')} closeLabel={t('close')}
      description={t(confirmation.kind === 'stop' ? 'stopPrompt' : 'archivePrompt')}
      footer={<><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>{t('cancel')}</Button>
        <Button variant="outline" disabled={readOnly || busy} onClick={() => { void confirm() }}>{t(busy ? 'saving' : confirmation.kind === 'stop' ? 'stopGenerating' : 'archiveChat')}</Button></>}>
      <p>{task.steps.find(step => step.id === confirmation.run.stepId)?.title ?? confirmation.run.stepId} · {
        new Date(confirmation.run.startedAt).toLocaleString()}</p>
      {error && <p role="alert">{error}</p>}
    </Modal>}
  </section>
}
