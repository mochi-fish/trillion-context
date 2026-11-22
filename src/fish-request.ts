// Local evidence ledger (fish-ledger P0): the request-id channel shared by the
// DSH-side plugin (dsh-native) and the proxy. A host-side ledger writer tags
// every llm/stream request object with a request id ("rid") in a process-wide
// WeakMap; dsh-native copies it onto the loopback hop as one header, the proxy
// records it next to the egress hash and strips it before the model endpoint
// (server/headers.ts UPSTREAM_HOP_HEADERS). Pure host<->proxy bookkeeping: the
// header never reaches an upstream and nothing here changes a request body.
//
// Names and formats follow the ledger interface spec (INTERFACES.md §3.1,
// §5): keep them byte-identical with ledger-core.mjs.

export const FISH_REQUEST_HEADER = "x-bili-plugin-fish-request";
export const FISH_REQUEST_CAPABILITY = "fish-request-header";
const FISH_RID_RE = /^fq-[0-9a-z]{1,16}-[0-9a-z]{1,16}-[1-9][0-9]{0,11}$/;

export const FISH_SYM = Object.freeze({
    /** WeakMap<request object, rid> — written by the host-side ledger writer only. */
    requestIds: Symbol.for("fish-ledger/request-ids"),
    /** dsh-native's client-side counters (INTERFACES §5.8). */
    clientStats: Symbol.for("fish-ledger/client-stats"),
    /** Map<lock path, { instance, closed }> shared by every writer in a process. */
    liveWriters: Symbol.for("fish-ledger/live-writers"),
    /** Test hooks, honoured only when FISH_LEDGER_TEST=1 (INTERFACES §12). */
    test: Symbol.for("fish-ledger/test"),
});

/** Validate one header / WeakMap value. `undefined` = absent, `null` = present
 *  but malformed (repeated header, wrong shape, non-ASCII …), string = usable. */
export function fishRequestIdOf(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return null;
    return FISH_RID_RE.test(value) ? value : null;
}

interface FishClientStats {
    v: 1;
    seen: number;
    tagged: number;
    noCapability: number;
    bad: number;
    notOk: number;
    stripped: number;
}

/** dsh-native's counters live on globalThis so the host-side writer can copy
 *  them into its status without importing this bundle (INTERFACES §5.8). */
export function fishClientStats(): FishClientStats {
    const g = globalThis as Record<PropertyKey, unknown>;
    let s = g[FISH_SYM.clientStats] as FishClientStats | undefined;
    if (s === null || typeof s !== "object") {
        s = { v: 1, seen: 0, tagged: 0, noCapability: 0, bad: 0, notOk: 0, stripped: 0 };
        g[FISH_SYM.clientStats] = s;
    }
    return s;
}

export function bumpFishClientStat(key: Exclude<keyof FishClientStats, "v">): void {
    try {
        const s = fishClientStats();
        s[key] = (typeof s[key] === "number" ? s[key] : 0) + 1;
    } catch {
        // counters only — never break a request
    }
}

/** The rid the host-side writer attached to this llm/stream request object. */
export function fishRequestIdForRequest(options: unknown): string | null | undefined {
    try {
        if (options === null || typeof options !== "object") return undefined;
        const map = (globalThis as Record<PropertyKey, unknown>)[FISH_SYM.requestIds];
        if (!(map instanceof WeakMap)) return undefined;
        return fishRequestIdOf(map.get(options));
    } catch {
        return undefined;
    }
}

/** Remove the request-id header from a header bag that was computed for a
 *  different origin (a recovered proxy that may not strip it). Returns the bag
 *  unchanged when it carries no such header. */
export function withoutFishRequestHeader(extra: Record<string, string>): { extra: Record<string, string>; stripped: boolean } {
    let found = false;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra)) {
        if (k.toLowerCase() === FISH_REQUEST_HEADER) {
            found = true;
            continue;
        }
        out[k] = v;
    }
    return found ? { extra: out, stripped: true } : { extra, stripped: false };
}
