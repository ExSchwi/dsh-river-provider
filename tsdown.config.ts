import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

import { defineConfig } from 'tsdown'

/**
 * The browser half of the build: `src/client.tsx` → `lib/client.js`.
 *
 * The Host half is emitted by `tsc -p tsconfig.build.json` instead, because it
 * carries standard decorators that this bundler passes through untransformed
 * (see `tsconfig.build.json` for the whole story). `npm run build` runs both,
 * in that order.
 *
 * The web client does not `import` the bundle; it evaluates the file and
 * expects a `window.__ModuleLoader__.load` call whose factory returns the
 * module exports. The wrapper is applied after the bundler is done, so nothing
 * inside the bundle can shadow it.
 */

const CLIENT_PACKAGE = '@mars-sea/dsh-river-provider'
const GLOBAL_NAME = '__riverClient'

/** The loader protocol: an id, and a factory receiving the client's `require`. */
const CLIENT_BANNER = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(CLIENT_PACKAGE)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '',
].join('\n')

/**
 * Close the factory and publish the bundle's exports.
 *
 * tsdown/rolldown has no "IIFE that returns its exports" output format: it
 * assigns them to `globalName` instead, so the wrapper copies that object onto
 * `module.exports` — which is what the client reads off the factory's return.
 */
const CLIENT_FOOTER = [
  '',
  `\t\tfor (const key of Object.keys(${GLOBAL_NAME})) exports[key] = ${GLOBAL_NAME}[key];`,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

export default defineConfig([
  {
    entry: { client: 'src/client.tsx' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    clean: false,
    sourcemap: true,
    dts: false,
    globalName: GLOBAL_NAME,
    // Supplied by the web client's own module graph, never bundled: a second
    // React instance would break hooks across the boundary.
    deps: {
      neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    },
    outExtensions: () => ({ js: '.js' }),
    hooks: {
      'build:done': (ctx) => wrapClientBundle(ctx.options.outDir),
    },
  },
])

/**
 * Wrap the emitted `lib/client.iife.js` into `lib/client.js`.
 *
 * Two rewrites are needed, both invisible from the source:
 *
 * 1. The file becomes a `__ModuleLoader__.load` module, matching what the web
 *    client evaluates.
 * 2. The IIFE's factory parameter is renamed to its external's binding. An IIFE
 *    build gives the factory `exports` and the *global* name of each external;
 *    at the top level of a module `react` is a free variable, so the parameter
 *    must be spelled `react` for `require('react')` to be honoured — otherwise
 *    the factory closes over whatever global happens to exist, or throws.
 */
function wrapClientBundle(outDir: string): void {
  const path = `${outDir}/client.iife.js`
  const target = `${outDir}/client.js`
  const raw = readFileSync(path, 'utf8')
  const mapLine = lastLine(raw)
  const body = mapLine === '' ? raw : raw.slice(0, raw.length - mapLine.length - 1)
  const map = mapLine === '' ? '' : `${mapLine.replace('client.iife.js.map', 'client.js.map')}\n`
  writeFileSync(target, `${CLIENT_BANNER}${renameFactoryParams(body)}${CLIENT_FOOTER}${map}`, 'utf8')
  unlinkSync(path)
  try {
    renameSync(`${outDir}/client.iife.js.map`, `${outDir}/client.js.map`)
  } catch {
    // No sourcemap was emitted; nothing to move.
  }
}

/**
 * Give the IIFE factory the parameter names the loader provides.
 *
 * `(function (exports, react) { ... })({}, react)` already uses `react`; a
 * second external would arrive as its globals name, which the factory does not
 * receive, so `require` is threaded through by making every external parameter
 * an explicit `require(...)` call at the call site instead.
 */
function renameFactoryParams(body: string): string {
  const open = body.indexOf('(function(')
  if (open < 0) return body
  const paramsEnd = body.indexOf(')', open)
  const callStart = body.lastIndexOf('})(')
  if (paramsEnd < 0 || callStart < 0) return body
  const params = body.slice(open + '(function('.length, paramsEnd).split(',').map((name) => name.trim())
  if (params.length < 2) return body
  const args = body.slice(callStart + '})('.length, body.indexOf(')', callStart + 3))
  const supplied = args.split(',').map((value) => value.trim())
  const next = supplied.map((value, index) => (index === 0 ? value : `require(${JSON.stringify(params[index])})`))
  const head = body.slice(0, callStart + '})('.length)
  const closeIndex = body.indexOf(')', callStart + 3)
  if (closeIndex < 0) return body
  // `closeIndex` addresses the closing paren of the argument list, which the
  // rebuilt text re-emits after the new arguments.
  const tail = body.slice(closeIndex)
  return `${head}${next.join(', ')}${tail}`
}

/** The trailing `//# sourceMappingURL=` line, or an empty string. */
function lastLine(raw: string): string {
  const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const index = trimmed.lastIndexOf('\n')
  const line = index < 0 ? trimmed : trimmed.slice(index + 1)
  return line.startsWith('//# sourceMappingURL=') ? line : ''
}
