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
import { test } from 'node:test'

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

// ---------------------------------------------------------------------------
// Run `apply` for real.
//
// The source scans above prove the strings are present, which is exactly the
// assertion that let a host half ship that the kernel could not import at all.
// So this drives the entry point with a fake client context and checks what it
// actually registers: a bundle that loads but registers nothing is the failure
// mode that has no error message anywhere.
// ---------------------------------------------------------------------------

/** A snapshot the host could really emit; the client parser is strict. */
function snapshot(showSettingsSection: boolean): unknown {
  return {
    provider: 'river',
    apiBase: 'https://api.river.ai/v1',
    accounts: [],
    models: [],
    defaults: {
      contextWindowLimit: 1_048_576,
      maxOutputTokens: 384_000,
      activeAccount: '',
      defaultReasoningEffort: {},
    },
    modelAccountRules: [],
    ui: { showSettingsSection },
  }
}

interface Recording {
  injected: string[]
  registered: Array<{ name?: string; key?: string; id?: string }>
  mounted: string[]
  warns: string[]
}

/** A client context with only the services `apply` touches. */
function fakeContext(showSettingsSection: boolean): { ctx: Record<string, unknown>; seen: Recording } {
  const seen: Recording = { injected: [], registered: [], mounted: [], warns: [] }
  const ctx: Record<string, unknown> = {
    logger: { warn: (message: string) => seen.warns.push(message) },
    effect: (run: () => unknown) => run(),
    get: (key: string) => (key === 'remote.river'
      // A Remote call answers with an envelope, not with the payload itself.
      ? { state: async () => ({ ok: true, value: snapshot(showSettingsSection) }) }
      : undefined),
    inject: (_names: unknown, run: (value: unknown) => void) => run(ctx),
    remote: {
      $mount: async (spec: { package: string }) => {
        seen.mounted.push(spec.package)
        return () => undefined
      },
    },
    slots: {
      inject: (name: string, run: () => void) => {
        seen.injected.push(name)
        run()
      },
      register: (options: Record<string, unknown>) => {
        seen.registered.push(options as Recording['registered'][number])
        return () => undefined
      },
    },
  }
  return { ctx, seen }
}

test('apply registers the provider card and mounts the Remote', async () => {
  const { ctx, seen } = fakeContext(false)
  const apply = bundle.exports.apply as (value: unknown) => void
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(seen.mounted, ['@mars-sea/dsh-river-provider'], 'the bundle must mount its Remote namespace')
  assert.ok(seen.injected.includes('settings.models.provider-card'), 'the provider card slot must be waited for')
  const card = seen.registered.find((entry) => entry.name === 'settings.models.provider-card')
  assert.ok(card !== undefined, 'the bundle must register the provider card')
  assert.equal(card.key, 'llm-river', 'the card is keyed by the settings namespace')
  assert.deepEqual(seen.warns, [], 'registration must not fall into a warning path')
})

test('the settings section stays out until the switch is on', async () => {
  const { ctx, seen } = fakeContext(true)
  const apply = bundle.exports.apply as (value: unknown) => void
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.ok(seen.injected.includes('settings.section'), 'the section slot must be waited for')
  const section = seen.registered.find((entry) => entry.name === 'settings.section')
  assert.ok(section !== undefined, 'an enabled switch must register the section')
  assert.equal(section.id, 'river', 'the section id names the provider')
})

console.log('client bundle: ok')
