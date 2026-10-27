/**
 * FILE: plugin/src/dsh-integration/git.ts
 * DESCRIPTION: Read optional Git branch and worktree metadata
 */
import type Subprocess from '@deepseek-ai/dsh-subprocess'
import type { ProjectConfig } from './config.ts'

async function git(
  subprocess: Subprocess,
  cwd: string,
  args: string[],
  config: ProjectConfig,
  signal: AbortSignal,
):
Promise<string | null> {
  const executable = await subprocess.resolveExecutable('git')
  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(config.gitTimeoutMs)])
  const handle = subprocess.spawn({
    argv: [executable, ...args], cwd, signal: runSignal,
    graceMs: config.gitGraceMs, stdio: { stdin: 'ignore', stdout: { maxBytes: 32768 }, stderr: { maxBytes: 32768 } },
  })
  const outcome = await handle.done
  runSignal.throwIfAborted()
  if (outcome.exitCode !== 0) return null
  const output = handle.collected.stdout?.readFrom(0)
  if (!output || output.lossy) throw new Error('Could not read complete Git output')
  return output.text.trim()
}
/**
 * START_METHOD_gitDirectory
 * Per-worktree metadata directory; HEAD lives here even when .git is a file.
 */
export async function gitDirectory(
  subprocess: Subprocess,
  cwd: string,
  config: ProjectConfig,
  signal: AbortSignal,
):
Promise<string | null> {
  try { return await git(subprocess, cwd, ['rev-parse', '--absolute-git-dir'], config, signal) }
  catch { signal.throwIfAborted(); return null }
}
// END_METHOD_gitDirectory

/**
 * START_METHOD_currentBranch
 * Read the branch as a reminder; missing Git never blocks project operations.
 */
export async function currentBranch(
  subprocess: Subprocess,
  cwd: string,
  config: ProjectConfig,
  signal: AbortSignal,
):
Promise<string | null> {
  try { return await git(subprocess, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], config, signal) }
  catch { signal.throwIfAborted(); return null }
}
// END_METHOD_currentBranch
