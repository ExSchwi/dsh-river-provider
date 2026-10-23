/**
 * Settings-page value shapes for the Remote faces.
 *
 * `remote-wire.ts` owns the wire contracts; this module holds the small local
 * view types the Host passes around before they are shaped for the wire, so a
 * Host-side helper never has to import the whole wire module.
 *
 * @module dsh-river-provider/remote-types
 */
/** The provider settings the page can read but not edit inline. */
export interface RiverConfig {
    activeAccount?: string | undefined;
    defaultReasoningEffort?: Record<string, string> | undefined;
    modelAccountRules?: {
        models: string[];
        account: string;
    }[] | undefined;
    /** Whether the settings navigation shows a dedicated river.ai page. */
    showSettingsSection?: boolean | undefined;
}
