/**
 * Load `lib/client.js` the way the web client does, and check the surface it
 * hands back.
 *
 * The bundle is a browser script, not a module: it calls
 * `window.__ModuleLoader__.load(...)` at evaluation time and expects `react`
 * from the factory argument. This harness supplies both, so a broken wrapper —
 * a missing export, a factory that never returns, a `require` that escaped the
 * enclosing scope — fails here instead of in a settings page.
 */

import { readFileSync } from 'node:fs'

import assert from 'node:assert/strict'

const BUNDLE = new URL('../lib/client.js', import.meta.url)

interface Loaded {
  id: string
  exports: Record<string, unknown>
  required: string[]
}

/** A stand-in for React: enough surface for the factory to run. */
function fakeReact(): Record<string, unknown> {
  const createElement = (...args: unknown[]): unknown => ({ type: args[0], props: args[1], children: args.slice(2) })
  return {
    createElement,
    useCallback: (fn: unknown) => fn,
    useEffect: () => undefined,
    useRef: (value: unknown) => ({ current: value }),
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
    default: { createElement },
  }
}

function load(): Loaded {
  const source = readFileSync(BUNDLE, 'utf8')
  const required: string[] = []
  let loaded: Loaded | undefined
  const window = {
    __ModuleLoader__: {
      load(entry: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> }) {
        const exports = entry.factory((name: string) => {
          required.push(name)
          if (name === 'react') return fakeReact()
          if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
          throw new Error(`unexpected require(${name}) in the client bundle`)
        })
        loaded = { id: entry.id, exports, required }
      },
    },
  }
  // The bundle reads/writes only `window`; a Function scope keeps it hermetic.
  const run = new Function('window', 'document', `${source}\n`)
  run(window, undefined)
  assert.ok(loaded !== undefined, 'the bundle never called window.__ModuleLoader__.load')
  return loaded
}

// ---------------------------------------------------------------------------

const bundle = load()

assert.equal(bundle.id, '@mars-sea/dsh-river-provider', 'the loader id must be the package name')
assert.deepEqual(bundle.required, ['react'], 'the client bundle may require react and nothing else')

const { apply, inject } = bundle.exports as { apply?: unknown; inject?: unknown }
assert.equal(typeof apply, 'function', 'the client bundle must export apply')
assert.deepEqual(inject, ['slots', 'remote'], 'the client bundle must declare its services')

// The plugin half must not leak into the browser bundle: a settings card has no
// business holding an HTTP client or the account pool.
const source = readFileSync(BUNDLE, 'utf8')
for (const forbidden of ['node:fs', 'node:http', 'undici', 'RiverAccountPool', 'authorization']) {
  assert.ok(!source.includes(forbidden), `the client bundle must not reference ${forbidden}`)
}

// Every remote descriptor has to be a strict codec the Gateway can validate.
assert.ok(source.includes('river'), 'the bundle must name the remote namespace')
assert.ok(source.includes('settings.models.provider-card'), 'the bundle must register the provider card slot')
assert.ok(source.includes('settings.section'), 'the bundle must register the settings section slot')

console.log('client bundle: ok')
