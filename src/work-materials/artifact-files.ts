/**
 * FILE: plugin/src/work-materials/artifact-files.ts
 * DESCRIPTION: Resolve contained paths and scan bounded material trees
 */
import { diagnosticRejection } from '../dsh-integration/diagnostics.ts'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

const MAX_FILES = 500

/**
 * START_METHOD_targetFor
 * Resolve only AICraft materials inside the registered project, including link targets.
 */
export async function targetFor(fs: FileSystem, cwd: string, path: string, signal?: AbortSignal) {
  if (!path.startsWith('.aicraft/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) {
    throw diagnosticRejection(new Error('Artifact path must be inside .aicraft'))
  }
  const root = await fs.resolve(cwd, { signal })
  const target = await fs.resolve(path, { cwd, signal })
  if (!fs.contains(root, target)) throw diagnosticRejection(new Error('Artifact is outside the selected project'))
  const aicraft = await fs.resolve('.aicraft', { cwd, signal })
  if (!fs.contains(root, aicraft) || !fs.contains(aicraft, target)) throw diagnosticRejection(new Error('Artifact is outside .aicraft'))
  return target
}
// END_METHOD_targetFor

/** Share bounded recursive artifact discovery between the list and step counts. */
export function createArtifactScanner(fs: FileSystem, cwd: string, signal: AbortSignal, maxFiles = MAX_FILES, firstOnly = false) {
  let count = 0
  const scan = async (path: string, depth = 0): Promise<string[]> => {
    signal.throwIfAborted()
    if (depth > 20) throw diagnosticRejection(new Error('Artifact directory nesting is too deep'))
    const info = await fs.lstat(path, { cwd }, signal)
    if (!info || info.type === 'symlink' || info.type === 'other') return []
    const target = await targetFor(fs, cwd, path, signal)
    if (info.type === 'file') {
      if (++count > maxFiles) throw diagnosticRejection(new Error('Too many artifacts to display (limit: 500 files)'))
      return [path]
    }
    const files: string[] = []
    for (const entry of await fs.listDir(target, signal)) {
      if (entry.name === '.git' || entry.name === '.gitkeep' || entry.name.startsWith('.creating-')) continue
      // DSH resolves directory entries; reject escaped links before traversing them.
      const child = `${path}/${entry.name}`
      const childInfo = await fs.lstat(child, { cwd }, signal)
      if (childInfo?.type === 'symlink') continue
      files.push(...await scan(child, depth + 1))
      if (firstOnly && files.length) return files
    }
    return files.sort((a, b) => a.localeCompare(b))
  }
  return scan
}
/**
 * START_METHOD_artifactSummary
 * Artifact discovery failures must not invalidate otherwise valid task state.
 */
export async function artifactSummary(
  fs: FileSystem,
  cwd: string,
  path: string,
  signal: AbortSignal,
): Promise<{
  artifactCount: number | null
  artifactIssue: string | null }> {
  try {
    return { artifactCount: (await createArtifactScanner(fs, cwd, signal, Infinity)(path)).length, artifactIssue: null }
  } catch (error) {
    signal.throwIfAborted()
    return { artifactCount: null, artifactIssue: error instanceof Error ? error.message : String(error) }
  }
}
// END_METHOD_artifactSummary

/**
 * START_METHOD_hasKnowledgeMaterials
 * Detect a first usable knowledge material without loading the corpus.
 */
export async function hasKnowledgeMaterials(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<boolean> {
  const path = '.aicraft/knowledge-base'
  return (await fs.lstat(path, { cwd }, signal))?.type === 'directory'
    && (await createArtifactScanner(fs, cwd, signal, 1, true)(path)).length > 0
}
// END_METHOD_hasKnowledgeMaterials
