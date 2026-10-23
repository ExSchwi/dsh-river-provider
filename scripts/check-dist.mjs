/**
 * Post-build gate: every shipped file must be loadable by the runtime that
 * receives it.
 *
 * This exists because of a real failure. The Host half once shipped with raw
 * standard-decorator syntax (`@Remote`), which the bundler passed through
 * untransformed. Nothing failed at build time and no test imported `lib/`, so
 * the plugin looked published and healthy — while the kernel could not import
 * it at all:
 *
 *     llm-river (@mars-sea/dsh-river-provider): failed to import:
 *     SyntaxError: Invalid or unexpected token
 *
 * A syntax check of the built artifacts catches that in a second, without
 * needing a kernel.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = 'lib'
const failures = []

/** Files whose syntax must be valid ESM to the Node that imports them. */
const host = readdirSync(LIB).filter((name) => name.endsWith('.js') && name !== 'client.js')

for (const name of host) {
  try {
    // `--check` with stdin needs an explicit module goal, since a redirected
    // file has no `.mjs` extension for Node to infer one from.
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: readFileSync(join(LIB, name)),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).split('\n')[1] : String(error)
    failures.push(`${name}: ${detail.trim()}`)
  }
}

// The browser half is not imported by Node — it is evaluated by the web
// client, which looks for exactly this call. A bundle without it loads as a
// silent no-op.
const client = readFileSync(join(LIB, 'client.js'), 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load(')) {
  failures.push('client.js: does not start with the __ModuleLoader__.load wrapper')
}
for (const marker of ['settings.models.provider-card', 'settings.section']) {
  if (!client.includes(marker)) failures.push(`client.js: missing the "${marker}" registration`)
}

if (failures.length > 0) {
  console.error('dist check failed:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`dist check ok: ${host.length} host module(s) parse as ESM, client bundle wrapped`)
