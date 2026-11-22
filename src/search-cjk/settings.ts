/**
 * fork search v2 (11-20) — settings for the `cjk` search_context engine.
 *
 * Every field lives under `compress.search` (three-level merge, see
 * compress-settings.ts mergeCompress). Nothing here is read unless
 * `engine === "cjk"` (or, for `around`, the base config's `around === true`).
 * Bridge-specific formats (header lines, onebot envelopes, media tags, owner
 * ids) are NOT hard-coded: they come from config as regex sources, so the
 * defaults below are neutral and the companion deployment writes its own.
 */

export interface SearchV2Raw {
    engine?: "substring" | "cjk";
    around?: boolean;
    budget?: number;
    budgetByModel?: Record<string, number>;
    maxHits?: number;
    hubs?: string[];
    aliases?: string[][];
    headPatterns?: string[];
    envelopePattern?: string;
    mediaPattern?: string;
    dropPatterns?: string[];
    speakerAttr?: string;
    idAttr?: string;
    ownerIds?: string[];
    ownerName?: string;
    ownerLabels?: string[];
    selfName?: string;
    toolWeights?: Record<string, number>;
    laneWeights?: Record<string, number>;
    laneLabels?: Record<string, string>;
    includeReasoning?: boolean;
    includeSts?: boolean;
    promiseFlip?: boolean;
}

/** Resolved settings stamped on the session (only while engine = cjk). */
export interface SearchV2Settings {
    engine: "cjk";
    budget: number;
    maxHits: number;
    hubs: string[];
    aliases: string[][];
    headPatterns: string[];
    envelopePattern: string | null;
    mediaPattern: string | null;
    dropPatterns: string[];
    speakerAttr: string;
    idAttr: string;
    ownerIds: string[];
    ownerName: string;
    ownerLabels: string[];
    selfName: string;
    toolWeights: Record<string, number>;
    laneWeights: Record<string, number>;
    laneLabels: Record<string, string>;
    includeReasoning: boolean;
    includeSts: boolean;
    promiseFlip: boolean;
}

const SEARCH_V2_DEFAULT_BUDGET = 1000;
const SEARCH_V2_MIN_BUDGET = 300;
const SEARCH_V2_MAX_BUDGET = 4000;
const SEARCH_V2_DEFAULT_HITS = 5;
export const SEARCH_V2_MAX_HITS = 8;

/** Pronoun hubs every Chinese companion corpus is full of (neutral default;
 *  the deployment adds names such as the user's and the companion's). */
export const SEARCH_V2_DEFAULT_HUBS = ["我", "你", "他", "她", "它"];

/** Result weights per tool (results only). 0 / absent = not indexed.
 *  A trailing "*" matches a prefix. */
const SEARCH_V2_DEFAULT_TOOL_WEIGHTS: Record<string, number> = {
    "bili_*": 0.6,
    "web_search": 0.5,
    "web_fetch": 0.5,
    "read": 0.5,
    "mc": 0.4,
    "qq_history": 0.6,
    "her_note": 0.8,
    "her_diary": 0.8,
    "qzone_read": 0.8,
};

/** Default lane weights by channel (the part before the first ":"). */
const SEARCH_V2_DEFAULT_LANE_WEIGHTS: Record<string, number> = {
    mc: 0.4,
};

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : dflt;

const lastSeg = (s: string): string => {
    const i = s.lastIndexOf("/");
    return i === -1 ? s : s.slice(i + 1);
};

/** Budget for this model: exact key, then the part after the last "/" on
 *  either side (keys tried in sorted order — deterministic). */
export function budgetForModel(raw: SearchV2Raw | undefined, model: string | undefined): number {
    const base = clampInt(raw?.budget, SEARCH_V2_MIN_BUDGET, SEARCH_V2_MAX_BUDGET, SEARCH_V2_DEFAULT_BUDGET);
    const table = raw?.budgetByModel;
    if (!table || !model) return base;
    if (Object.prototype.hasOwnProperty.call(table, model)) return clampInt(table[model], SEARCH_V2_MIN_BUDGET, SEARCH_V2_MAX_BUDGET, base);
    const m = lastSeg(model).toLowerCase();
    for (const k of Object.keys(table).sort()) {
        if (lastSeg(k).toLowerCase() === m) return clampInt(table[k], SEARCH_V2_MIN_BUDGET, SEARCH_V2_MAX_BUDGET, base);
    }
    return base;
}

/** Full settings for engine = cjk from the merged raw block. */
export function resolveSearchV2Settings(raw: SearchV2Raw | undefined, model: string | undefined): SearchV2Settings {
    const r = raw ?? {};
    return {
        engine: "cjk",
        budget: budgetForModel(r, model),
        maxHits: clampInt(r.maxHits, 1, SEARCH_V2_MAX_HITS, SEARCH_V2_DEFAULT_HITS),
        hubs: Array.isArray(r.hubs) ? [...r.hubs] : [...SEARCH_V2_DEFAULT_HUBS],
        aliases: Array.isArray(r.aliases) ? r.aliases.map((g) => [...g]) : [],
        headPatterns: Array.isArray(r.headPatterns) ? [...r.headPatterns] : [],
        envelopePattern: typeof r.envelopePattern === "string" ? r.envelopePattern : null,
        mediaPattern: typeof r.mediaPattern === "string" ? r.mediaPattern : null,
        dropPatterns: Array.isArray(r.dropPatterns) ? [...r.dropPatterns] : [],
        speakerAttr: typeof r.speakerAttr === "string" ? r.speakerAttr : "nickname",
        idAttr: typeof r.idAttr === "string" ? r.idAttr : "id",
        ownerIds: Array.isArray(r.ownerIds) ? [...r.ownerIds] : [],
        ownerName: typeof r.ownerName === "string" && r.ownerName.trim() ? r.ownerName.trim() : "用户",
        ownerLabels: Array.isArray(r.ownerLabels) ? [...r.ownerLabels] : [],
        selfName: typeof r.selfName === "string" && r.selfName.trim() ? r.selfName.trim() : "你",
        toolWeights: { ...SEARCH_V2_DEFAULT_TOOL_WEIGHTS, ...(r.toolWeights ?? {}) },
        laneWeights: { ...SEARCH_V2_DEFAULT_LANE_WEIGHTS, ...(r.laneWeights ?? {}) },
        laneLabels: { ...(r.laneLabels ?? {}) },
        includeReasoning: r.includeReasoning === true,
        includeSts: r.includeSts === true,
        promiseFlip: r.promiseFlip === true,
    };
}

/** Cleaning-relevant fingerprint: a change rebuilds the corpus. */
export function corpusKeyOf(s: SearchV2Settings): string {
    return JSON.stringify([s.headPatterns, s.envelopePattern, s.mediaPattern, s.dropPatterns, s.speakerAttr, s.idAttr, s.ownerIds, s.ownerName, s.ownerLabels, s.selfName, s.toolWeights, s.laneWeights, s.laneLabels, s.includeReasoning, s.includeSts]);
}

/** Request-time check of a merged `compress.search` block (the file tier is
 *  read raw, only the settings page sanitizes on save): a v2 field with the
 *  wrong type or a regex that does not compile turns the v2 engine and
 *  `around` off for the request instead of failing later on every call. */
export function searchV2RawUsable(raw: unknown): raw is SearchV2Raw {
    return !!raw && typeof raw === "object" && !Array.isArray(raw) && sanitizeSearchV2Fields(raw as Record<string, unknown>, {});
}

/** The plugin lane's `around` gate: on only while the base block says so
 *  and the block is usable (see searchV2RawUsable). */
export function searchV2AroundOn(raw: unknown): raw is SearchV2Raw {
    return searchV2RawUsable(raw) && raw.around === true;
}

/** Validate one raw `compress.search` object's v2 fields; returns the
 *  cleaned copy or null when any field has the wrong type / a regex does not
 *  compile (the whole `search` block is then dropped, like planAware). */
export function sanitizeSearchV2Fields(co: Record<string, unknown>, out: Record<string, unknown>): boolean {
    let ok = true;
    const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? [...v] as string[] : null);
    const numRec = (v: unknown): Record<string, number> | null => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return null;
        const o: Record<string, number> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return null;
            o[k] = x;
        }
        return o;
    };
    const compiles = (src: string, flags: string): boolean => {
        try {
            new RegExp(src, flags);
            return true;
        } catch {
            return false;
        }
    };
    for (const key of ["engine", "around", "budget", "budgetByModel", "maxHits", "hubs", "aliases", "headPatterns", "envelopePattern", "mediaPattern", "dropPatterns", "speakerAttr", "idAttr", "ownerIds", "ownerName", "ownerLabels", "selfName", "toolWeights", "laneWeights", "laneLabels", "includeReasoning", "includeSts", "promiseFlip"] as const) {
        if (!(key in co)) continue;
        const v = co[key];
        switch (key) {
            case "engine":
                if (v !== "substring" && v !== "cjk") { ok = false; continue; }
                out[key] = v;
                break;
            case "around":
            case "includeReasoning":
            case "includeSts":
            case "promiseFlip":
                if (typeof v !== "boolean") { ok = false; continue; }
                out[key] = v;
                break;
            case "budget":
            case "maxHits":
                if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) { ok = false; continue; }
                out[key] = v;
                break;
            case "budgetByModel":
            case "toolWeights":
            case "laneWeights": {
                const r = numRec(v);
                if (!r) { ok = false; continue; }
                out[key] = r;
                break;
            }
            case "laneLabels": {
                if (!v || typeof v !== "object" || Array.isArray(v) || !Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")) { ok = false; continue; }
                out[key] = { ...(v as Record<string, string>) };
                break;
            }
            case "hubs":
            case "ownerIds":
            case "ownerLabels": {
                const a = strArr(v);
                if (!a) { ok = false; continue; }
                out[key] = a;
                break;
            }
            case "headPatterns":
            case "dropPatterns": {
                const a = strArr(v);
                if (!a || !a.every((p) => compiles(p, ""))) { ok = false; continue; }
                out[key] = a;
                break;
            }
            case "aliases": {
                if (!Array.isArray(v) || !v.every((g) => Array.isArray(g) && g.length >= 2 && g.every((x) => typeof x === "string" && x.trim().length > 0))) { ok = false; continue; }
                out[key] = (v as string[][]).map((g) => [...g]);
                break;
            }
            case "envelopePattern":
            case "mediaPattern":
                if (typeof v !== "string" || !compiles(v, "g")) { ok = false; continue; }
                out[key] = v;
                break;
            case "speakerAttr":
            case "idAttr":
            case "ownerName":
            case "selfName":
                if (typeof v !== "string" || v.trim().length === 0) { ok = false; continue; }
                out[key] = v;
                break;
        }
    }
    return ok;
}
