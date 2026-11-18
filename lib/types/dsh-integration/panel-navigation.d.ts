/**
 * FILE: plugin/src/dsh-integration/panel-navigation.ts
 * DESCRIPTION: Restore the native AICraft tab across main-conversation navigation
 */
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
/**
 * Observe navigation outside tab occurrences and own one cancellable reveal.
 * Visibility reports belong only to the currently mounted main conversation.
 */
export declare function mountPanelNavigation(sidebar: Pick<ISidebarRight, 'mounted' | 'openTab'>): {
    /** Explicit opening resumes restoration after a manual hide. @backlink INTEGRATION-1 */
    open(): void;
    /** Ignore outgoing containers and distinguish a native open from an arriving visible tab. @backlink INTEGRATION-1 */
    visibility(session: SessionId | undefined, visible: boolean, opened?: boolean): void;
    /** An explicit tab close cancels a reveal even before its first render. @backlink INTEGRATION-1 */
    close(session: SessionId): void;
    /** Release the connection's observation and deferred work. @backlink DEC-9 */
    dispose(): void;
};
