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
export declare const REMOTE_NAMESPACE = "river";
/** Cordis service key the Gateway resolves the Remote receiver by. */
export declare const REMOTE_SERVICE = "riverAccounts";
/** Package id stamped on every descriptor. */
export declare const REMOTE_PACKAGE = "@mars-sea/dsh-river-provider";
/** One account as the settings page shows it. */
export interface AccountView {
    /** Stable slot id (`default`, or the env var name). */
    id: string;
    /** Human label. */
    label: string;
    /** Credential reference this slot reads. */
    ref: string;
    /** Whether a key currently resolves for it. */
    configured: boolean;
    /** Whether this is the account a request would use right now. */
    active: boolean;
    /** `ready`, `cooldown`, `disabled` or `unconfigured`. */
    status: 'ready' | 'cooldown' | 'disabled' | 'unconfigured';
    /** Why it is not usable; empty when ready. */
    reason: string;
    /** Epoch ms the cooldown ends; 0 when not cooling down. */
    cooldownUntil: number;
}
/** One model as the page's model editor shows it. */
export interface ModelView {
    id: string;
    name: string;
    contextWindow: number;
    maxOutputTokens: number;
    vision: boolean;
    /** Effort ids the model accepts, already harness vocabulary. */
    efforts: string[];
    /** The effort a turn gets when nobody asks for one. */
    defaultEffort: string;
    /** Whether the picker currently shows it. */
    visible: boolean;
    /** USD per million tokens, from the price book. */
    price: {
        input: number;
        cachedInput: number;
        output: number;
    };
}
/** The whole page state, in one round trip. */
export interface RiverSnapshot {
    provider: string;
    apiBase: string;
    accounts: AccountView[];
    models: ModelView[];
    /** Configured defaults, as the form shows them. */
    defaults: {
        /** `''` when the setting is absent. */
        contextWindowLimit: number;
        maxOutputTokens: number;
        activeAccount: string;
        defaultReasoningEffort: Record<string, string>;
    };
    /** Models a routing rule pins to an account. */
    modelAccountRules: {
        models: string[];
        account: string;
    }[];
    /** Client-surface switches, read-only from the page's point of view. */
    ui: {
        /** Whether the settings navigation shows a dedicated river.ai page. */
        showSettingsSection: boolean;
    };
}
/** The settings-page write verbs. */
export type RiverEdit = {
    field: 'apiBase';
    value: string;
} | {
    field: 'apiKeyEnv';
    value: string;
} | {
    field: 'activeAccount';
    value: string;
} | {
    field: 'contextWindowLimit';
    value: number;
} | {
    field: 'maxOutputTokens';
    value: number;
} | {
    field: 'defaultReasoningEffort';
    value: Record<string, string>;
} | {
    field: 'modelVisibility';
    value: Record<string, boolean>;
} | {
    field: 'visibleModels';
    value: string[];
} | {
    field: 'accounts';
    value: {
        label?: string;
        apiKeyEnv?: string;
        apiKey?: string;
    }[];
} | {
    field: 'modelAccountRules';
    value: {
        models: string[];
        account: string;
    }[];
} | {
    field: 'showSettingsSection';
    value: boolean;
};
/** Result of a write: the new state, or the reason it was refused. */
export interface EditOutcome {
    ok: boolean;
    /** Populated when `ok`: the state after the write. */
    snapshot?: RiverSnapshot;
    /** Populated when not `ok`. */
    error?: string;
}
/** Result of a key write for one account. */
export interface CredentialOutcome {
    ok: boolean;
    error?: string;
}
/** One invocation descriptor, as both faces spell it. */
export interface RemoteDescriptor {
    readonly id: string;
    readonly service: string;
    readonly namespace: string;
    readonly method: string;
    readonly invocation: {
        readonly kind: 'direct';
    };
    readonly parameters: readonly unknown[];
    readonly result: {
        readonly mode: 'strict';
        readonly typeSymbol: string;
        readonly create: () => {
            parse(value: unknown): unknown;
        };
    };
}
/** Build one direct descriptor: `river/<method>`, result validated by `parse`. */
export declare function makeDescriptor(endpoint: string, method: string, typeSymbol: string, parse: (value: unknown) => unknown): RemoteDescriptor;
/**
 * A descriptor that takes exactly one JSON argument.
 *
 * `wire` is the field name inside the wire `args` object; the Client calls
 * `namespace.method(value)` and the carrier sends `{ [wire]: value }`.
 */
export declare function makeUnaryDescriptor(endpoint: string, method: string, typeSymbol: string, wire: string, parseResult: (value: unknown) => unknown, parseInput?: (value: unknown) => unknown): RemoteDescriptor;
/** Parse the untrusted `river/state` result. */
export declare function parseSnapshot(value: unknown): RiverSnapshot;
/** Parse the untrusted `river/edit` result. */
export declare function parseEditOutcome(value: unknown): EditOutcome;
/** Parse the untrusted `river/setAccountKey` result. */
export declare function parseCredentialOutcome(value: unknown): CredentialOutcome;
/** Parse the untrusted `river/edit` argument. */
export declare function parseEdit(value: unknown): RiverEdit;
/** Every endpoint path, so a rename cannot drift between the faces. */
export declare const ENDPOINTS: {
    readonly state: "river/state";
    readonly refresh: "river/refresh";
    readonly edit: "river/edit";
    readonly setAccountKey: "river/setAccountKey";
};
/** The descriptor set both faces share. */
export declare function remoteDescriptors(): RemoteDescriptor[];
