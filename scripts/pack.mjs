/**
 * FILE: plugin/scripts/pack.mjs
 * DESCRIPTION: Pack installable files without source-only README image links
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const destination = resolve(root, process.argv[2] ?? '.')
const readmes = ['README.md', 'README.en.md'].map(name => [join(root, name), readFileSync(join(root, name))])
const args = ['pack', '--skip-manifest-obfuscation', '--pack-destination', destination]
const manager = process.env.npm_execpath ?? 'pnpm'

try {
  for (const [file, content] of readmes) {
    writeFileSync(file, content.toString('utf8').replace(/^!\[[^\n]*\]\(assets\/aicraft\.png\)\r?\n\r?\n/gm, ''))
  }
  if (/\.[cm]?js$/.test(manager)) {
    execFileSync(process.execPath, [manager, ...args], { cwd: root, stdio: 'inherit' })
  } else {
    execFileSync(manager, args, { cwd: root, stdio: 'inherit' })
  }
} finally {
  for (const [file, content] of readmes) writeFileSync(file, content)
}
