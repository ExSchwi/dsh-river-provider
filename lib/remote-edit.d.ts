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
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { RiverEdit } from './remote-wire.ts';
/** What an edit needs from the plugin. */
export interface EditDeps {
    /** Settings namespace the form writes into. */
    ns: string;
    /** The live settings service, absent when the profile has no writable form. */
    settings: () => {
        update(ns: string, patch: object): Promise<void>;
    } | undefined;
    /** The credential store, for literal keys. */
    credentials: () => {
        set(ref: CredentialRef, value: string): Promise<void>;
    } | undefined;
}
/** A refused edit, carrying the message the page shows. */
export declare class EditRefused extends Error {
}
/**
 * Turn one form edit into the patch the settings service merges.
 *
 * The patch names ONLY the edited key: `update` is a merge, so a field the page
 * did not touch keeps whatever the profile already had.
 */
export declare function patchFor(edit: RiverEdit): Record<string, unknown>;
/**
 * Apply one edit.
 *
 * @returns the state after the write, or the reason it was refused. A refusal is
 * a normal answer, not a thrown error: the page renders it next to the field.
 */
export declare function applyEdit(deps: EditDeps, edit: RiverEdit): Promise<{
    ok: true;
}>;
/**
 * Store one literal key for an account.
 *
 * A literal key typed into the page is written to the credential store, not to
 * the profile file: the settings document is plain text on disk and a key there
 * would be both stored in the clear and re-shown by any config dump.
 */
export declare function storeAccountKey(deps: EditDeps, target: {
    ref: string;
    key: string;
}): Promise<{
    ok: true;
}>;
