// fish-ledger P0: usage rows for the proxy's OWN model calls (lane "side" —
// nudge decision, preflight / threads / external summaries, cache keep-alive).
// Those calls never reach settleUsageReport, so their usage is read here from
// the response text each call site already holds (JSON body or SSE stream),
// with the same per-protocol arithmetic the main lanes use (util.usageTotals).
// Never throws; nothing is recorded when the ledger is off.

import { noteUsage, upstreamHostOf } from "./fish-ledger.js";
import { usageOutputTotal, usageTotals, type WireProtocol } from "./util.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** The usage objects one response carries, in arrival order. */
function usageObjectsOf(json: unknown): Obj[] {
    if (!isObj(json)) return [];
    const out: Obj[] = [];
    const message = json.message;
    if (isObj(message) && isObj(message.usage)) out.push(message.usage); // anthropic message_start
    const response = json.response;
    if (isObj(response) && isObj(response.usage)) out.push(response.usage); // responses completed
    if (isObj(json.usage)) out.push(json.usage); // anthropic/openai body, message_delta, openai chunk
    if (isObj(json.usageMetadata)) out.push(json.usageMetadata); // google
    return out;
}

/** Merge usage snapshots: a later positive (or first-seen) number wins, so a
 *  zero echo in a delta frame cannot erase the start frame's input sizes. */
function mergeUsage(objs: Obj[]): Obj | undefined {
    if (objs.length === 0) return undefined;
    const merged: Obj = {};
    for (const u of objs) {
        for (const [k, v] of Object.entries(u)) {
            if (typeof v === "number" && Number.isFinite(v)) {
                if (merged[k] === undefined || v > 0) merged[k] = v;
            } else if (isObj(v)) {
                merged[k] = { ...(isObj(merged[k]) ? merged[k] : {}), ...v };
            } else if (merged[k] === undefined) {
                merged[k] = v;
            }
        }
    }
    return merged;
}

/** Usage of one non-main response text (JSON or SSE). */
export function usageFromResponseText(protocol: WireProtocol, text: string): { total: number; cached: number | null; creation: number | null; output: number | null } | undefined {
    try {
        let objs: Obj[] = [];
        const trimmed = text.trimStart();
        if (trimmed.startsWith("{")) {
            objs = usageObjectsOf(JSON.parse(trimmed));
        } else {
            for (const line of text.split(/\r?\n/)) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (payload === "" || payload === "[DONE]") continue;
                try {
                    objs.push(...usageObjectsOf(JSON.parse(payload)));
                } catch {
                    // not JSON — skip the frame
                }
            }
        }
        const usage = mergeUsage(objs);
        if (usage === undefined) return undefined;
        const t = usageTotals(protocol, usage);
        if (t.total === undefined) return undefined;
        const out = usageOutputTotal(protocol, usage);
        return { total: t.total, cached: t.cached ?? null, creation: t.creation ?? null, output: out ?? null };
    } catch {
        return undefined;
    }
}

/** One provider-usage row (lane "side") for a side call's response text. */
export function noteSideUsage(a: { protocol: WireProtocol | undefined; text: string | undefined; sid?: string; upstreamUrl?: string; model?: string }): void {
    try {
        if (a.protocol === undefined || typeof a.text !== "string") return;
        const u = usageFromResponseText(a.protocol, a.text);
        if (u === undefined) return;
        noteUsage({ lane: "side", sid: a.sid, model: a.model, protocol: a.protocol, upstreamHost: upstreamHostOf(a.upstreamUrl), total: u.total, cached: u.cached, creation: u.creation, output: u.output });
    } catch {
        // bookkeeping only
    }
}
