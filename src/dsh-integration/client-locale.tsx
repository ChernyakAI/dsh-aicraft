/**
 * FILE: plugin/src/dsh-integration/client-locale.tsx
 * DESCRIPTION: Adapt native locale revisions for the independent floating editor root
 */
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Translator } from '../client/messages.ts'

export interface LocaleSource {
  getSnapshot(): { active: string; revision: number; t: Translator }
  subscribe(listener: () => void): () => void
}

/**
 * Cache one immutable translator snapshot per native revision; the root owns its sole subscription.
 */
export function editorLocale(runtime: LocaleRuntime): LocaleSource {
  const bound = runtime.bind('aicraft')
  let current: ReturnType<LocaleSource['getSnapshot']> | undefined
  return {
    getSnapshot() {
      const snapshot = runtime.getSnapshot()
      if (!current || current.revision !== snapshot.revision) current = {
        active: snapshot.active, revision: snapshot.revision, t: (key, params) => bound(key, params),
      }
      return current
    },
    subscribe: listener => runtime.subscribe(listener),
  }
}
