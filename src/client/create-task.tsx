/**
 * FILE: plugin/src/client/create-task.tsx
 * DESCRIPTION: Edit task requirements before creation
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CreateTaskRequest,ProjectView } from 'dsh-aicraft/types'
import { useState,type ReactNode } from 'react'

/**
 * Collect requirements and a process before creating a task.
 * @param props - Project templates, translations and creation operation.
 * @returns The task creation form.
 */
export function CreateTaskForm({ project, busy, t, submit, initial }: {
  initial?: CreateTaskRequest
  project: ProjectView
  busy: boolean
  t: PropsLocale<'aicraft'>['t']
  submit(request: CreateTaskRequest): Promise<void>
}): ReactNode {
  const [taskIdentifier, setTaskIdentifier] = useState(initial?.taskIdentifier ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [processId, setProcessId] = useState(initial?.processId ?? project.processes[0]?.id ?? '')
  const [requestText, setRequestText] = useState(initial?.requestText ?? project.requestTemplate)
  const field = { width: '100%', padding: 10, borderRadius: 7, border: '1px solid #8090a060', color: 'inherit', background: 'transparent', boxSizing: 'border-box' as const }
  const duplicate = project.task.allTasks.some(task => task.id === taskIdentifier)
  const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(taskIdentifier)
  return <form onSubmit={(event) => { event.preventDefault(); if (!duplicate && validId) void submit({ taskIdentifier, title,
    processId, requestText }) }} style={{ marginTop: 24 }}>
    <h2 style={{ fontSize: 16 }}>{t('create')}</h2>
    <label htmlFor="aicraft-task-id">Task ID</label>
    <input id="aicraft-task-id" required disabled={busy} maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}" placeholder="task_name" value={taskIdentifier} onChange={event => setTaskIdentifier(event.target.value)} aria-describedby="aicraft-task-id-hint" aria-invalid={duplicate || (Boolean(taskIdentifier) && !validId)} style={{ ...field, margin: '8px 0' }} />
    <p id="aicraft-task-id-hint" role={duplicate ? 'alert' : undefined} style={{ fontSize: 12, margin: '0 0 16px', color: duplicate ? '#dc4545' : 'inherit', opacity: duplicate ? 1 : 0.65 }}>{duplicate ? `Task directory "${taskIdentifier}" already exists. Choose another Task ID.` : 'Used as the task directory name. Letters, digits, hyphens and underscores; starts with a letter or digit.'}</p>
    <label htmlFor="aicraft-title">{t('title')}</label>
    <input id="aicraft-title" required disabled={busy} value={title} onChange={event => setTitle(event.target.value)} style={{ ...field, margin: '8px 0 16px' }} />
    <label htmlFor="aicraft-process">{t('process')}</label>
    <select id="aicraft-process" required disabled={busy} value={processId} onChange={event => setProcessId(event.target.value)} style={{ ...field, margin: '8px 0 16px' }}>
      {processId && !project.processes.some(process => process.id === processId) && <option value={processId}>{processId}</option>}
      {project.processes.map(process => <option key={process.id} value={process.id}>{process.name}</option>)}
    </select>
    <label htmlFor="aicraft-request">{t('requirements')}</label>
    <textarea id="aicraft-request" required disabled={busy} rows={7} value={requestText} onChange={event => setRequestText(event.target.value)} style={{ ...field, margin: '8px 0 16px', resize: 'vertical' }} />
    <Button type="submit" variant="outline" className="aicraft-task-action" disabled={busy || !validId || duplicate || !title.trim() || !requestText.trim() || !processId}>{t(busy ? 'creating' : 'create')}</Button>
  </form>
}
