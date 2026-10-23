/**
 * The Host half of the settings page Remote.
 *
 * The Gateway discovers a Remote Service in "source mode": it walks every live
 * Cordis service, reads the `typertRemote` binding for the wire namespace, and
 * takes the methods marked with the `@Remote` decorator. That is the whole
 * contract — no descriptor registration, no schema artifacts — which is why the
 * methods below are plain async methods with one JSON argument each.
 *
 * Every method answers with the SAME shape the page parses
 * ({@link RiverSnapshot}), built by one builder, so the page cannot render a
 * field the Host never sends.
 *
 * @module dsh-river-provider/remote-service
 */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { type CredentialOutcome, type EditOutcome, type RiverEdit, type RiverSnapshot } from './remote-wire.ts';
/** What the receiver delegates to; the plugin owns every one of these. */
export interface RiverRemoteDeps {
    /** Assemble the current page state. */
    snapshot: () => Promise<RiverSnapshot>;
    /** Apply one settings write and answer with the state after it. */
    edit: (edit: RiverEdit) => Promise<EditOutcome>;
    /** Store one literal key for an account slot. */
    setAccountKey: (target: {
        ref: string;
        key: string;
    }) => Promise<CredentialOutcome>;
    /** Drop cached catalog/price data and rebuild. */
    refresh: () => Promise<RiverSnapshot>;
}
/**
 * The Remote receiver.
 *
 * Constructing it registers the Cordis service under {@link REMOTE_SERVICE},
 * which is the lifetime the markers live for: dispose the fiber and the Gateway
 * stops claiming the endpoints.
 */
export declare class RiverRemoteService extends TypertRemoteService {
    private readonly deps;
    constructor(ctx: Context, deps: RiverRemoteDeps);
    /** The whole settings page, in one round trip. */
    state(): Promise<RiverSnapshot>;
    /** Re-read the live price table, then answer the state. */
    refresh(): Promise<RiverSnapshot>;
    /** Apply one settings write. */
    edit(edit: RiverEdit): Promise<EditOutcome>;
    /** Store one account's key. */
    setAccountKey(target: {
        ref: string;
        key: string;
    }): Promise<CredentialOutcome>;
}
