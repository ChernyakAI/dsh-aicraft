/**
 * FILE: plugin/src/ui-message.ts
 * DESCRIPTION: Carry locale-independent presentation facts between message owners and views
 */
import type { MessageParameters } from './ui-message-catalog.ts'

/** A concrete message key and its original substitutions; no rendered locale is persisted. */
export interface UiMessage {
  key: string
  params?: Record<string, string | number>
  details?: string[]
}
type OwnedMessage = { [K in keyof MessageParameters]: {
  key: K
  details?: string[]
} & (keyof MessageParameters[K] extends never ? { params?: never } : { params: MessageParameters[K] }) }[keyof MessageParameters]

/**
 * Attach presentation metadata at the point that establishes the reason, retaining the original error.
 */
export function withUiMessage<T extends object>(value: T, uiMessage: UiMessage): T & { uiMessage: UiMessage } {
  return Object.assign(value, { uiMessage })
}

/**
 * Check owned keys and parameter names while keeping the wire descriptor open to future keys.
 */
export function ownMessage(message: OwnedMessage): UiMessage { return message }

/**
 * Read explicit metadata through causal wrappers, without interpreting diagnostic prose.
 */
export function messageOf(value: unknown): UiMessage | undefined {
  const seen = new Set<object>()
  let current = value
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const item = current as { uiMessage?: UiMessage; details?: { uiMessage?: UiMessage }; cause?: unknown }
    if (item.uiMessage) return item.uiMessage
    if (item.details?.uiMessage) return item.details.uiMessage
    current = item.cause
  }
  return undefined
}

/**
 * Preserve an external diagnostic unchanged under a concrete localized explanation.
 */
export function externalMessage(key: keyof MessageParameters, error: unknown): UiMessage {
  return { key, details: [error instanceof Error ? error.message : String(error)] } as UiMessage
}
