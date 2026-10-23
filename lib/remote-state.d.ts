/**
 * The settings page's data source, on the Host.
 *
 * The browser never calls river.ai: a page that did would need the raw key in
 * the browser and would leak a 401/429 policy into the Client. Everything the
 * page renders is assembled here from the same objects the adapter uses, so what
 * the form shows and what a request does cannot disagree.
 *
 * @module dsh-river-provider/remote-state
 */
import type { AccountSlot, RiverAccountPool } from './accounts.ts';
import type { RiverConfig } from './remote-types.ts';
import type { RiverSnapshot } from './remote-wire.ts';
/** What the snapshot builder needs from the plugin. */
export interface SnapshotDeps {
    provider: string;
    config: () => RiverConfig;
    defaults: () => {
        apiBase: string;
        contextWindowLimit: number;
        maxOutputTokens: number;
        showSettingsSection: boolean;
    };
    pool: RiverAccountPool;
    slots: () => readonly AccountSlot[];
    isVisible: (model: string) => boolean;
    /** Whether a key currently resolves for one reference. */
    isConfigured: (ref: string) => Promise<boolean>;
}
/**
 * Assemble the page snapshot.
 *
 * `activeId` is resolved from the pool rather than recomputed here: the pool is
 * the only thing that knows which account a request would take right now, and a
 * second implementation of that rule would eventually pick a different one.
 */
export declare function buildSnapshot(deps: SnapshotDeps): Promise<RiverSnapshot>;
