/**
 * fork（日期，S7 / D5）：翻旧话的工具结果里，给「下周三」「大后天」这类说法补「（=日期）」注记。
 *
 * 设计见 research1119/plan-1119/dates.md（第一、四、七节）和 PLAN.md 的 FK 包；规则全在 reldate.mjs（逐字节拷贝，
 * reldate-load.ts 核 sha）。这里只做三件事：开关、按每条原话找锚点（occurrence.ts）、把正文交给 reldate。
 *
 *  - 开关：顶层 `fish.dateNotes`（config.ts 的 parseFishSettings）。缺省全关；关着时 search_context、decompress
 *    的结果和没有这一包时逐字节相同（E0-golden / E0-wire 核）。reload、设置页保存、每份请求、每次插件工具调用都现读。
 *  - 只在工具执行时注记：search_context（cjk 引擎那一路的摘录、around）、decompress（整块：inline / 临时文件 / toFile）。
 *    不碰内核 render-refs 的 `time=`、不碰请求期现贴的字、不碰宿主落盘的消息（PLAN D13、dates.md 第五节第 8 条）。
 *  - 每条原话用它自己的锚点；说话人标签不进函数（只把正文交进去）。只标对话（她说的、别人发进来的话）：
 *    她的思考、工具回执、网页 / B 站 / 读过的文件、QQ 记录这类「别人写的东西」不标（那里的「明天」是写的人那天的明天）。
 *  - 拿不准就不标：没有锚点、区间跨日、半夜、引用 / 合并转发 / 旧说法块所在的行、被切开的长行（corpus 的 chunked 窗）。
 *  - 一个结果至少有一处注记时，结尾加一行图例（RELDATE_LEGEND）；toFile / 临时文件写在文件开头。
 *  - 上限：每个结果 maxPerResult（缺省 24）处，search 的每段摘录 maxPerSnippet（缺省 3）处。
 */

import type { CompressionBlock, CompressionState } from "acp-kernel";
import type { RowSource, Window } from "../search-cjk/corpus.js";
import { foldSameLength } from "../search-cjk/tokenize.js";
import { loadRelDate, relDateLoadState, relDateModule, type RelDateModule } from "./reldate-load.js";
import { openOccLookup, type OccExtReader, type OccTier, type OccWhen } from "./occurrence.js";
import type { RelDateAnchor } from "./reldate.mjs";
import { DATE_NOTES_DEFAULTS, type DateNotesSettings } from "./date-notes-settings.js";
import { occLedgerTotals } from "./occ-ledger.js";

let current: DateNotesSettings | undefined;

/** 现读的配置（opts.fish?.dateNotes）。开着就预载 reldate（幂等）。 */
export function setFishDateNotes(s: DateNotesSettings | undefined): void {
    current = s;
    if (s?.enabled) void loadRelDate();
}

/** 注记开没开（只看开关，不看模块载没载好）。 */
export function fishDateNotesWanted(): boolean {
    return current?.enabled === true;
}

/** 开着时等 reldate 载好（工具执行前调；关着时调用方不 await）。 */
export async function readyFishDateNotes(): Promise<void> {
    if (current?.enabled) await loadRelDate();
}

/** D4 的开关（和 enabled 无关：关着注记也可以先记）。 */
export function fishOccRecordOn(): boolean {
    return current?.recordOccurrence === true;
}

export function fishDateNotesTz(): number {
    return current?.tzOffsetMin ?? DATE_NOTES_DEFAULTS.tzOffsetMin;
}

// ---------------------------------------------------------------- counters

interface Counters {
    results: number;
    notedResults: number;
    hits: number;
    skip: Record<string, number>;
    tier: Record<OccTier | "none", number>;
    lines: { skippedKind: number; skippedShape: number; chunked: number; legacy: number };
}
const totals: Counters = { results: 0, notedResults: 0, hits: 0, skip: {}, tier: { A: 0, A2: 0, B: 0, none: 0 }, lines: { skippedKind: 0, skippedShape: 0, chunked: 0, legacy: 0 } };

/** health 的一段：开着时 { dateNotes }，关着时 {}（health 一个键都不多）。 */
export function fishDateNotesHealthField(): { dateNotes?: Record<string, unknown> } {
    const h = fishDateNotesHealth();
    return h ? { dateNotes: h } : {};
}

/** health 用：开着时才给（关着时 health 不多这个键）。 */
function fishDateNotesHealth(): Record<string, unknown> | undefined {
    if (!current?.enabled && !current?.recordOccurrence) return undefined;
    return { enabled: current.enabled, recordOccurrence: current.recordOccurrence, module: relDateLoadState(), ...JSON.parse(JSON.stringify(totals)) as Record<string, unknown>, occ: occLedgerTotals() };
}

// ---------------------------------------------------------------- shapes

/** 桥 / qq_history 拼的聊天记录行：「HH:MM 名字（回X）：正文」。名字段落算屏蔽区，正文按这一行的钟点钉。 */
const TIMED_RE = /^(\d{1,2}):(\d{2})[ \t]+[^\n：:]{1,60}[：:]/;
/** 带日期的记录行（「11-15 20:03 名字：」）：拿不准是哪一年哪一天，整行不标。 */
const DATED_RE = /^\s*\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\s+\d{1,2}:\d{2}/;
/** 引用、合并转发、旧桥的说法块：里面是别的时刻说的话（corpus 把换行合成了空格，结构认不出），整行不标。 */
const MIXED_RE = /\[引用|\[合并转发|这个群里大家常这么说/;
/** reldate 的注记写法（和 reldate.mjs 的 OWN_NOTE_SRC 同一个形状），给「标【】时别标进注记里」用。 */
const NOTE_SPAN_RE = /（=\d{4}(?:-\d{2}){0,2}(?: 周[一二三四五六日])?(?:~(?:\d{4}-)?\d{2}-\d{2})?(?: (?:月初|月底|年初|年底))?）/g;

/** 文字里注记占的区间。 */
function noteSpans(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    if (!text.includes("（=")) return out;
    NOTE_SPAN_RE.lastIndex = 0;
    for (const m of text.matchAll(NOTE_SPAN_RE)) out.push([m.index!, m.index! + m[0].length]);
    return out;
}

/**
 * 和 excerpt.ts 的 markFirst 一样（第一处用【】括起来），但按**去掉注记的原文**找第一处（G2 复核 F5）：
 *  - 查「2026」不会标进「（=2026-11-25）」；
 *  - 查「明天去」而注记插在中间（「明天（=2026-11-20 周五）去」）时照样认得出：【】只括住注记前面那一截（「【明天】（=…）去」）；
 *  - 第一处和原文里的第一处是同一处（不会因为第一处被注记隔开就标到后面那处）。
 */
export function markFirstOutside(text: string, needle: string): string {
    if (!needle) return text;
    const spans = noteSpans(text);
    if (spans.length === 0) {
        const at0 = foldSameLength(text).indexOf(needle);
        return at0 === -1 ? text : text.slice(0, at0) + "【" + text.slice(at0, at0 + needle.length) + "】" + text.slice(at0 + needle.length);
    }
    // 去掉注记的原文 + 每个字在 text 里的位置
    let plain = "";
    const pos: number[] = [];
    let at = 0;
    for (const [s0, e0] of spans) {
        for (let i = at; i < s0; i++) { plain += text[i]; pos.push(i); }
        at = e0;
    }
    for (let i = at; i < text.length; i++) { plain += text[i]; pos.push(i); }
    const hit = foldSameLength(plain).indexOf(needle);
    if (hit === -1) return text;
    const start = pos[hit]!;
    // 【】只括到第一处注记之前（不括进注记里）
    let end = pos[hit + needle.length - 1]! + 1;
    for (const [s0] of spans) if (s0 > start && s0 < end) { end = s0; break; }
    return text.slice(0, start) + "【" + text.slice(start, end) + "】" + text.slice(end);
}

/** 块摘要的锚点：块覆盖的消息第一次被看到的时刻（和 stream.ts 的 blockCoverageTimes 同一个算法；有一条没有章就不给）。 */
export function summaryAnchor(block: CompressionBlock, state: CompressionState): RelDateAnchor | null {
    const stamps = state.tsStamps;
    if (!stamps) return null;
    const ids = new Set<string>(block.effectiveMessageIds);
    const sr = block.startRef ? state.messageRefs.byRef[block.startRef] : undefined;
    const er = block.endRef ? state.messageRefs.byRef[block.endRef] : undefined;
    if (sr) ids.add(sr);
    if (er) ids.add(er);
    let lo: number | undefined;
    let hi: number | undefined;
    for (const id of ids) {
        const ts = stamps[id];
        if (typeof ts !== "number") return null;
        if (lo === undefined || ts < lo) lo = ts;
        if (hi === undefined || ts > hi) hi = ts;
    }
    return lo !== undefined && hi !== undefined ? { lo, hi } : null;
}

// ---------------------------------------------------------------- per-result noter

interface ResultNoter {
    /** 一段正文（不带说话人）加注记。win = [from, to) 时只插落在里面的（判断看整段）。回加好注记的那一段。 */
    body(text: string, when: OccWhen | null, opts?: { from?: number; to?: number; cap?: number; timed?: boolean }): { text: string; hits: number };
    /** 这个结果里一共插了几处。 */
    hits(): number;
    /** 有注记时的图例行，没有 = ""。调用方在结尾（或文件开头）加。 */
    legend(): string;
    whenOf(ref: number): OccWhen | null;
    /** 结果拼完时调一次（计数）。 */
    done(): void;
}

function pinLine(mod: RelDateModule, when: OccWhen, hh: number, mm: number, tz: number): RelDateAnchor | null {
    const a = when.anchor;
    if ("at" in a) {
        const p = mod.pinClock(a.at, hh, mm, tz, 360);
        return p === null ? null : { at: p };
    }
    const p1 = mod.pinClock(a.lo, hh, mm, tz, 360);
    const p2 = mod.pinClock(a.hi, hh, mm, tz, 360);
    return p1 !== null && p1 === p2 ? { at: p1 } : null;
}

/** 开一个结果的注记器。关着、模块没载好（或 sha 不对）、锚点源全没有 → null（调用方照旧路输出，一个字不变）。 */
export function openResultNoter(sessionId: string, state: CompressionState, rows: RowSource | null, ext: OccExtReader | null): ResultNoter | null {
    const s = current;
    if (!s?.enabled) return null;
    const mod = relDateModule();
    if (!mod) return null;
    const lookup = openOccLookup(sessionId, state, rows, ext);
    let used = 0;
    const max = s.maxPerResult;
    const tz = s.tzOffsetMin;
    const opts = { tzOffsetMin: tz, nightEndHour: s.nightEndHour };
    return {
        whenOf: (ref) => lookup.whenOf(ref),
        body(text, when, o = {}) {
            const from = o.from ?? 0;
            const to = o.to ?? text.length;
            const raw = text.slice(from, to);
            const left = Math.min(max - used, o.cap ?? max);
            if (left <= 0) return { text: raw, hits: 0 };
            if (!when) { totals.tier.none++; return { text: raw, hits: 0 }; }
            let anchor: RelDateAnchor | null = when.anchor;
            let bodyFrom = 0;
            if (o.timed) {
                const tm = TIMED_RE.exec(text);
                if (!tm) { totals.lines.skippedShape++; return { text: raw, hits: 0 }; }
                anchor = pinLine(mod, when, Number(tm[1]), Number(tm[2]), tz);
                bodyFrom = tm[0].length;
                if (!anchor) { totals.skip["no-anchor"] = (totals.skip["no-anchor"] ?? 0) + 1; return { text: raw, hits: 0 }; }
            }
            const ws = Math.max(from, bodyFrom);
            if (ws >= to) return { text: raw, hits: 0 };
            const body = text.slice(bodyFrom);
            const r = mod.annotateWindow(body, ws - bodyFrom, to - bodyFrom, anchor, { ...opts, maxHits: left });
            totals.tier[when.tier]++;
            for (const [k, v] of Object.entries(r.skips)) totals.skip[k] = (totals.skip[k] ?? 0) + v;
            const n = r.hits.filter((h) => h.start >= ws - bodyFrom && h.end <= to - bodyFrom).length;
            used += n;
            totals.hits += n;
            return { text: text.slice(from, ws) + r.text, hits: n };
        },
        hits: () => used,
        legend: () => (used > 0 ? mod.RELDATE_LEGEND : ""),
        done() {
            totals.results++;
            if (used > 0) totals.notedResults++;
        },
    };
}

/** 一行（corpus 的 Line / 窗里的一段）能不能标、怎么标。null = 不标。 */
export function lineShape(text: string, speaker: string): { timed: boolean } | null {
    if (MIXED_RE.test(text)) { totals.lines.skippedShape++; return null; }
    if (!speaker) {
        if (DATED_RE.test(text)) { totals.lines.skippedShape++; return null; }
        if (TIMED_RE.test(text)) return { timed: true };
    }
    return { timed: false };
}

// ---------------------------------------------------------------- search_context（cjk）

/** renderSearch 用的注记器（search-v2.ts 的 noteDates 缝）。 */
export interface SearchDateNoter {
    /** w.text 的 [from, to)（已经避开了代理对），每行用自己的锚点；只标 talk 窗。 */
    slice(w: Window, from: number, to: number, cap: number): { text: string; hits: number };
    /** 一整行（带「说话人：」）的前 len 个字，用 ref 的锚点。noDates（旧说法块的行）= 不标。 */
    line(w: Window | null, lineText: string, ref: number, speaker: string, len: number, cap: number, noDates?: boolean): { text: string; hits: number };
    /** 一段摘要（她写的块摘要）的 [from, to)，锚点是块覆盖的时间（summaries 开着才有）。 */
    summary(text: string, from: number, to: number, anchor: RelDateAnchor | null): string;
    maxPerSnippet: number;
    legend(): string;
    done(): void;
}

export function openSearchDateNoter(sessionId: string, state: CompressionState, rows: RowSource | null, ext: OccExtReader | null): SearchDateNoter | null {
    const n = openResultNoter(sessionId, state, rows, ext);
    const s = current;
    if (!n || !s) return null;
    const mod = relDateModule()!;
    let extra = 0;
    const lineNote = (lineText: string, ref: number, speaker: string, from: number, to: number, cap: number): { text: string; hits: number } => {
        const pre = speaker ? speaker.length + 1 : 0;
        const shape = lineShape(lineText.slice(pre), speaker);
        if (!shape) return { text: lineText.slice(from, to), hits: 0 };
        const ws = Math.max(from, pre);
        if (ws >= to) return { text: lineText.slice(from, to), hits: 0 };
        const r = n.body(lineText.slice(pre), n.whenOf(ref), { from: ws - pre, to: to - pre, cap, timed: shape.timed });
        return { text: lineText.slice(from, ws) + r.text, hits: r.hits };
    };
    return {
        maxPerSnippet: s.maxPerSnippet,
        slice(w, from, to, cap) {
            const raw = w.text.slice(from, to);
            if (w.kind !== "talk") { totals.lines.skippedKind++; return { text: raw, hits: 0 }; }
            if (w.chunked === true) { totals.lines.chunked++; return { text: raw, hits: 0 }; }
            let out = "";
            let cur = from;
            let hits = 0;
            for (const sp of w.spans) {
                if (sp.end <= from || sp.start >= to) continue;
                const a = Math.max(from, sp.start);
                const b = Math.min(to, sp.end);
                out += w.text.slice(cur, a);
                if (sp.noDates) { totals.lines.legacy++; out += w.text.slice(a, b); cur = b; continue; }
                const r = lineNote(w.text.slice(sp.start, sp.end), sp.ref, sp.speaker, a - sp.start, b - sp.start, cap - hits);
                out += r.text;
                hits += r.hits;
                cur = b;
            }
            out += w.text.slice(cur, to);
            return { text: out, hits };
        },
        line(w, lineText, ref, speaker, len, cap, noDates) {
            if (w && (w.kind !== "talk" || w.chunked === true)) return { text: lineText.slice(0, len), hits: 0 };
            if (noDates) { totals.lines.legacy++; return { text: lineText.slice(0, len), hits: 0 }; }
            return lineNote(lineText, ref, speaker, 0, len, cap);
        },
        summary(text, from, to, anchor) {
            if (!s.summaries || !anchor) return text.slice(from, to);
            const left = Math.min(s.maxPerResult - n.hits() - extra, s.maxPerSnippet);
            if (left <= 0) return text.slice(from, to);
            const r = mod.annotateWindow(text, from, to, anchor, { tzOffsetMin: s.tzOffsetMin, nightEndHour: s.nightEndHour, maxHits: left });
            const k = r.hits.filter((h) => h.start >= from && h.end <= to).length;
            extra += k;
            totals.hits += k;
            return r.text;
        },
        legend: () => (n.hits() + extra > 0 ? mod.RELDATE_LEGEND : ""),
        done: () => n.done(),
    };
}

// ---------------------------------------------------------------- decompress

/** 内核 formatMessage 的写法（kernel/src/decompress.ts）：`[role]\n正文` 或 `[role • tool]\n正文`。 */
function formatted(m: { role: string; contentType?: string; toolName?: string; text: string }): string {
    if (m.toolName && m.contentType !== "text") return `[${m.role} • ${m.toolName}]\n${m.text}`;
    return `[${m.role}]\n${m.text}`;
}

/** 一段的开头：全文开头或空行之后的 `[role]` / `[role • tool]`。 */
const PART_HEAD_RE = /(?:^|\n\n)(?=\[(?:user|assistant|tool|system)(?: • [^\]\n]{1,200})?\]\n)/g;
const LOOKAHEAD = 64;
/** 她说话的工具调用：参数里哪个字段是她的话（和 search 的 corpus CALL_TEXT 同一张表）。 */
const SPEECH_CALLS: Record<string, readonly string[]> = { im_send: ["text_zh_cn", "text"], her_note: ["text"], her_leave: ["text"] };

export interface CoveredMessage {
    ref: number;
    role: string;
    contentType?: string;
    toolName?: string;
    text: string;
}

function noteMessage(noter: ResultNoter, m: CoveredMessage): { text: string; hits: number } | null {
    if (m.contentType === "text" && (m.role === "user" || m.role === "assistant")) {
        const r = noter.body(m.text, noter.whenOf(m.ref));
        return r.hits > 0 ? r : null;
    }
    // 她用 im_send / her_note / her_leave 说的话：参数是 JSON，只改那个字段的值（整段交进去，引号会让 reldate 当成引文）
    if (m.role === "assistant" && m.contentType === "tool-call" && m.toolName && Object.prototype.hasOwnProperty.call(SPEECH_CALLS, m.toolName)) {
        let args: Record<string, unknown>;
        try {
            args = JSON.parse(m.text) as Record<string, unknown>;
        } catch {
            return null;
        }
        if (!args || typeof args !== "object") return null;
        for (const f of SPEECH_CALLS[m.toolName]!) {
            const v = args[f];
            if (typeof v !== "string" || !v.trim()) continue;
            const r = noter.body(v, noter.whenOf(m.ref));
            if (r.hits === 0) return null;
            const enc = JSON.stringify(v);
            const at = m.text.indexOf(enc);
            // 宿主的 JSON 写法和 JSON.stringify 不一样（转义了中文等）、或者出现不止一次：不改
            if (at === -1 || m.text.indexOf(enc, at + 1) !== -1) return null;
            return { text: m.text.slice(0, at) + JSON.stringify(r.text) + m.text.slice(at + enc.length), hits: r.hits };
        }
        return null;
    }
    return null;
}

/** 内核 render-refs 给 text 消息开头贴的标签（`<acp tokens=".." type="text">m00123</acp>`，time 属性可有可无）。 */
const ACP_TAG_RE = /^\x3cacp [^\x3e\n]*\btype="([^"\n]*)"[^\x3e\n]*\x3em0*(\d{1,9})\x3c\/acp\x3e\n?/;
const PART_HEADER_RE = /^\[(user|assistant|tool|system)(?: • ([^\]\n]{1,200}))?\]$/;

/**
 * decompress 整块的正文加注记。body 是缓存的（或现拼的）`[role]\n正文` 一段段用空行连起来的文字。
 * 每一段怎么认是哪条消息：
 *  1. 正文开头有内核贴的 ref 标签（type="text"）：就是那条 ref（她的对话、别人发进来的话），标签后面的正文按它的锚点标；
 *  2. 没有标签：和 covered（块覆盖范围里的消息，按 ref 升序，正文从统一库读）按顺序逐字对上了整段
 *     （前面是开头或空行，后面是结尾或空行），对上了、而且是对话（user / assistant 的 text，
 *     她用 im_send 等说的话）才标。
 * 对不上的不动（子块的摘要、她的思考、工具回执都原样）。回 { text, hits }；hits 为 0 时 text === body（逐字节）。
 */
export function noteDecompressBody(noter: ResultNoter, body: string, covered: readonly CoveredMessage[]): { text: string; hits: number } {
    if (body.length === 0) return { text: body, hits: 0 };
    const starts: number[] = [];
    PART_HEAD_RE.lastIndex = 0;
    for (const mm of body.matchAll(PART_HEAD_RE)) starts.push(mm.index! + mm[0].length);
    if (starts.length === 0) return { text: body, hits: 0 };
    const edits: Array<{ at: number; len: number; text: string }> = [];
    let hits = 0;
    let ci = 0; // covered 的游标
    let k = 0;
    while (k < starts.length) {
        const p = starts[k]!;
        const partEnd = k + 1 < starts.length ? starts[k + 1]! - 2 : body.length;
        const nl = body.indexOf("\n", p);
        const hm = nl === -1 ? null : PART_HEADER_RE.exec(body.slice(p, nl));
        if (!hm || nl >= partEnd) { k++; continue; }
        const role = hm[1]!;
        const tool = hm[2];
        const textStart = nl + 1;
        const tag = ACP_TAG_RE.exec(body.slice(textStart, Math.min(partEnd, textStart + 240)));
        if (tag) {
            const ref = Number(tag[2]);
            for (let c = ci; c < Math.min(covered.length, ci + LOOKAHEAD); c++) if (covered[c]!.ref === ref) { ci = c + 1; break; }
            if (!tool && tag[1] === "text" && (role === "user" || role === "assistant")) {
                const from = textStart + tag[0].length;
                const r = noter.body(body.slice(from, partEnd), noter.whenOf(ref));
                if (r.hits > 0) {
                    edits.push({ at: from, len: partEnd - from, text: r.text });
                    hits += r.hits;
                }
            }
            k++;
            continue;
        }
        let found = -1;
        let e = 0;
        for (let c = ci; c < Math.min(covered.length, ci + LOOKAHEAD); c++) {
            const f = formatted(covered[c]!);
            if (!body.startsWith(f, p)) continue;
            const end = p + f.length;
            if (end !== body.length && !body.startsWith("\n\n", end)) continue;
            found = c;
            e = end;
            break;
        }
        if (found === -1) { k++; continue; }
        ci = found + 1;
        const m = covered[found]!;
        const r = noteMessage(noter, m);
        if (r) {
            edits.push({ at: e - m.text.length, len: m.text.length, text: r.text });
            hits += r.hits;
        }
        // 正文里自己带「\n\n[user]\n」时，跳过落在这条里面的假段头
        k++;
        while (k < starts.length && starts[k]! < e) k++;
    }
    if (hits === 0) return { text: body, hits: 0 };
    let out = "";
    let last = 0;
    for (const ed of edits) {
        out += body.slice(last, ed.at) + ed.text;
        last = ed.at + ed.len;
    }
    return { text: out + body.slice(last), hits };
}

export interface DecompressRows {
    byRefRange(sessionId: string, lo: number, hi: number): Array<{ seq: number; refNum: number | null; role: string; kind: string; retired: boolean; content: string }> | null;
}

const MAX_DECOMPRESS_REF_SPAN = 20000;

/** 块覆盖的消息（ref 范围按块的 effectiveMessageIds 算），从统一库读正文。读不了 = null。 */
function coveredFromRows(sessionId: string, state: CompressionState, effectiveMessageIds: readonly string[], rows: DecompressRows | null): CoveredMessage[] | null {
    if (!rows) return null;
    const byRaw = state.messageRefs.byRaw;
    let lo = Infinity;
    let hi = -Infinity;
    for (const raw of effectiveMessageIds) {
        const ref = byRaw[raw];
        const mm = typeof ref === "string" ? /^m0*(\d+)$/.exec(ref) : null;
        if (!mm) continue;
        const n = Number(mm[1]);
        if (n < lo) lo = n;
        if (n > hi) hi = n;
    }
    if (!Number.isFinite(lo) || hi - lo > MAX_DECOMPRESS_REF_SPAN) return null;
    let got: ReturnType<DecompressRows["byRefRange"]>;
    try {
        got = rows.byRefRange(sessionId, lo, hi);
    } catch {
        return null;
    }
    if (!got) return null;
    const live = new Set<number>();
    for (const r of got) if (!r.retired && r.refNum !== null) live.add(r.refNum);
    const out: Array<CoveredMessage & { seq: number }> = [];
    for (const r of got) {
        if (r.refNum === null) continue;
        if (r.retired && live.has(r.refNum)) continue;
        let m: { role?: unknown; contentType?: unknown; toolName?: unknown; text?: unknown };
        try {
            m = JSON.parse(r.content) as typeof m;
        } catch {
            continue;
        }
        if (!m || typeof m !== "object") continue;
        out.push({
            seq: r.seq,
            ref: r.refNum,
            role: typeof m.role === "string" ? m.role : r.role,
            contentType: typeof m.contentType === "string" ? m.contentType : r.kind,
            ...(typeof m.toolName === "string" ? { toolName: m.toolName } : {}),
            text: typeof m.text === "string" ? m.text : "",
        });
    }
    out.sort((a, z) => a.ref - z.ref || a.seq - z.seq);
    return out.map(({ seq: _seq, ...rest }) => rest);
}

/**
 * resolveDecompress 用：整块正文加注记。关着、模块没好、读不到消息、一处都没标 → null（调用方照旧，一个字节不变）。
 */
export function noteDecompress(sessionId: string, state: CompressionState, effectiveMessageIds: readonly string[], body: string, rows: DecompressRows | null, ext: OccExtReader | null, occRows: RowSource | null): { body: string; legend: string } | null {
    if (!current?.enabled) return null;
    const noter = openResultNoter(sessionId, state, occRows, ext);
    if (!noter) return null;
    // 统一库读不到时只剩「带 ref 标签的段」那一种认法
    const covered = coveredFromRows(sessionId, state, effectiveMessageIds, rows) ?? [];
    const r = noteDecompressBody(noter, body, covered);
    const legend = noter.legend();
    noter.done();
    return r.hits > 0 ? { body: r.text, legend } : null;
}

/** 测试用。 */
export function _resetDateNotesForTest(): void {
    current = undefined;
    totals.results = 0;
    totals.notedResults = 0;
    totals.hits = 0;
    totals.skip = {};
    totals.tier = { A: 0, A2: 0, B: 0, none: 0 };
    totals.lines = { skippedKind: 0, skippedShape: 0, chunked: 0, legacy: 0 };
}
