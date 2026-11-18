/**
 * FILE: plugin/src/client/messages.ts
 * DESCRIPTION: Render retained presentation facts using the current translator
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { messageOf, type UiMessage } from '../ui-message.ts'
import { en } from './locale.ts'

export type Translator = PropsLocale<'aicraft'>['t']
/** Local messages retain the original failure, including unknown outcomes and nested causes. */
export interface Notice { value: unknown; context?: UiMessage }

/**
 * Retain an asynchronous result without freezing its language.
 */
export function notice(value: unknown, context?: UiMessage): Notice {
  return value && typeof value === 'object' && 'value' in value && !context ? value as Notice : { value, context }
}

/**
 * Translate a known descriptor; unknown keys use an action explanation and the original diagnostic.
 */
export function messageText(t: Translator, message: UiMessage | undefined, original?: string | null): string {
  if (!message || !Object.hasOwn(en, message.key)) {
    const details = original ?? message?.details?.join('\n')
    return details ? `${t('originalDetails')}: ${details}` : t('operationFailed')
  }
  const params = message.key === 'launchFound' && message.params ? { ...message.params, outcome: t(message.params.outcome === 'failed' ? 'runFailed' : message.params.outcome as 'completed' | 'interrupted' | 'unknown'), availability: t(message.params.availability as 'available' | 'unavailable') } : message.params
  return [t(message.key as keyof typeof en, params), ...(message.details ?? [])].join('\n')
}

/**
 * Render a retained failure at display time, preserving structured reasons and original external details.
 */
export function noticeText(t: Translator, retained: Notice | null): string {
  if (!retained) return ''
  if (retained.value && typeof retained.value === 'object' && 'value' in retained.value) return [retained.context && messageText(t, retained.context), noticeText(t, retained.value as Notice)].filter(Boolean).join('\n')
  const value = retained.value as {
    key?: string
    message?: string
    problem?: unknown
    verification?: { operation?: string; path?: string }
    details?: { problem?: unknown; operationStatus?: string; verification?: { operation?: string; path?: string } }
    cause?: unknown
  } | null
  const problem = value?.problem ?? value?.details?.problem
  const descriptor = value?.key ? value as UiMessage : messageOf(value)
  const original = value instanceof Error ? value.message : typeof value === 'string' ? value : value?.message
  const text = problem ? noticeText(t, notice(problem)) : descriptor
    ? messageText(t, descriptor, original)
    : [!retained.context && t('operationFailed'), messageText(t, descriptor, original)].filter(Boolean).join('\n')
  const verification = value?.verification ?? value?.details?.verification
  const outcome = verification || value?.details?.operationStatus === 'unknown'
    ? verification?.operation === 'material' ? t('outcomeUnknownMaterial', { path: verification.path ?? '' }) : t('outcomeUnknown')
    : ''
  return [retained.context && messageText(t, retained.context), text, outcome].filter(Boolean).join('\n')
}
