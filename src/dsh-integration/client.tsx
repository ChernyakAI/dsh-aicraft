/**
 * FILE: plugin/src/dsh-integration/client.tsx
 * DESCRIPTION: Bind the persistent AICraft panel to native DSH services
 */
import type { Context } from '@deepseek-ai/cordis'
import type { } from '@deepseek-ai/dsh-api-remotes/client'
import type { } from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId,PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { } from '@deepseek-ai/dsh-client-ui-session/client'
import type { } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace,PropsLocale,PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectChange } from 'dsh-aicraft/types'
import { useEffect,useLayoutEffect,useRef,useSyncExternalStore,type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import remote from '../../lib/typert.remote-client.js'
import { en,zh } from '../client/locale.ts'
import { mountMaterialEditors } from '../client/material-editor.tsx'
import { AicraftPanel,type PanelFace,type PanelProps } from '../client/panel.tsx'
import { AicraftIcon } from '../client/pickers.tsx'
/** Services required to mount the Remote API and register the panel. */
export const inject = ['slots', 'locale', 'layout', 'remote']

/**
 * START_METHOD_apply
 * Mount AICraft Remote methods and add the sidebar entry and main panel.
 * @param ctx - Browser Cordis plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(remote)
  ctx.effect(() => disposeRemote, 'aicraft: remote')
  ctx.effect(() => ctx.locale.register('aicraft', { en, zh }), 'aicraft: translations')
  const t = ctx.locale.bind('aicraft')
  const panelId = 'aicraft' as MainPanelId
  ctx.inject(['remote', 'remote.aicraft', 'remote.session', 'workspaces', 'sidebarRight', 'sidebarRightTabs', 'uiSession', 'uiWorkspace'], (panelCtx) => {
    const tabId = 'dsh-aicraft'
    panelCtx.effect(() => panelCtx.sidebarRightTabs.register({
      id: tabId, kind: 'aicraft', title: () => t('panel'), keepMounted: true,
      guide: [{ id: 'aicraft', order: 10, title: () => t('panel'), description: () => t('subtitle') }],
    }), 'aicraft: sidebar tab')
    let pendingFrame: number | undefined
    panelCtx.effect(() => () => { if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame) })
    const openSidebar = (): void => {
      if (panelCtx.uiSession.adapter.current.getSnapshot().key === undefined) return
      panelCtx.layout.selectPanel(null)
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame)
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined
        panelCtx.sidebarRight.openTab('aicraft')
      })
    }
    // Keep panel state independent of DSH's per-session sidebar occurrences.
    const panelElement = document.createElement('div')
    Object.assign(panelElement.style, { display: 'flex', flexDirection: 'column', flex: '1 1 0', height: '100%', minHeight: '0' })
    const panelRoot = createRoot(panelElement)
    let executorScroll: number | undefined
    panelCtx.effect(() => () => { panelRoot.unmount(); panelElement.remove() }, 'aicraft: persistent panel')
    const PanelHost = ({ active, ...props }: Omit<PanelProps, 'visible'> & { active: boolean }): ReactNode => {
      const target = useRef<HTMLDivElement>(null)
      const latest = useRef(props)
      latest.current = props
      useLayoutEffect(() => {
        const host = target.current
        return () => {
          if (panelElement.parentElement === host) panelRoot.render(<AicraftPanel {...latest.current} visible={false} />)
        }
      }, [])
      useLayoutEffect(() => {
        if (!active || !target.current) {
          if (panelElement.parentElement === target.current) panelRoot.render(<AicraftPanel {...props} visible={false} />)
          return
        }
        if (panelElement.parentElement !== target.current) {
          target.current.appendChild(panelElement)
          if (executorScroll !== undefined) {
            panelElement.firstElementChild?.scrollTo({ top: executorScroll })
            executorScroll = undefined
          }
        }
        panelRoot.render(<AicraftPanel {...props} visible={true} />)
      })
      return <div ref={target} style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', height: '100%', minHeight: 0 }} />
    }
    const SidebarHost = (props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'aicraft'> & InjectFace<PanelFace>): ReactNode => {
      const { tab } = props.useTabInfo()
      return <PanelHost {...props} active={tab.visible} />
    }
    const Launcher = (props: PropsRuntime<'main'> & PropsLocale<'aicraft'> & InjectFace<PanelFace>): ReactNode => {
      const current = panelCtx.uiSession.adapter.current
      const sessionId = useSyncExternalStore(
        listener => current.subscribe(listener),
        () => current.getSnapshot().key as SessionId | undefined,
      )
      useEffect(() => { if (sessionId !== undefined) openSidebar() }, [sessionId])
      const active = props.usePanelInfo((info: PanelInfo) => info.activePanelId === panelId)
      return <PanelHost {...props} sessionId={sessionId} active={active} />
    }
    let closingProject = Promise.resolve()
    let editors: ReturnType<typeof mountMaterialEditors>
    const face: PanelFace = {
      followProject: async function* (workspaceId, taskId, signal) {
        await closingProject
        if (signal.aborted) return
        const stream = panelCtx.remote.$stream<ProjectChange>({
          name: 'AICraft project changes',
          open: generation => panelCtx.remote.aicraft.changes(workspaceId, taskId, generation),
          ended: () => new Error('Automatic project updates ended; use Refresh task'),
        })
        const close = () => { closingProject = stream.dispose(); return closingProject }
        const cancel = () => { void close().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          for await (const item of stream) {
            if (signal.aborted) return
            if (item.value.kind === 'ready') item.accept()
            yield item.value
          }
        } finally { signal.removeEventListener('abort', cancel); await close() }
      },
      checkConnection: async () => {
        const result = await panelCtx.remote.aicraft.status()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadProjects: async (signal) => {
        const result = await panelCtx.remote.aicraft.projects(signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadProject: async (workspaceId, signal) => {
        const result = await panelCtx.remote.aicraft.project(workspaceId, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      prepareProject: async (workspaceId, request) => {
        const result = await panelCtx.remote.aicraft.prepare(workspaceId, request)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      createTask: async (workspaceId, request) => {
        const result = await panelCtx.remote.aicraft.createTask(workspaceId, request)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      goToStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.goToStep(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      returnStep: async (workspaceId, taskId, fromStepId, stepId) => {
        const result = await panelCtx.remote.aicraft.returnStep(workspaceId, taskId, fromStepId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      skipStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.skipStep(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      setStepModel: async (workspaceId, taskId, stepId, model) => {
        const result = await panelCtx.remote.aicraft.setStepModel(workspaceId, taskId, stepId, model)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      deleteStepMaterials: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.deleteStepMaterials(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      completeStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.completeStep(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      startStep: async (workspaceId, taskId, stepId, model) => {
        const result = await panelCtx.remote.aicraft.startStep(workspaceId, taskId, stepId, model)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      statistics: async (workspaceId, taskId, sessionId, signal) => {
        const result = await panelCtx.remote.aicraft.statistics(workspaceId, taskId, sessionId, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadMaterials: async (workspaceId, taskId, signal) => {
        const result = await panelCtx.remote.aicraft.materials(workspaceId, taskId, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      loadMaterial: async (workspaceId, path, signal) => {
        const result = await panelCtx.remote.aicraft.material(workspaceId, path, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      saveMaterial: async (workspaceId, path, text, version, signal) => {
        const result = await panelCtx.remote.aicraft.saveMaterial(workspaceId, path, text, version, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      showStepPrompt: async (workspaceId, workspaceTitle, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.stepPrompt(workspaceId, taskId, stepId)
        if (!result.ok) throw new Error(result.error.message)
        editors.open(workspaceId, workspaceTitle, `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`)
      },
      openProjectRules: async (workspaceId, workspaceTitle) => {
        const result = await panelCtx.remote.aicraft.projectRules(workspaceId)
        if (!result.ok) throw new Error(result.error.message)
        editors.open(workspaceId, workspaceTitle, result.value.path)
      },
      openMaterial: (workspaceId, workspaceTitle, path) => editors.open(workspaceId, workspaceTitle, path),
      loadSettings: async (workspaceId, signal) => {
        const result = await panelCtx.remote.aicraft.settings(workspaceId, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      saveProcess: async (workspaceId, id, definition, version, templateLanguage) => {
        const result = await panelCtx.remote.aicraft.saveProcess(workspaceId, id, definition, version, templateLanguage)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      saveRole: async (workspaceId, id, text, version) => {
        const result = await panelCtx.remote.aicraft.saveRole(workspaceId, id, text, version)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      deleteRole: async (workspaceId, id, version) => {
        const result = await panelCtx.remote.aicraft.deleteRole(workspaceId, id, version)
        if (!result.ok) throw new Error(result.error.message)
      },
      /**
       * START_METHOD_modelCatalog
       * Read the model catalog from the native DSH session service.
       */

      modelCatalog: async () => {
        const result = await panelCtx.remote.session.modelCatalog()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      // END_METHOD_modelCatalog

      /**
       * START_METHOD_stopGenerating
       * Cancel generation through the native DSH session service.
       */

      stopGenerating: async (sessionId) => {
        const result = await panelCtx.remote.session.cancel({ sessionId: sessionId as SessionId })
        if (!result.ok) throw new Error(result.error.message)
      },
      // END_METHOD_stopGenerating

      /**
       * START_METHOD_archiveChat
       * Archive the native chat and restore the AICraft panel when required.
       */

      archiveChat: async (sessionId) => {
        const wasCurrent = panelCtx.uiSession.adapter.current.getSnapshot().key === sessionId
        await panelCtx.uiWorkspace.archiveSession(sessionId as SessionId, { stopActivity: true })
        if (wasCurrent || panelCtx.uiSession.adapter.current.getSnapshot().key === undefined) panelCtx.layout.selectPanel(panelId)
      },
      // END_METHOD_archiveChat

      /**
       * START_METHOD_openExecutor
       * Open the linked executor chat while preserving the panel scroll position.
       */

      openExecutor: (sessionId) => {
        if (panelCtx.uiSession.adapter.current.getSnapshot().key !== sessionId) executorScroll =
          panelElement.firstElementChild?.scrollTop ?? 0
        panelCtx.uiWorkspace.openSession(sessionId as SessionId)
        if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame)
        pendingFrame = requestAnimationFrame(() => { pendingFrame = undefined; panelCtx.sidebarRight.openTab('aicraft') })
      },
      // END_METHOD_openExecutor

      reopenTask: async (workspaceId, taskId) => {
        const result = await panelCtx.remote.aicraft.reopenTask(workspaceId, taskId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      closeTask: async (workspaceId, taskId) => {
        const result = await panelCtx.remote.aicraft.closeTask(workspaceId, taskId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
    }
    editors = mountMaterialEditors({ t, load: face.loadMaterial, save: face.saveMaterial,
      resetPrompt: async (workspaceId, taskId, stepId, version, signal) => {
        const result = await panelCtx.remote.aicraft.defaultStepPrompt(workspaceId, taskId, stepId, version, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      saved: (workspaceId, path) => window.dispatchEvent(new CustomEvent('aicraft:material-saved', { detail: { workspaceId, path } })),
    })
    panelCtx.effect(() => () => editors.dispose(), 'aicraft: floating material editors')
    panelCtx.slots.inject('sidebar.right.pane.tab', () => panelCtx.slots.register({
      name: 'sidebar.right.pane.tab', key: tabId, locale: 'aicraft', inject: () => face,
    }, SidebarHost))
    panelCtx.slots.inject('main', () => panelCtx.slots.register({
      name: 'main', key: panelId, locale: 'aicraft', inject: () => face,
    }, Launcher))
    panelCtx.slots.inject('sidebar.panellist', () => panelCtx.slots.register({
      name: 'sidebar.panellist', id: panelId, order: 10, label: () => t('panel'), locale: 'aicraft',
    }, AicraftIcon))
  })
}
// END_METHOD_apply
