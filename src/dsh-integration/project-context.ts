/**
 * FILE: plugin/src/dsh-integration/project-context.ts
 * DESCRIPTION: Resolve registered workspaces and session-owned project paths
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { resolve } from 'node:path'

/**
 * START_METHOD_resolveProject
 * resolveProject operation.
 */

export function resolveProject(ctx: Context, workspaceId: string): string {
  const workspace = ctx.workspaceRegistry.get(brandString<WorkspaceId>(workspaceId))
  if (!workspace) throw new Error('The selected project is no longer registered in DSH')
  const cwd = ctx.fs.processPathFromHostPath(workspace.path)
  if (cwd === undefined) throw new Error('The filesystem provider cannot read this project')
  return cwd
}
// END_METHOD_resolveProject

/**
 * START_METHOD_workspaceForAgent
 * Resolve a registered project for an agent's actual working directory.
 * @param cwd - Session-owned directory, never a model argument.
 * @returns The matching Workspace identity.
 */
export function workspaceForAgent(ctx: Context, cwd: string): string {
  const workspace = ctx.workspaceRegistry.list().find(item => resolve(item.path) === resolve(cwd))
  if (!workspace) throw new Error('The session directory is not a registered DSH project')
  return workspace.id
}
// END_METHOD_workspaceForAgent
