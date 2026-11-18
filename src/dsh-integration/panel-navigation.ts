/**
 * FILE: plugin/src/dsh-integration/panel-navigation.ts
 * DESCRIPTION: Restore the native AICraft tab across main-conversation navigation
 */
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Observe navigation outside tab occurrences and own one cancellable reveal.
 * Visibility reports belong only to the currently mounted main conversation.
 */
export function mountPanelNavigation(sidebar: Pick<ISidebarRight, 'mounted' | 'openTab'>) {
  let wanted = false
  let suspended = false
  let shown: SessionId | undefined
  let frame: number | undefined
  let disposed = false
  const cancel = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  const reveal = (): void => {
    cancel()
    const session = sidebar.mounted.getSnapshot()
    if (!wanted || session === undefined || disposed) return
    // DSH publishes mounted before React creates the target session's store.
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!disposed && wanted && sidebar.mounted.getSnapshot() === session) sidebar.openTab('aicraft')
    })
  }
  const unsubscribe = sidebar.mounted.subscribe(() => { shown = undefined; reveal() })
  return {
    /** Explicit opening resumes restoration after a manual hide. @backlink INTEGRATION-1 */
    open() { suspended = false; wanted = true; reveal() },
    /** Ignore outgoing containers and distinguish a native open from an arriving visible tab. @backlink INTEGRATION-1 */
    visibility(session: SessionId | undefined, visible: boolean, opened = false) {
      if (disposed || session === undefined || session !== sidebar.mounted.getSnapshot()) return
      if (visible) {
        shown = session
        // A visible arriving tab is not an explicit reopening after a hide.
        if (!suspended || opened) { suspended = false; wanted = true }
      } else if (shown === session) { shown = undefined; suspended = true; wanted = false; cancel() }
    },
    /** An explicit tab close cancels a reveal even before its first render. @backlink INTEGRATION-1 */
    close(session: SessionId) {
      if (session !== sidebar.mounted.getSnapshot()) return
      shown = undefined; suspended = true; wanted = false; cancel()
    },
    /** Release the connection's observation and deferred work. @backlink DEC-9 */
    dispose() { disposed = true; cancel(); unsubscribe() },
  }
}
