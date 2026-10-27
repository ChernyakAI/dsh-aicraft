/**
 * FILE: plugin/src/client/step-model-dialog.tsx
 * DESCRIPTION: Select a catalog model without changing global settings
 */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { Button,Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RunModel } from 'dsh-aicraft/types'
import { useEffect,useId,useState,type ReactNode } from 'react'

/** Show the durable provider identity, model and optional reasoning effort. */
export function modelLabel(model: RunModel | null | undefined): string {
  if (!model) return 'Not assigned'
  return `${model.provider} / ${model.model}${model.reasoningEffort ? ` / ${model.reasoningEffort}` : ''}`
}
/** Choose a catalog model for this run without changing the saved assignment. */
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
  const [error, setError] = useState('')
  const [route, setRoute] = useState(initialModel ? JSON.stringify([initialModel.provider, initialModel.model]) : '')
  useEffect(() => {
    let active = true
    void modelCatalog().then((value) => { if (active) setCatalog(value) }, (error) => {
      if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [modelCatalog])
  const routes = catalog?.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, key: JSON.stringify([group.id, model.id]), label: `${group.name} / ${model.name}` }))) ?? []
  const selected = routes.find(item => item.key === route)
  return <Modal open onClose={close} title={t(assignment ? 'setStepModel' : 'runStepWithModel')} description={stepTitle} closeLabel={t('close')}
    footer={<><Button variant="ghost" onClick={close}>{t('cancel')}</Button>
      <Button variant="outline" disabled={disabled || !selected} onClick={() => { if (selected && !disabled) confirm({ provider: selected.provider, model: selected.model, reasoningEffort: initialModel && initialModel.provider === selected.provider && initialModel.model === selected.model ? initialModel.reasoningEffort : null }) }}>{t(assignment ? 'save' : 'runStep')}</Button></>}>
    <p style={{ opacity: 0.65 }}>{t(assignment ? 'savedModelHint' : 'runModelHint')}</p>
    <label htmlFor={id} style={{ display: 'block', marginBottom: 8 }}>{t('model')}</label>
    <select id={id} data-modal-autofocus value={route} disabled={disabled || !catalog} onChange={event => setRoute(event.target.value)}
      style={{ width: '100%', padding: 8, color: 'inherit', background: 'transparent' }}>
      <option value="" disabled>{t('chooseModel')}</option>
      {initialModel && route && !selected && <option value={route}>{modelLabel(initialModel)} (unavailable)</option>}
      {routes.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
    </select>
    {!catalog && !error && <p role="status">{t('loadingModels')}</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}
