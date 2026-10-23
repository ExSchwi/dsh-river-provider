/**
 * Writing the settings page's edits back into the profile.
 *
 * Every write goes through {@link SettingsForms.update}, which merges the patch
 * into the profile's own `cordis.patch.yml` and re-reads it: the plugin never
 * edits a file itself. That matters because the same section is ALSO loaded from
 * the composed `cordis.yml` — a hand edit there would be shadowed, and a hand
 * edit here could race the settings service's own revision tracking.
 *
 * @module dsh-river-provider/remote-edit
 */
import { KNOWN_MODELS, modelFacts } from "./capabilities.js";
import { credentialRef } from '@deepseek-ai/dsh-credentials';
/** A refused edit, carrying the message the page shows. */
export class EditRefused extends Error {
}
function refuse(message) {
    throw new EditRefused(message);
}
/** Cap on a capacity, mirroring the schema's own bound. */
const CAPACITY_MAX = 8_388_608;
function capacity(field, value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        refuse(`${field} must be a positive number.`);
    }
    if (value > CAPACITY_MAX)
        refuse(`${field} must not exceed ${CAPACITY_MAX}.`);
    return Math.floor(value);
}
/**
 * Validate one effort map against river's per-model whitelists.
 *
 * A level a model does not accept is refused HERE rather than at request time:
 * {@link configuredEffort} treats it as a configuration error and fails the
 * turn, so letting the page store it would break every request that model
 * serves. The check runs against each known model the glob selects.
 */
function effortMap(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        refuse('defaultReasoningEffort must be an object of model → effort.');
    }
    const result = {};
    for (const [pattern, level] of Object.entries(value)) {
        if (typeof level !== 'string')
            refuse(`The effort for ${pattern} must be a string.`);
        const trimmed = level.trim();
        if (trimmed === '')
            continue;
        result[pattern] = trimmed;
        if (trimmed === 'auto')
            continue;
        // Validate against every known model the pattern selects. A pattern that
        // selects none is stored as typed: river may serve a model this snapshot
        // has not learned yet, and refusing it would make the form unusable after
        // a catalog release.
        for (const model of Object.keys(KNOWN_MODELS)) {
            if (!matches(pattern, model))
                continue;
            const facts = modelFacts(model);
            if (facts.efforts.length === 0) {
                refuse(`${model} has no reasoning support, so "${trimmed}" cannot be set for ${pattern}.`);
            }
            if (!facts.efforts.includes(trimmed)) {
                refuse(`${model} accepts only ${facts.efforts.join('|')} for reasoning_effort, not "${trimmed}".`);
            }
        }
    }
    return result;
}
/** Glob match: `*` only, which is all river model ids need. */
function matches(pattern, model) {
    if (pattern === model)
        return true;
    if (!pattern.includes('*'))
        return false;
    const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escaped.join('.*')}$`).test(model);
}
/**
 * Turn one form edit into the patch the settings service merges.
 *
 * The patch names ONLY the edited key: `update` is a merge, so a field the page
 * did not touch keeps whatever the profile already had.
 */
export function patchFor(edit) {
    switch (edit.field) {
        case 'apiBase': {
            const value = String(edit.value ?? '').trim();
            if (value === '')
                return { apiBase: undefined };
            if (!/^https?:\/\//.test(value))
                refuse('The base URL must start with http:// or https://.');
            return { apiBase: value.replace(/\/+$/, '') };
        }
        case 'apiKeyEnv': {
            const value = String(edit.value ?? '').trim();
            if (value === '')
                return { apiKeyEnv: undefined };
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
                refuse('An environment variable name takes letters, digits and underscores.');
            return { apiKeyEnv: value };
        }
        case 'activeAccount': {
            const value = String(edit.value ?? '').trim();
            return { activeAccount: value === '' ? undefined : value };
        }
        case 'contextWindowLimit': {
            const value = capacity('The context window', edit.value);
            return { contextWindowLimit: value === 0 ? undefined : value };
        }
        case 'maxOutputTokens': {
            const value = capacity('The output budget', edit.value);
            return { maxOutputTokens: value === 0 ? undefined : value };
        }
        case 'defaultReasoningEffort':
            return { defaultReasoningEffort: effortMap(edit.value) };
        case 'modelVisibility': {
            const value = edit.value;
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                refuse('modelVisibility must be an object of model → boolean.');
            }
            const result = {};
            for (const [model, visible] of Object.entries(value)) {
                if (typeof visible !== 'boolean')
                    refuse(`The visibility of ${model} must be true or false.`);
                result[model] = visible;
            }
            return { modelVisibility: result };
        }
        case 'visibleModels': {
            if (!Array.isArray(edit.value) || edit.value.some((item) => typeof item !== 'string')) {
                refuse('visibleModels must be a list of model ids.');
            }
            return { visibleModels: [...edit.value] };
        }
        case 'accounts': {
            if (!Array.isArray(edit.value))
                refuse('accounts must be a list.');
            const result = edit.value.map((account, index) => {
                const ref = account.apiKeyEnv?.trim() ?? '';
                if (ref !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
                    refuse(`Account ${index + 2}: an environment variable name takes letters, digits and underscores.`);
                }
                const label = account.label?.trim() ?? '';
                const literal = account.apiKey?.trim() ?? '';
                return {
                    ...(label === '' ? {} : { label }),
                    ...(ref === '' ? {} : { apiKeyEnv: ref }),
                    ...(literal === '' ? {} : { apiKey: literal }),
                };
            });
            return { accounts: result };
        }
        case 'modelAccountRules': {
            if (!Array.isArray(edit.value))
                refuse('modelAccountRules must be a list.');
            const result = edit.value.map((rule, index) => {
                if (!Array.isArray(rule.models) || rule.models.some((item) => typeof item !== 'string')) {
                    refuse(`Rule ${index + 1}: models must be a list of ids or globs.`);
                }
                if (typeof rule.account !== 'string' || rule.account.trim() === '') {
                    refuse(`Rule ${index + 1}: an account is required.`);
                }
                return { models: rule.models, account: rule.account.trim() };
            });
            return { modelAccountRules: result };
        }
        case 'showSettingsSection': {
            if (typeof edit.value !== 'boolean')
                refuse('showSettingsSection must be true or false.');
            return { showSettingsSection: edit.value };
        }
        default: {
            // `edit.field` is validated at the boundary, so this is unreachable.
            refuse(`Unknown setting ${edit.field}.`);
        }
    }
}
/**
 * Apply one edit.
 *
 * @returns the state after the write, or the reason it was refused. A refusal is
 * a normal answer, not a thrown error: the page renders it next to the field.
 */
export async function applyEdit(deps, edit) {
    const settings = deps.settings();
    if (settings === undefined) {
        refuse('This profile has no writable settings form, so the edit was not stored.');
    }
    const patch = patchFor(edit);
    try {
        await settings.update(deps.ns, patch);
    }
    catch (error) {
        refuse(error instanceof Error ? error.message : String(error));
    }
    return { ok: true };
}
/**
 * Store one literal key for an account.
 *
 * A literal key typed into the page is written to the credential store, not to
 * the profile file: the settings document is plain text on disk and a key there
 * would be both stored in the clear and re-shown by any config dump.
 */
export async function storeAccountKey(deps, target) {
    const ref = target.ref.trim();
    const key = target.key.trim();
    if (ref === '')
        refuse('An account reference is required.');
    if (key === '')
        refuse('The key is empty.');
    const credentials = deps.credentials();
    if (credentials === undefined)
        refuse('This profile has no credential store; set the key as an environment variable instead.');
    const value = credentialRef(ref);
    // Store through the same seam the adapter resolves, so a saved key is one the
    // next request reads — no restart, no second source of truth.
    await credentials.set(value, key);
    return { ok: true };
}
//# sourceMappingURL=remote-edit.js.map