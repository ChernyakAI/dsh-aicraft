/**
 * FILE: plugin/src/client/pickers.tsx
 * DESCRIPTION: Select registered projects and saved tasks
 */
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { IconCheckCircleOutlineRegular,IconCheckOutlineRegular,IconChevronDownOutlineRegular,IconListPenOutlineRegular,IconStopFillRegular,Menu,Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectPresence,TaskView } from 'dsh-aicraft/types'
import { useState,type ReactNode } from 'react'

/** Use DSH's standard menu so project entries can carry the sidebar icon. */
export function ProjectPicker({ projects, presence, selectedId, busy, t, select }: {
  projects: readonly WorkspaceView[]
  presence: ProjectPresence[]
  selectedId: string
  busy: boolean
  t: PropsLocale<'aicraft'>['t']
  select(id: string): void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = projects.find(project => project.workspaceId === selectedId)
  const hasProject = (id: string): boolean => presence.some(item => item.workspaceId === id && item.hasAicraft)
  return <div style={{ flex: '0 1 300px', minWidth: 0 }}>
    <div style={{ display: 'grid' }}>
      <Menu open={open && !busy} portal autoFocus selection="fill" selectedId={selectedId} onClose={() => setOpen(false)}
        onSelect={(id) => { select(id); setOpen(false) }}
        items={[{ id: '', label: t('chooseProject'), icon: selectedId === '' ? <IconCheckOutlineRegular size={14} /> : <span /> }, ...projects.map(project => ({
          id: project.workspaceId,
          icon: selectedId === project.workspaceId ? <IconCheckOutlineRegular size={14} /> : <span />,
          label: <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.title}</span>
            {hasProject(project.workspaceId) && <AicraftIcon size={18} />}
          </span>,
        }))]}
        anchor={<button id="aicraft-project" type="button" disabled={busy} aria-label={t('project')} aria-haspopup="menu" aria-expanded={open && !busy}
          onClick={() => setOpen(value => !value)} style={{ width: '100%', height: 40, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 7, border: '1px solid #8090a060', color: 'inherit', background: 'transparent', textAlign: 'left' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected?.title ?? t('chooseProject')}</span>
          {selected && hasProject(selected.workspaceId) && <AicraftIcon size={18} />}
          <IconChevronDownOutlineRegular size={16} />
        </button>} />
    </div>
  </div>
}
/** Browse task history without changing the project's open task. */
export function TaskPicker({ tasks, selectedId, busy, t, select, create, canCreate }: {
  tasks: TaskView[]
  selectedId: string
  busy: boolean
  t: PropsLocale<'aicraft'>['t']
  select(id: string): void
  create(): void
  canCreate: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = tasks.find(task => task.id === selectedId)
  const statusIcon = (status: TaskView['status']): ReactNode => {
    const Icon = { open: IconListPenOutlineRegular, completed: IconCheckCircleOutlineRegular, cancelled: IconStopFillRegular }[status]
    return <Tooltip label={t(status === 'open' ? 'openTask' : status)} portal>
      <span role="img" aria-label={t(status === 'open' ? 'openTask' : status)} data-task-status={status}
        style={{ display: 'inline-flex', flexShrink: 0, opacity: status === 'cancelled' ? 0.65 : 0.85, color: { open: '#3b82f6', completed: '#22a06b', cancelled: 'inherit' }[status] }}>
        <Icon size={16} />
      </span>
    </Tooltip>
  }
  return <div style={{ flex: '0 1 300px', minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
    <Menu open={open && !busy} listClassName="aicraft-task-menu" portal autoFocus selection="fill" selectedId={selectedId} onClose={() => setOpen(false)}
      onSelect={(id) => { if (id === ':create') create(); else select(id); setOpen(false) }}
      items={[...tasks.map(task => ({
        id: task.id,
        icon: task.id === selectedId ? <IconCheckOutlineRegular size={14} /> : <span />,
        label: <span style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 360 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span title={task.title} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
            {task.updatedAt && <span style={{ display: 'block', fontSize: 11, opacity: 0.65 }}>{new Date(task.updatedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>}
          </span>
          {statusIcon(task.status)}
        </span>,
      })), { type: 'separator', id: ':create-separator' }, { id: ':create', label: t('create'), disabled: !canCreate }]}
      anchor={<button type="button" disabled={busy || tasks.length === 0} aria-label={t('taskPicker')} aria-haspopup="menu" aria-expanded={open && !busy}
        onClick={() => setOpen(value => !value)} style={{ width: '100%', minWidth: 0, height: 40, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 7, border: '1px solid #8090a060', color: 'inherit', background: 'transparent', textAlign: 'left' }}>
        <span title={selected?.title} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected?.title ?? t('chooseTask')}</span>
        {selected && statusIcon(selected.status)}
        <IconChevronDownOutlineRegular size={16} />
      </button>} />
  </div>
}
/**
 * Render the AICraft sidebar icon.
 * @param props - Icon size supplied by the sidebar.
 * @returns A forged crafting hammer with three magic sparks.
 */
export function AicraftIcon({ size }: { size: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" opacity="0.65" aria-hidden="true">
    <g transform="translate(24 0) scale(-1 1) rotate(-35 12 12)" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M10.7 10.5h2.6V20h-2.6z" fill="currentColor" />
      <path d="M10 19h4v2h-4z" fill="currentColor" />
      <path d="M7 4h10l1 1v5l-1 1H7l-1-1V5z" fill="currentColor" fillOpacity="0.18" />
      <path d="M9 4v7m6-7v7" />
    </g>
    <path d="M4 1 4.9 3.1 7 4 4.9 4.9 4 7 3.1 4.9 1 4 3.1 3.1Z" fill="currentColor" />
    <path d="M20.5 14.8 21.4 16.9 23.5 17.8 21.4 18.7 20.5 20.8 19.6 18.7 17.5 17.8 19.6 16.9Z" fill="currentColor" />
    <path d="M3 10.1 3.8 11.7 5.4 12.5 3.8 13.3 3 14.9 2.2 13.3 .6 12.5 2.2 11.7Z" fill="currentColor" />
  </svg>
}
