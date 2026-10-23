/**
 * Volatile-config helpers for the DSH profile Config.
 *
 * `settings.describe()` projects each entry's schema through `volatileForm()`,
 * so a settings form contains ONLY nodes carrying `meta.volatile`, and the
 * loader resolves each marked field into a frozen `{ get() }` reference that is
 * written IN PLACE (no remount). Two helpers keep the rest of the plugin
 * reading a PLAIN `Config`: `markVolatile()` applies the mark, and
 * `unwrapVolatileConfig()` reads every top-level field through its reference
 * when one is present — FRESH per call, because a reference's identity is
 * stable while its value changes.
 *
 * Only TOP-LEVEL fields are marked (a form write names a top-level path such
 * as `accounts`), so one unwrap level is complete. Literal `apiKey` secrets
 * stay unmarked on purpose: no settings surface writes them — both the web page
 * and the config file write keys through the credentials seam — so a
 * config-file edit to a secret literal reloading the fiber is correct.
 *
 * @module dsh-river-provider/config-volatile
 */
/**
 * Mark one schema field volatile.
 *
 * `.volatile()` is a schemastery 3.18.3 feature and the supported engine ships
 * `~3.18.5`, so the method is always present. It is reached through a
 * structural member so the caller's declared field type survives — the mark
 * changes what the schema PARSES to (a live reference), not the plugin-facing
 * `Config` shape.
 */
export declare function markVolatile<S>(schema: S): S;
/**
 * Mark every field of a Config field dict volatile, except the named
 * composition-only secrets (`apiKey`, which no settings surface writes).
 */
export declare function markVolatileFields<D extends Record<string, unknown>>(fields: D, skip?: readonly string[]): D;
/** A resolved volatile config reference: the frozen `{ get() }` cosmos hands out. */
export interface VolatileRef {
    get(): unknown;
}
/**
 * Whether a resolved config value is a volatile reference.
 *
 * Duck-typed on the two properties `createVolatile` produces (frozen object
 * with a `get` method) rather than the internal `write` symbol, because the
 * config runtime is not a peer of this bundle. Config values are plain parsed
 * JSON, which are never frozen, so the test cannot misfire on a plain field.
 */
export declare function isVolatileRef(value: unknown): value is VolatileRef;
/**
 * Read one config object as PLAIN values.
 *
 * Every top-level field found to be a volatile reference is read through
 * `.get()` — freshly on every call, so a live update lands on the very next
 * read. The pass-through for a field that is not a reference is what keeps the
 * unmarked `apiKey` literal readable.
 */
export declare function unwrapVolatileConfig<C>(config: C): C;
