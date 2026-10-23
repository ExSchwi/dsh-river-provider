/**
 * The Remote wire contract between the Host and the settings page.
 *
 * Both halves need the exact same descriptor: the Host registers it on
 * `ctx.typert` so the Gateway can dispatch, and the Client mounts it on
 * `ctx.remote` so the page can call. Duplicating the shapes is how a rename on
 * one side becomes a runtime "no such endpoint" on the other, so this module is
 * the single source and both bundles import it.
 *
 * Validation is hand-rolled on purpose: the Client bundle may not pull a schema
 * library, and {@link TypertSchema} only asks for `parse`.
 *
 * @module dsh-river-provider/remote-wire
 */
/** Namespace every river Remote lives under: `river/<method>`. */
export const REMOTE_NAMESPACE = 'river';
/** Cordis service key the Gateway resolves the Remote receiver by. */
export const REMOTE_SERVICE = 'riverAccounts';
/** Package id stamped on every descriptor. */
export const REMOTE_PACKAGE = '@mars-sea/dsh-river-provider';
/** Build one direct descriptor: `river/<method>`, result validated by `parse`. */
export function makeDescriptor(endpoint, method, typeSymbol, parse) {
    return {
        id: `${REMOTE_PACKAGE}#${endpoint}`,
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method,
        invocation: { kind: 'direct' },
        parameters: [],
        // `parameters` above carries the write verbs; unary methods that take an
        // argument declare it, and the Gateway rejects an undeclared field.
        result: { mode: 'strict', typeSymbol, create: () => ({ parse }) },
    };
}
/**
 * A descriptor that takes exactly one JSON argument.
 *
 * `wire` is the field name inside the wire `args` object; the Client calls
 * `namespace.method(value)` and the carrier sends `{ [wire]: value }`.
 */
export function makeUnaryDescriptor(endpoint, method, typeSymbol, wire, parseResult, parseInput = (value) => value) {
    return {
        ...makeDescriptor(endpoint, method, typeSymbol, parseResult),
        parameters: [{
                name: wire,
                wire,
                source: 'json',
                codec: { mode: 'strict', typeSymbol: `${typeSymbol}Input`, create: () => ({ parse: parseInput }) },
            }],
    };
}
// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------
class WireError extends TypeError {
}
function record(value, field) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new WireError(`river result: invalid ${field}`);
    }
    return value;
}
function str(source, key, field) {
    const value = source[key];
    if (typeof value !== 'string')
        throw new WireError(`river result: invalid ${field}`);
    return value;
}
function num(source, key, field) {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new WireError(`river result: invalid ${field}`);
    return value;
}
function bool(source, key, field) {
    const value = source[key];
    if (typeof value !== 'boolean')
        throw new WireError(`river result: invalid ${field}`);
    return value;
}
function strings(source, key, field) {
    const value = source[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new WireError(`river result: invalid ${field}`);
    }
    return value;
}
function stringMap(source, key, field) {
    const value = source[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new WireError(`river result: invalid ${field}`);
    }
    const result = {};
    for (const [name, entry] of Object.entries(value)) {
        if (typeof entry !== 'string')
            throw new WireError(`river result: invalid ${field}`);
        result[name] = entry;
    }
    return result;
}
const STATUSES = new Set(['ready', 'cooldown', 'disabled', 'unconfigured']);
/** Parse the untrusted `river/state` result. */
export function parseSnapshot(value) {
    const source = record(value, 'result');
    const accounts = source.accounts;
    if (!Array.isArray(accounts))
        throw new WireError('river result: invalid accounts');
    const models = source.models;
    if (!Array.isArray(models))
        throw new WireError('river result: invalid models');
    const defaults = record(source.defaults, 'defaults');
    const rules = source.modelAccountRules;
    if (!Array.isArray(rules))
        throw new WireError('river result: invalid modelAccountRules');
    return {
        provider: str(source, 'provider', 'provider'),
        apiBase: str(source, 'apiBase', 'apiBase'),
        accounts: accounts.map((entry) => {
            const account = record(entry, 'account');
            const status = str(account, 'status', 'account.status');
            if (!STATUSES.has(status))
                throw new WireError('river result: invalid account.status');
            return {
                id: str(account, 'id', 'account.id'),
                label: str(account, 'label', 'account.label'),
                ref: str(account, 'ref', 'account.ref'),
                configured: bool(account, 'configured', 'account.configured'),
                active: bool(account, 'active', 'account.active'),
                status: status,
                reason: str(account, 'reason', 'account.reason'),
                cooldownUntil: num(account, 'cooldownUntil', 'account.cooldownUntil'),
            };
        }),
        models: models.map((entry) => {
            const model = record(entry, 'model');
            const price = record(model.price, 'model.price');
            return {
                id: str(model, 'id', 'model.id'),
                name: str(model, 'name', 'model.name'),
                contextWindow: num(model, 'contextWindow', 'model.contextWindow'),
                maxOutputTokens: num(model, 'maxOutputTokens', 'model.maxOutputTokens'),
                vision: bool(model, 'vision', 'model.vision'),
                efforts: strings(model, 'efforts', 'model.efforts'),
                defaultEffort: str(model, 'defaultEffort', 'model.defaultEffort'),
                visible: bool(model, 'visible', 'model.visible'),
                price: {
                    input: num(price, 'input', 'model.price.input'),
                    cachedInput: num(price, 'cachedInput', 'model.price.cachedInput'),
                    output: num(price, 'output', 'model.price.output'),
                },
            };
        }),
        defaults: {
            contextWindowLimit: num(defaults, 'contextWindowLimit', 'defaults.contextWindowLimit'),
            maxOutputTokens: num(defaults, 'maxOutputTokens', 'defaults.maxOutputTokens'),
            activeAccount: str(defaults, 'activeAccount', 'defaults.activeAccount'),
            defaultReasoningEffort: stringMap(defaults, 'defaultReasoningEffort', 'defaults.defaultReasoningEffort'),
        },
        modelAccountRules: rules.map((entry) => {
            const rule = record(entry, 'rule');
            return { models: strings(rule, 'models', 'rule.models'), account: str(rule, 'account', 'rule.account') };
        }),
        ui: {
            showSettingsSection: bool(record(source.ui, 'ui'), 'showSettingsSection', 'ui.showSettingsSection'),
        },
    };
}
/** Parse the untrusted `river/edit` result. */
export function parseEditOutcome(value) {
    const source = record(value, 'result');
    const ok = bool(source, 'ok', 'ok');
    if (!ok)
        return { ok: false, error: str(source, 'error', 'error') };
    return { ok: true, snapshot: parseSnapshot(source.snapshot) };
}
/** Parse the untrusted `river/setAccountKey` result. */
export function parseCredentialOutcome(value) {
    const source = record(value, 'result');
    const ok = bool(source, 'ok', 'ok');
    if (!ok)
        return { ok: false, error: str(source, 'error', 'error') };
    return { ok: true };
}
const EDIT_FIELDS = new Set([
    'apiBase', 'apiKeyEnv', 'activeAccount', 'contextWindowLimit', 'maxOutputTokens',
    'defaultReasoningEffort', 'modelVisibility', 'visibleModels', 'accounts', 'modelAccountRules',
    'showSettingsSection',
]);
/** Parse the untrusted `river/edit` argument. */
export function parseEdit(value) {
    const source = record(value, 'edit');
    const field = str(source, 'field', 'edit.field');
    if (!EDIT_FIELDS.has(field))
        throw new WireError(`river result: unknown edit field ${field}`);
    return { field: field, value: source.value };
}
// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
/** Every endpoint path, so a rename cannot drift between the faces. */
export const ENDPOINTS = {
    state: `${REMOTE_NAMESPACE}/state`,
    refresh: `${REMOTE_NAMESPACE}/refresh`,
    edit: `${REMOTE_NAMESPACE}/edit`,
    setAccountKey: `${REMOTE_NAMESPACE}/setAccountKey`,
};
/** The descriptor set both faces share. */
export function remoteDescriptors() {
    return [
        makeDescriptor(ENDPOINTS.state, 'state', `${REMOTE_PACKAGE}#RiverSnapshot`, parseSnapshot),
        makeDescriptor(ENDPOINTS.refresh, 'refresh', `${REMOTE_PACKAGE}#RiverSnapshot`, parseSnapshot),
        makeUnaryDescriptor(ENDPOINTS.edit, 'edit', `${REMOTE_PACKAGE}#RiverEditOutcome`, 'edit', parseEditOutcome, parseEdit),
        makeUnaryDescriptor(ENDPOINTS.setAccountKey, 'setAccountKey', `${REMOTE_PACKAGE}#RiverCredentialOutcome`, 'target', parseCredentialOutcome, (value) => {
            const source = record(value, 'target');
            return { ref: str(source, 'ref', 'target.ref'), key: str(source, 'key', 'target.key') };
        }),
    ];
}
//# sourceMappingURL=remote-wire.js.map