/**
 * fork（日期，D3 + A / A2 的读法）：一条消息「真正发生在什么时候」—— 给相对日期注记当锚点。
 *
 * research1119/plan-1119/dates.md 2.2：fork 看不到 DSH 事件，只有自己的账本。`messages.ts` 和
 * `<acp time=…>` 不能用（56% 是批量入库值）；内核的 `state.tsStamps`（#4313 第一次看到的时刻）对别人发进来的话
 * 很准，对她的回复不准（回复要等下一次请求才第一次出现，章记成了下一条进来的时刻）。所以分三档，查的时候
 * A → A2 → B，谁先给出就用谁：
 *
 *  - A（以后往前记，旁路表，occ-ledger.ts 写）：`session_ext` 的 `fish:occ:YYYYMM`，值 `{ v:1, m:{ <msgId>: 毫秒 } }`。
 *    只在 `fish.dateNotes.recordOccurrence` 开着时才有。
 *  - A2（一次性回填，可选）：配置目录里的 `fish-occ-backfill.json`（tools/reldate-a2-pairing.mjs 在她 DSH 日志的
 *    拷贝上配出来的，只有 msgId → 毫秒）。没有这个文件就没有 A2。
 *  - B（从 tsStamps 夹区间，本文件的 bTierAnchors）：
 *      1. 不信重铸潮：按 ref 顺序连着 ≥ 17 条、章都在 30 毫秒以内的整段不信；另做「同一请求」检查：
 *         同一批章（30 毫秒以内连着的）里，assistant 只能在最前面那一小段，后面出现 assistant 的整批不信。
 *      2. 点：非 assistant 用自己的章；assistant 用紧挨在它前面那条非 assistant 的章（= 产出这段回复的那次请求）。
 *      3. 在这些点上求最长不降子序列（LNDS），不在上面的点不信（内容相同共用 id 的「早到的章」会被剔掉）。
 *      4. 区间：非 assistant 在 LNDS 上 → { at }；不在 → { lo: 前一个可信点, hi: 后一个可信点 }；
 *         assistant → { lo: 请求时刻, hi: min(请求时刻 + 20 分钟, 自己的章, 后一个可信点) }。
 *      5. lo、hi 不在同一个当地日子的，reldate 的 resolveAnchor 判 null（不标）。这一步在 reldate 里做。
 *    B 档只保证日子，不保证钟点（trusted = false）。
 *
 * 按 ref（m 编号）算，不按 seq：ref 是内核按第一次看到的顺序发的。只读，不写任何东西。
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CompressionState } from "acp-kernel";
import { configFile } from "../paths.js";
import type { RowSource } from "../search-cjk/corpus.js";

type OccAnchor = { at: number } | { lo: number; hi: number };
export type OccTier = "A" | "A2" | "B";
export interface OccWhen {
    anchor: OccAnchor;
    tier: OccTier;
    /** A / A2：钟点也可信；B 只保证日子。 */
    trusted: boolean;
}

export interface TimelineEntry {
    ref: number;
    asst: boolean;
    ts: number | null;
}

const WAVE_MS = 30;
const WAVE_MIN = 17;
const GEN_WINDOW_MS = 20 * 60 * 1000;

const mrefOf = (n: number): string => `m${String(n).padStart(5, "0")}`;

/** B 档。entries 必须按 ref 升序。回 ref → 锚点（没有锚点的不在表里）。纯函数。 */
export function bTierAnchors(entries: readonly TimelineEntry[]): Map<number, OccAnchor> {
    const n = entries.length;
    const out = new Map<number, OccAnchor>();
    if (n === 0) return out;
    const distrust = new Uint8Array(n);
    // 1. 重铸潮 + 同一请求：按「连着、章都在第一条的 30 毫秒以内」分批
    let i = 0;
    while (i < n) {
        const t0 = entries[i]!.ts;
        if (t0 === null) { i++; continue; }
        let j = i + 1;
        while (j < n) {
            const t = entries[j]!.ts;
            if (t === null || Math.abs(t - t0) > WAVE_MS) break;
            j++;
        }
        const len = j - i;
        let bad = len >= WAVE_MIN;
        if (!bad) {
            let seenOther = false;
            for (let k = i; k < j; k++) {
                if (!entries[k]!.asst) seenOther = true;
                else if (seenOther) { bad = true; break; }
            }
        }
        if (bad) for (let k = i; k < j; k++) distrust[k] = 1;
        i = j;
    }
    // 2. 点
    const point = new Array<number | null>(n).fill(null);
    let lastOther: number | null = null; // 最近一条非 assistant 的下标
    for (let k = 0; k < n; k++) {
        const e = entries[k]!;
        if (!e.asst) {
            if (e.ts !== null && !distrust[k]) point[k] = e.ts;
            lastOther = k;
        } else if (lastOther !== null && !distrust[k]) {
            const o = entries[lastOther]!;
            if (o.ts !== null && !distrust[lastOther]) point[k] = o.ts;
        }
    }
    // 3. LNDS（不降）：patience，tails 存下标，并列时取 upper bound
    const idx: number[] = [];
    for (let k = 0; k < n; k++) if (point[k] !== null) idx.push(k);
    const tails: number[] = []; // 下标进 idx
    const prev = new Int32Array(idx.length).fill(-1);
    for (let q = 0; q < idx.length; q++) {
        const v = point[idx[q]!]!;
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (point[idx[tails[mid]!]!]! <= v) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) prev[q] = tails[lo - 1]!;
        tails[lo] = q;
    }
    const onChain = new Uint8Array(n);
    if (tails.length > 0) {
        let q = tails[tails.length - 1]!;
        while (q >= 0) {
            onChain[idx[q]!] = 1;
            q = prev[q]!;
        }
    }
    // 前一个 / 后一个可信点
    const prevTrusted = new Array<number | null>(n).fill(null);
    const nextTrusted = new Array<number | null>(n).fill(null);
    let pv: number | null = null;
    for (let k = 0; k < n; k++) {
        prevTrusted[k] = pv;
        if (onChain[k]) pv = point[k]!;
    }
    let nv: number | null = null;
    for (let k = n - 1; k >= 0; k--) {
        nextTrusted[k] = nv;
        if (onChain[k]) nv = point[k]!;
    }
    // 4. 区间
    for (let k = 0; k < n; k++) {
        const e = entries[k]!;
        if (!e.asst) {
            if (onChain[k]) { out.set(e.ref, { at: point[k]! }); continue; }
            const lo = prevTrusted[k];
            const hi = nextTrusted[k];
            if (lo !== null && hi !== null && hi >= lo) out.set(e.ref, { lo, hi });
            continue;
        }
        const lo = onChain[k] ? point[k]! : prevTrusted[k];
        if (lo === null || lo === undefined) continue;
        let hi = lo + GEN_WINDOW_MS;
        if (e.ts !== null && !distrust[k] && e.ts < hi) hi = e.ts;
        const nx = nextTrusted[k];
        if (nx !== null && nx !== undefined && nx < hi) hi = nx;
        if (hi >= lo) out.set(e.ref, { lo, hi });
    }
    return out;
}

// ---------------------------------------------------------------- per-session cache

const ALL_KINDS = ["text", "reasoning", "tool-call", "tool-result"]; // 行的 kind = 内核的 contentType；只要 seq / ref / role，正文一律不读
const PAGE = 2000;

interface SessionTimeline {
    lastSeq: number;
    asstByRef: Map<number, boolean>;
    bKey: string;
    b: Map<number, OccAnchor>;
}
const timelines = new Map<string, SessionTimeline>();

/** 读会话的 ref → 是不是 assistant（只读 seq / ref / role，不读正文）；增量。null = 统一库不可用。 */
function refreshTimeline(sessionId: string, rows: RowSource): SessionTimeline | null {
    let tl = timelines.get(sessionId);
    if (!tl) tl = { lastSeq: 0, asstByRef: new Map(), bKey: "", b: new Map() };
    let after = tl.lastSeq;
    for (;;) {
        const page = rows.page(sessionId, after, PAGE, ALL_KINDS);
        if (page === null) return null;
        if (page.length === 0) break;
        for (const r of page) {
            after = Math.max(after, r.seq);
            if (r.refNum === null) continue;
            if (!tl.asstByRef.has(r.refNum) || !r.retired) tl.asstByRef.set(r.refNum, r.role === "assistant");
        }
        if (page.length < PAGE) break;
    }
    tl.lastSeq = after;
    timelines.set(sessionId, tl);
    return tl;
}

function bFor(tl: SessionTimeline, state: CompressionState): Map<number, OccAnchor> {
    const stamps = state.tsStamps ?? {};
    const byRef = state.messageRefs.byRef;
    const key = `${tl.lastSeq}:${tl.asstByRef.size}:${Object.keys(stamps).length}`;
    if (key === tl.bKey) return tl.b;
    const refs = [...tl.asstByRef.keys()].sort((a, z) => a - z);
    const entries: TimelineEntry[] = refs.map((ref) => {
        const raw = byRef[mrefOf(ref)];
        const ts = raw !== undefined ? stamps[raw] : undefined;
        return { ref, asst: tl.asstByRef.get(ref) === true, ts: typeof ts === "number" && Number.isFinite(ts) ? ts : null };
    });
    tl.b = bTierAnchors(entries);
    tl.bKey = key;
    return tl.b;
}

// ---------------------------------------------------------------- A / A2

export const OCC_EXT_PREFIX = "fish:occ:";

export interface OccExtReader {
    list(sessionId: string): Array<{ key: string; value: unknown; updatedAt: number }> | null;
}

/** A 档：把会话的 fish:occ:* 分片合成一张 msgId → 毫秒（值不是正数的不认）。同一条在两个月份键里都有
 *  （会话 state 被重置过、重新盖了章）时认早的那个：后盖的章只会更晚。 */
export function readOccShards(sessionId: string, ext: OccExtReader | null): Map<string, number> {
    const out = new Map<string, number>();
    if (!ext) return out;
    let rows: Array<{ key: string; value: unknown }> | null = null;
    try {
        rows = ext.list(sessionId);
    } catch {
        rows = null;
    }
    if (!rows) return out;
    for (const r of rows) {
        if (!r.key.startsWith(OCC_EXT_PREFIX)) continue;
        let v: unknown = r.value;
        if (typeof v === "string") {
            try { v = JSON.parse(v); } catch { continue; }
        }
        const m = (v as { v?: unknown; m?: unknown } | null)?.m;
        if (!m || typeof m !== "object" || (v as { v?: unknown }).v !== 1) continue;
        for (const [id, ms] of Object.entries(m as Record<string, unknown>)) {
            if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) continue;
            const had = out.get(id);
            if (had === undefined || ms < had) out.set(id, ms);
        }
    }
    return out;
}

let backfill: { file: string; mtimeMs: number; size: number; m: Map<string, number> } | null = null;

/** A2：配置目录里的 fish-occ-backfill.json（kind 'fish-occ-backfill'、v 1）。没有、读不懂 = 空表。 */
export function readBackfill(file = path.join(path.dirname(configFile()), "fish-occ-backfill.json")): Map<string, number> {
    let mtimeMs: number;
    let size: number;
    try {
        const st = statSync(file);
        mtimeMs = st.mtimeMs;
        size = st.size;
    } catch {
        backfill = null;
        return new Map();
    }
    // 修改时间的精度不够（同一毫秒里改两次）时，大小不同也算换过
    if (backfill && backfill.file === file && backfill.mtimeMs === mtimeMs && backfill.size === size) return backfill.m;
    const m = new Map<string, number>();
    try {
        const j = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; kind?: unknown; m?: unknown };
        if (j && j.v === 1 && j.kind === "fish-occ-backfill" && j.m && typeof j.m === "object") {
            for (const [id, ms] of Object.entries(j.m as Record<string, unknown>)) if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) m.set(id, ms);
        }
    } catch {
        // 读不懂 = 没有
    }
    backfill = { file, mtimeMs, size, m };
    return m;
}

interface OccLookup {
    whenOf(ref: number): OccWhen | null;
}

/** 一次工具调用里用的查表（A → A2 → B）。统一库不可用时只剩 A / A2。 */
export function openOccLookup(sessionId: string, state: CompressionState, rows: RowSource | null, ext: OccExtReader | null, backfillMap?: Map<string, number>): OccLookup {
    const a = readOccShards(sessionId, ext);
    const a2 = backfillMap ?? readBackfill();
    const tl = rows ? refreshTimeline(sessionId, rows) : null;
    const b = tl ? bFor(tl, state) : new Map<number, OccAnchor>();
    const byRef = state.messageRefs.byRef;
    return {
        whenOf(ref: number): OccWhen | null {
            const raw = byRef[mrefOf(ref)];
            if (raw !== undefined) {
                const va = a.get(raw);
                if (va !== undefined) return { anchor: { at: va }, tier: "A", trusted: true };
                const v2 = a2.get(raw);
                if (v2 !== undefined) return { anchor: { at: v2 }, tier: "A2", trusted: true };
            }
            const vb = b.get(ref);
            return vb ? { anchor: vb, tier: "B", trusted: false } : null;
        },
    };
}

/** 测试用。 */
export function _resetOccurrenceForTest(): void {
    timelines.clear();
    backfill = null;
}
