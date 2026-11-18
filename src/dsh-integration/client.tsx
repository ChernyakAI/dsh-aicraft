/**
 * FILE: plugin/src/dsh-integration/client.tsx
 * DESCRIPTION: Bind the persistent AICraft panel to native DSH services
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { } from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId,PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { } from '@deepseek-ai/dsh-client-ui-session/client'
import type { } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace,PropsLocale,PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { withUiMessage } from '../ui-message.ts'
import { notice } from '../client/messages.ts'
import { aicraftTextStyles } from '../client/theme-text.ts'
import { mountAppearance } from './appearance-controller.tsx'
import { mountPanelNavigation } from './panel-navigation.ts'
import { editorLocale } from './client-locale.tsx'
import { requireConfirmation } from './operation-result.ts'
import type { OperationResult } from '../step-execution/types.ts'
import type { ProjectChange } from 'dsh-aicraft/types'
import { useEffect,useLayoutEffect,useRef,useSyncExternalStore,type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import remote from '../../lib/typert.remote-client.js'
import { en,zh,ru,ja,es,fr,de,pt } from '../client/locale.ts'
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
  ctx.effect(() => ctx.locale.register('aicraft', { en, zh, ru, ja, es, fr, de, pt }), 'aicraft: translations')
  ctx.inject(['configForms', 'theme', 'remote.settings'], (owner) => {
    owner.effect(() => {
      const style = document.createElement('style')
      style.textContent = aicraftTextStyles
      document.head.appendChild(style)
      return () => style.remove()
    }, 'aicraft: scoped text colors')
    owner.effect(() => mountAppearance(owner), 'aicraft: profile appearance')
  })
  const t = ctx.locale.bind('aicraft')
  const panelId = 'aicraft' as MainPanelId
  ctx.inject(['remote', 'remote.aicraft', 'remote.session', 'connection', 'workspaces', 'sidebarRight', 'sidebarRightTabs', 'uiSession', 'uiWorkspace'], (panelCtx) => {
    const connection = panelCtx.get('connection') as ConnectionHandle
    const tabId = 'dsh-aicraft'
    panelCtx.effect(() => panelCtx.sidebarRightTabs.register({
      id: tabId, kind: 'aicraft', title: () => t('panel'), keepMounted: true,
      guide: [{ id: 'aicraft', order: 10, title: () => t('panel'), description: () => t('subtitle') }],
    }), 'aicraft: sidebar tab')
    const navigation = mountPanelNavigation(panelCtx.sidebarRight)
    // Compare native tab actions separately from visibility caused by selecting a session.
    const tabPresentations = new WeakMap<AbortSignal, {
      revision: number
      expanded: boolean
      focused: boolean
      current: SessionId | undefined
    }>()
    panelCtx.effect(() => () => navigation.dispose(), 'aicraft: main conversation navigation')
    panelCtx.effect(() => panelCtx.sidebarRight.registerCloseHandler('aicraft', (sessionId) => {
      navigation.close(sessionId)
    }), 'aicraft: explicit tab close')
    /** Explicitly reveal AICraft after leaving its launcher. @backlink INTEGRATION-1 */
    const openSidebar = (): void => {
      if (panelCtx.uiSession.adapter.current.getSnapshot().key === undefined) return
      panelCtx.layout.selectPanel(null)
      navigation.open()
    }
    // Keep panel state independent of DSH's per-session sidebar occurrences.
    const panelElement = document.createElement('div')
    Object.assign(panelElement.style, { display: 'flex', flexDirection: 'column', flex: '1 1 0', height: '100%', minHeight: '0' })
    const panelRoot = createRoot(panelElement)
    let executorScroll: number | undefined
    panelCtx.effect(() => () => { panelRoot.unmount(); panelElement.remove() }, 'aicraft: persistent panel')
    /**
     * Move the persistent panel between DSH containers without replacing its local state.
     */
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
    /** Only the current main conversation may host and report the persistent view.
     */
    const SidebarHost = (props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'aicraft'> & InjectFace<PanelFace>): ReactNode => {
      const { tab, sidebar } = props.useTabInfo()
      const mounted = panelCtx.sidebarRight.mounted
      const current = useSyncExternalStore(listener => mounted.subscribe(listener), () => mounted.getSnapshot())
      const active = tab.visible && props.sessionId === current
      const focused = panelCtx.sidebarRight.active()?.id === tab.id
      useLayoutEffect(() => {
        const previous = tabPresentations.get(tab.signal)
        const revision = tab.navigation.revision
        // openTab advances revision; expansion and tab selection change local presentation.
        // Returning to a retained session establishes a baseline, never an opening intent.
        const opened = revision > (previous?.revision ?? 0)
          || previous !== undefined && previous.current === current && props.sessionId === current
          && (sidebar.expanded && !previous.expanded || focused && !previous.focused)
        tabPresentations.set(tab.signal, { revision, expanded: sidebar.expanded, focused, current })
        navigation.visibility(props.sessionId, active, opened)
      }, [props.sessionId, active, tab.signal, tab.navigation.revision, sidebar.expanded, focused, current])
      return <PanelHost {...props} active={active} />
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
    /**
     * Require task-change confirmation before independently reading the refreshed project.
     */
    const refreshTask = async (workspaceId: string, result: OperationResult<unknown>) => {
      requireConfirmation(result)
      const project = await panelCtx.remote.aicraft.project(workspaceId)
      if (!project.ok) throw notice(project.error, { key: 'taskChangeConfirmed' })
      return project.value
    }
    const face: PanelFace = {
      /**
       * Observe connection generations so the panel can reconcile after reconnection.
       */
      useConnectionGeneration: () => useSyncExternalStore(
        connection.generation.subscribe,
        () => connection.generation.getSnapshot()?.id ?? null,
      ),
      /**
       * Own the project's change stream and release it on cancellation or replacement.
       */
      followProject: async function* (workspaceId, taskId, signal) {
        await closingProject
        if (signal.aborted) return
        const stream = panelCtx.remote.$stream<ProjectChange>({
          name: 'AICraft project changes',
          open: generation => panelCtx.remote.aicraft.changes(workspaceId, taskId, generation),
          ended: () => withUiMessage(new Error('Automatic project updates ended; use Refresh task'), { key: 'automaticUpdatesEnded' }),
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
      /**
       * Read service connectivity and preserve the native failure reason.
       */
      checkConnection: async () => {
        const result = await panelCtx.remote.aicraft.status()
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Read registered projects and their AICraft presence without hiding transport errors.
       */
      loadProjects: async (signal) => {
        const result = await panelCtx.remote.aicraft.projects(signal)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Read the selected original project and preserve its read failure.
       */
      loadProject: async (workspaceId, signal) => {
        const result = await panelCtx.remote.aicraft.project(workspaceId, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Prepare the selected project through the shared Remote operation.
       */
      prepareProject: async (workspaceId, request) => {
        const result = await panelCtx.remote.aicraft.prepare(workspaceId, request)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Return creation confirmation independently of any later project read.
       */
      createTask: async (workspaceId, request) => {
        const result = await panelCtx.remote.aicraft.createTask(workspaceId, request)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Select a stage and refresh only after receiving the task-change confirmation.
       */
      goToStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.goToStep(workspaceId, taskId, stepId)
        if (!result.ok) throw result.error
        return refreshTask(workspaceId, result.value)
      },
      /**
       * Return from the specified current stage and separately refresh the confirmed change.
       */
      returnStep: async (workspaceId, taskId, fromStepId, stepId) => {
        const result = await panelCtx.remote.aicraft.returnStep(workspaceId, taskId, fromStepId, stepId)
        if (!result.ok) throw result.error
        return refreshTask(workspaceId, result.value)
      },
      /**
       * Skip the current stage and separately refresh the confirmed change.
       */
      skipStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.skipStep(workspaceId, taskId, stepId)
        if (!result.ok) throw result.error
        return refreshTask(workspaceId, result.value)
      },
      /**
       * Save the explicit stage model through the shared Remote operation.
       */
      setStepModel: async (workspaceId, taskId, stepId, model) => {
        const result = await panelCtx.remote.aicraft.setStepModel(workspaceId, taskId, stepId, model)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Delete the selected stage's outputs after the panel's confirmation.
       */
      deleteStepMaterials: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.deleteStepMaterials(workspaceId, taskId, stepId)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Complete the current stage and separately refresh the confirmed change.
       */
      completeStep: async (workspaceId, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.completeStep(workspaceId, taskId, stepId)
        if (!result.ok) throw result.error
        return refreshTask(workspaceId, result.value)
      },
      /**
       * Pass the panel's original attempt ID and return the confirmed executor link.
       */
      startStep: async (workspaceId, taskId, stepId, model, attemptId) => {
        const result = await panelCtx.remote.aicraft.startStep(workspaceId, taskId, stepId, model, attemptId)
        if (!result.ok) throw result.error
        return requireConfirmation(result.value).link
      },
      /** Read linked conversation availability through the shared Remote run operation.
       */
      observeRun: async (workspaceId, taskId, runId, attemptId) => {
        const result = await panelCtx.remote.aicraft.run(workspaceId, taskId, runId, attemptId, workspaceId, null)
        if (!result.ok) throw result.error
        return requireConfirmation(result.value)
      },
      /**
       * Read task or session statistics independently of the project snapshot.
       */
      statistics: async (workspaceId, taskId, sessionId, signal) => {
        const result = await panelCtx.remote.aicraft.statistics(workspaceId, taskId, sessionId, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Read the selected project's material catalog through Remote.
       */
      loadMaterials: async (workspaceId, taskId, signal) => {
        const result = await panelCtx.remote.aicraft.materials(workspaceId, taskId, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Read an original project document and its version through Remote.
       */
      loadMaterial: async (workspaceId, path, signal) => {
        const result = await panelCtx.remote.aicraft.material(workspaceId, path, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Adapt the generated Remote saveMaterial result for document editors.
       */
      saveMaterial: async (workspaceId, path, text, version, signal) => {
        const result = await panelCtx.remote.aicraft.saveMaterial(workspaceId, path, text, version, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Obtain the saved assignment before opening its original project editor.
       */
      showStepPrompt: async (workspaceId, workspaceTitle, taskId, stepId) => {
        const result = await panelCtx.remote.aicraft.stepPrompt(workspaceId, taskId, stepId)
        if (!result.ok) throw result.error
        editors.open(workspaceId, workspaceTitle, `.aicraft/tasks/${taskId}/${stepId}/input-prompt.md`)
      },
      /**
       * Obtain the project's rules path before opening its editor.
       */
      openProjectRules: async (workspaceId, workspaceTitle) => {
        const result = await panelCtx.remote.aicraft.projectRules(workspaceId)
        if (!result.ok) throw result.error
        editors.open(workspaceId, workspaceTitle, result.value.path)
      },
      /**
       * Open the selected document in an editor bound to its original project.
       */
      openMaterial: (workspaceId, workspaceTitle, path, preview) => editors.open(workspaceId, workspaceTitle, path, preview),
      /**
       * Read the project's editable process and role settings.
       */
      loadSettings: async (workspaceId, signal) => {
        const result = await panelCtx.remote.aicraft.settings(workspaceId, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Save a process template with the supplied original version.
       */
      saveProcess: async (workspaceId, id, definition, version, templateLanguage) => {
        const result = await panelCtx.remote.aicraft.saveProcess(workspaceId, id, definition, version, templateLanguage)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Save role instructions with the supplied original version.
       */
      saveRole: async (workspaceId, id, text, version) => {
        const result = await panelCtx.remote.aicraft.saveRole(workspaceId, id, text, version)
        if (!result.ok) throw result.error
        return result.value
      },
      /**
       * Request removal of the selected role at its loaded version.
       */
      deleteRole: async (workspaceId, id, version) => {
        const result = await panelCtx.remote.aicraft.deleteRole(workspaceId, id, version)
        if (!result.ok) throw result.error
      },
      /**
       * START_METHOD_modelCatalog
       * Read the model catalog from the native DSH session service.
       */

      modelCatalog: async () => {
        const result = await panelCtx.remote.session.modelCatalog()
        if (!result.ok) throw result.error
        return result.value
      },
      // END_METHOD_modelCatalog

      /**
       * START_METHOD_stopGenerating
       * Cancel generation through the native DSH session service.
       */

      stopGenerating: async (sessionId) => {
        const result = await panelCtx.remote.session.cancel({ sessionId: sessionId as SessionId })
        if (!result.ok) throw result.error
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
        navigation.open()
      },
      // END_METHOD_openExecutor

      /**
       * Reopen the selected task and separately refresh the confirmed change.
       */
      reopenTask: async (workspaceId, taskId) => {
        const result = await panelCtx.remote.aicraft.reopenTask(workspaceId, taskId)
        if (!result.ok) throw result.error
        return refreshTask(workspaceId, result.value)
      },
      /**
       * Close the selected task and separately refresh the confirmed change.
       */
      closeTask: async (workspaceId, taskId) => {
        const result = await panelCtx.remote.aicraft.closeTask(workspaceId, taskId)
        if (!result.ok) throw result.error
        return refreshTask(workspaceId, result.value)
      },
    }
    /**
     * Bind MaterialEditorApi.save to the panel's face.saveMaterial port.
     */
    editors = mountMaterialEditors({ t, locale: editorLocale(ctx.locale), load: face.loadMaterial, save: face.saveMaterial,
      /**
       * Request a default prompt draft while preserving the editor's original version.
       */
      resetPrompt: async (workspaceId, taskId, stepId, version, signal) => {
        const result = await panelCtx.remote.aicraft.defaultStepPrompt(workspaceId, taskId, stepId, version, signal)
        if (!result.ok) throw result.error
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
