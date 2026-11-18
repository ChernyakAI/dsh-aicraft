/**
 * FILE: plugin/src/client/step-model-dialog.tsx
 * DESCRIPTION: Select a catalog model without changing global settings
 */
import { notice, noticeText, type Notice } from './messages.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { Button,Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RunModel } from 'dsh-aicraft/types'
import { useEffect,useId,useState,type ReactNode } from 'react'

/**
 * Show the stored route and effort without resolving historical defaults again.
 */
export function modelLabel(model: RunModel | null | undefined, t: PropsLocale<'aicraft'>['t']): string {
  if (!model) return t('notAssigned')
  return `${model.provider} / ${model.model} / ${model.reasoningEffort ?? t('reasoningDefault')}`
}
/**
 * Keep a local model and effort draft for assignment or one-shot execution.
 */
export function StepModelDialog({ stepTitle, disabled, t, modelCatalog, close, confirm, assignment = false, initialModel = null }: {
  stepTitle: string
  disabled: boolean
  t: PropsLocale<'aicraft'>['t']
  modelCatalog(): Promise<ModelCatalog>
  close(): void
  confirm(model: RunModel): void
  assignment?: boolean
  initialModel?: RunModel | null
}): ReactNode {
  const id = useId()
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [error, setError] = useState<Notice | null>(null)
  const [draft, setDraft] = useState<RunModel | null>(() => initialModel
    ? { ...initialModel, reasoningEffort: initialModel.reasoningEffort ?? null } : null)
  useEffect(() => {
    let active = true
    void modelCatalog().then((value) => { if (active) setCatalog(value) }, (error) => {
      if (active) setError(notice(error, { key: 'uiModelCatalogUnavailable' })) })
    return () => { active = false }
  }, [modelCatalog])
  const route = draft ? JSON.stringify([draft.provider, draft.model]) : ''
  const effort = draft?.reasoningEffort ?? null
  const routes = catalog?.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, reasoning: model.reasoning, key: JSON.stringify([group.id, model.id]), label: `${group.name} / ${model.name}` }))) ?? []
  const selected = routes.find(item => item.key === route)
  const efforts = selected?.reasoning?.efforts ?? []
  const unavailableEffort = effort !== null && !efforts.some(item => item.id === effort)
  const canConfirm = !disabled && Boolean(selected) && !unavailableEffort
  return <Modal className="aicraft-text-surface" open onClose={close} title={t(assignment ? 'setStepModel' : 'runStepWithModel')} description={stepTitle} closeLabel={t('close')}
    footer={<><Button variant="ghost" onClick={close}>{t('cancel')}</Button>
      <Button variant="outline" disabled={!canConfirm} onClick={() => { if (selected && canConfirm) confirm({ provider: selected.provider, model: selected.model, reasoningEffort: effort }) }}>{t(assignment ? 'save' : 'runStep')}</Button></>}>
    <p style={{ opacity: 0.65 }}>{t(assignment ? 'savedModelHint' : 'runModelHint')}</p>
    <label htmlFor={id} style={{ display: 'block', marginBottom: 8 }}>{t('model')}</label>
    <select id={id} data-modal-autofocus value={route} disabled={disabled || !catalog} onChange={(event) => {
      const next = routes.find(item => item.key === event.target.value)
      if (next) setDraft(current => ({ provider: next.provider, model: next.model,
        reasoningEffort: current?.reasoningEffort && next.reasoning?.efforts.some(item => item.id === current.reasoningEffort)
          ? current.reasoningEffort : null }))
    }}
    style={{ width: '100%', padding: 8, color: 'inherit', background: 'transparent' }}>
      <option value="" disabled>{t('chooseModel')}</option>
      {draft && !selected && <option value={route}>{modelLabel(draft, t)} {t('uiUnavailable')}</option>}
      {routes.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
    </select>
    <label htmlFor={`${id}-effort`} style={{ display: 'block', marginTop: 12, marginBottom: 8 }}>{t('uiReasoningEffort')}</label>
    <select id={`${id}-effort`} value={effort ?? ''} disabled={disabled || !selected}
      aria-invalid={unavailableEffort || undefined} aria-describedby={unavailableEffort ? `${id}-warning` : undefined}
      onChange={(event) => {
        const reasoningEffort = event.target.value || null
        setDraft(current => current ? { ...current, reasoningEffort } : null)
      }}
      style={{ width: '100%', padding: 8, color: 'inherit', background: 'transparent' }}>
      <option value="">{t('reasoningDefault')}</option>
      {unavailableEffort && <option value={effort!} disabled>{effort} {t('uiUnavailable')}</option>}
      {efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    {catalog && selected && unavailableEffort && <p id={`${id}-warning`} role="alert"
      style={{ color: 'var(--aicraft-warning, var(--dsw-alias-label-primary))' }}>{t('reasoningUnavailable')}</p>}
    {!catalog && !error && <p role="status">{t('loadingModels')}</p>}
    {error && <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{noticeText(t, error)}</p>}
  </Modal>
}
