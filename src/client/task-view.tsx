/**
 * FILE: plugin/src/client/task-view.tsx
 * DESCRIPTION: Render task steps and explicit stage actions
 */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { Button,IconCheckOutlineRegular,IconClockOutlineRegular,IconEllipsisOutlineRegular,IconQueueOutlineRegular,Menu,Modal,Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RunModel,StepView,TaskView } from 'dsh-aicraft/types'
import { useState,type ReactNode } from 'react'
import { messageText, type Translator } from './messages.ts'
import { StepModelDialog,modelLabel } from './step-model-dialog.tsx'

/** Open only the original conversation selected from one saved run.
 */
export function CallerConversation({ t, sessionId, open }: {
  t: Translator
  sessionId: string | null | undefined
  open(): void
}): ReactNode {
  return sessionId ? <Button variant="ghost" size="sm" title={t('uiOpenCallerChat')} aria-label={t('uiOpenCallerChat')}
    onClick={open} style={{ width: 28, padding: 0, flexShrink: 0 }}><IconQueueOutlineRegular size={16} /></Button> : null
}

/** Distinct step status glyphs, keeping the existing semantic colours. */
function StepStatusIcon({ status }: { status: StepView['status'] }): ReactNode {
  if (status === 'cancelled') return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5.5 8h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
  if (status === 'current') return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2 8h11M8 3l5 5-5 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
  if (status === 'skipped') return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 3l4 4 4-4M4 8l4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
  const Icon = { done: IconCheckOutlineRegular, pending: IconClockOutlineRegular }[status]
  return <Icon size={16} />
}
/**
 * Compact stage commands using the same menu and button primitives as DSH.
 */
export function StepActions({ blocked, step, previousSteps, returnTo, current, disabled, busy, setModel, prompt, run,
  runWithModel, modelCatalog, t, select }: {
  blocked: boolean
  step: StepView
  previousSteps: StepView[]
  returnTo(stepId: string): Promise<void>
  current: boolean
  disabled: boolean
  busy: boolean
  setModel(model: RunModel): Promise<void>
  prompt(): void
  run(): void
  modelCatalog(): Promise<ModelCatalog>
  runWithModel(model: RunModel): void
  t: PropsLocale<'aicraft'>['t']
  select(kind: 'goto' | 'skip' | 'complete'): void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [choosingModel, setChoosingModel] = useState(false)
  const [choosingAssignment, setChoosingAssignment] = useState(false)
  const [returnTarget, setReturnTarget] = useState<string | null>(null)
  const readOnly = step.status === 'skipped' || step.status === 'cancelled'
  const cannotChange = disabled || readOnly
  const cannotSelect = disabled || step.status === 'cancelled'
  return <><Menu listClassName="aicraft-step-menu aicraft-text-surface" open={open && !busy && !blocked} portal align="end" autoFocus onClose={() => setOpen(false)}
    items={[
      { id: 'prompt', label: t('showStepPrompt'), disabled: blocked },
      { type: 'separator', id: 'materials-separator' },
      { id: 'set-model', label: t('setStepModel'), disabled: cannotChange },
      { id: 'run', label: t('runStep'), disabled: cannotChange || !current },
      { id: 'run-model', label: t('runStepWithModel'), disabled: cannotChange || !current },
      { type: 'separator', id: 'execution-separator' },
      { id: 'complete', label: t('completeStep'), disabled: cannotChange || !current },
      { id: 'skip', label: t('skipStep'), disabled: cannotChange || !current },
      { id: 'goto', label: t('goToStep'), disabled: cannotSelect || current },
      { id: 'return', label: t('returnTo'), disabled: cannotChange || !current || previousSteps.length === 0 },
    ]}
    onSelect={(id) => {
      setOpen(false)
      if (id === 'prompt' && !blocked) prompt()
      else if (id === 'set-model' && !cannotChange) setChoosingAssignment(true)
      else if (id === 'run' && !cannotChange && current) run()
      else if (id === 'run-model' && !cannotChange && current) setChoosingModel(true)
      else if (id === 'return' && current && !cannotChange && previousSteps.length > 0) setReturnTarget(previousSteps.at(-1)!.id)
      else if (id === 'goto' && !cannotSelect && !current) select('goto')
      else if (!cannotChange && current && (id === 'skip' || id === 'complete')) select(id)
    }}
    anchor={<Button variant="ghost" size="sm" disabled={busy || blocked} title={t('actions')}
      aria-label={t('stepActions', { step: step.title })} aria-haspopup="menu" aria-expanded={open && !busy}
      onClick={() => setOpen(value => !value)} style={{ width: 28, padding: 0 }}>
      <IconEllipsisOutlineRegular size={16} />
    </Button>} />
  {returnTarget !== null && current && <Modal className="aicraft-text-surface" open title={t('returnTo')} description={step.title} closeLabel={t('close')}
    onClose={() => { if (!busy) setReturnTarget(null) }}>
    <label style={{ display: 'grid', gap: 8, marginBottom: 16 }}>{t('returnTarget')}
      <select aria-label={t('returnTarget')} value={returnTarget} disabled={cannotChange || busy} onChange={event => setReturnTarget(event.target.value)}>
        {previousSteps.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
    </label>
    <p>{t('returnStepHint')}</p>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <Button variant="outline" disabled={busy} onClick={() => setReturnTarget(null)}>{t('cancel')}</Button>
      <Button variant="outline" disabled={cannotChange || busy || !previousSteps.some(item => item.id === returnTarget)}
        onClick={() => { void returnTo(returnTarget).then(() => setReturnTarget(null)) }}>{t('returnStep')}</Button>
    </div>
  </Modal>}
  {choosingAssignment && <StepModelDialog stepTitle={step.title} assignment initialModel={step.model} disabled={disabled ||
     busy} t={t} modelCatalog={modelCatalog}
  close={() => { if (!busy) setChoosingAssignment(false) }} confirm={(model) => { void setModel(model).then(() =>
    setChoosingAssignment(false)) }} />}
  {choosingModel && <StepModelDialog stepTitle={step.title} initialModel={step.model}
    disabled={disabled || !current || busy} t={t} modelCatalog={modelCatalog}
    close={() => setChoosingModel(false)} confirm={(model) => { if (model) { setChoosingModel(false); runWithModel(model) } }} />}
  </>
}
/**
 * Render task steps independently of project loading and panel state.
 */
export function TaskStages({ task, busy, t, showStageMaterials, actions }: {
  task: TaskView
  busy: boolean
  t: PropsLocale<'aicraft'>['t']
  showStageMaterials(stepId: string): void
  actions(step: StepView): ReactNode
}): ReactNode {
  return (
    <div style={{ border: '1px solid var(--aicraft-border-subtle, #8090a030)', borderRadius: 10, overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
        <thead style={{ background: 'var(--aicraft-stage-header, var(--aicraft-header, #8090a00c))' }}><tr>
          <th aria-label={t('stepStatus')} style={{ width: 30 }} />
          {(['step', 'role', 'modelColumn', 'materials', 'actions'] as const).map(key => <th key={key} style={{ padding: '10px', fontWeight: 500, opacity: 0.7, overflowWrap: 'normal', whiteSpace: key === 'actions' ? 'nowrap' : 'normal' }}>{t(key)}</th>)}
        </tr></thead>
        <tbody>{task.steps.map(step => <tr key={step.id} style={{ borderTop: '1px solid var(--aicraft-border-subtle, #8090a030)', background: step.status === 'current' ? 'var(--aicraft-selected, #3b82f60a)' : 'transparent' }}>
          <td style={{ padding: '8px 10px', verticalAlign: 'middle' }}>
            <Tooltip label={t(step.status === 'current' ? 'currentStage' : step.status === 'done' ? 'completed' : step.status)} portal>
              <span role="img" tabIndex={0} aria-label={`${step.title}: ${t(step.status === 'current' ? 'currentStage' : step.status === 'done' ? 'completed' : step.status)}`} data-step-status={step.status}
                style={{ display: 'flex', width: 16, height: 16, color: { done: 'var(--aicraft-success, #22a06b)', pending: 'var(--aicraft-pending, var(--aicraft-warning, #e8b45d))', current: 'var(--aicraft-accent, #3b82f6)', skipped: 'var(--aicraft-muted, #8b9098)', cancelled: 'var(--aicraft-error, #e9a0a0)' }[step.status] }}>
                <StepStatusIcon status={step.status} />
              </span>
            </Tooltip>
          </td>
          <td style={{ padding: '8px 10px', fontWeight: 600 }}>{step.title}</td>
          <td style={{ padding: '8px 10px', overflowWrap: 'anywhere' }}>{step.role}</td>
          <td style={{ padding: '8px 10px', fontSize: 12, opacity: 0.65, overflowWrap: 'anywhere' }}>
            {modelLabel(step.model, t)}
          </td>
          <td style={{ padding: '8px 10px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
            {step.artifactCount !== 0 && <Button type="button" variant="ghost" size="sm" disabled={busy}
              aria-label={`${t('stageMaterials')}: ${step.title}`} title={step.artifactIssue ? messageText(t, step.artifactIssueMessage, step.artifactIssue) : `${t('stageMaterials')}: ${step.title}`}
              onClick={() => showStageMaterials(step.id)} style={{ padding: '0 4px', height: 'auto', minHeight: 0, color: 'var(--dsw-alias-link)', textDecoration: 'underline', fontSize: 'inherit' }}>
              {step.artifactCount ?? '?'}
            </Button>}
          </td>
          <td style={{ padding: '8px 10px', width: 40 }}>
            {actions(step)}
          </td>
        </tr>)}</tbody>
      </table>
    </div>
  )
}
