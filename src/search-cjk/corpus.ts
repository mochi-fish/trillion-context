/**
 * fork search v2 (11-20) — the search corpus: folded messages from the
 * session's stored rows (the unified message ledger), classified, cleaned,
 * cut into per-lane windows and indexed.
 *
 *  - Scope: rows whose ref is covered by some block (folded / out of view),
 *    each attached to the LOWEST-tier block covering it.
 *  - Kept: user text (header / envelope / media cleaned, speaker resolved),
 *    the assistant's visible text, im_send text, her_note / her_leave text,
 *    and tool results whose tool has a weight (B站 / web / read / MC /
 *    qq_history …). Dropped: reasoning (unless includeReasoning), system
 *    rows, every other tool call/result (acp_*, compress, read_image, shell,
 *    edits…), sts (unless includeSts).
 *  - Retired rows are used only for refs that have no live row (a model
 *    switch re-mints rows; the old generation is a duplicate).
 *  - Windows: 800 chars, the next window repeats ~120 chars (at least the
 *    last whole line) of the previous; never across a block or a lane.
 *  - Built lazily, in pages, yielding to the event loop (setImmediate) so a
 *    10M-char corpus never blocks the proxy; grown incrementally when new
 *    blocks only ADD coverage, rebuilt when coverage shrinks or the
 *    cleaning settings change. In memory only — nothing is written.
 */

import type { CompressionBlock, CompressionState } from "acp-kernel";
import { GramIndex } from "./gram-index.js";
import { safeSlice } from "./excerpt.js";
import { corpusKeyOf, type SearchV2Settings } from "./settings.js";
import { foldSameLength } from "./tokenize.js";
import type { SearchRow } from "../storage/store.js";

const WINDOW_CHARS = 800;
const WINDOW_OVERLAP = 120;
const PAGE_ROWS = 250;
const SLICE_MS = 20;
/** Display name of the lane her own visible text and header-less user
 *  messages (wakes, notices) share: not a chat anyone else reads. */
const SELF_LANE_LABEL = "你自己这边";

type LaneKind = "talk" | "exp" | "others";

export interface Line {
    ref: number;
    speaker: string;
    text: string;
    /** fork（日期，G2 复核 F1）：旧桥「这个群里大家常这么说（…）：」那一行和它下面连着的「- …」行（别的时刻说的话），日期注记整行跳过。 */
    noDates?: true;
}

export interface CorpusMessage {
    ref: number;
    seq: number;
    lane: string;
    laneLabel: string;
    kind: LaneKind;
    weight: number;
    lines: Line[];
    live: boolean;
    /** "user" = a user text row, "self" = her visible assistant text. */
    origin?: "user" | "self";
}

/** A header lane without a chat id where the owner types into her session
 *  directly (the desk): her visible text right after it is what the owner
 *  reads there, so it joins that lane. */
export interface FollowLane {
    lane: string;
    laneLabel: string;
}

export interface Window {
    id: number;
    blockId: string;
    lane: string;
    laneLabel: string;
    kind: LaneKind;
    weight: number;
    text: string;
    lower: string;
    /** Line spans inside `text` (start offset, ref, speaker label). */
    spans: Array<{ start: number; end: number; ref: number; speaker: string; noDates?: true }>;
    refFirst: number;
    refLast: number;
    /** fork（日期，D5）：一条超长的行被切成几段时，每段都带 true（只看到半句话，日期注记跳过它）。 */
    chunked?: true;
}

export interface RowSource {
    /** `skipKinds`: row kinds whose content is not needed (bytes may be left out). */
    page(sessionId: string, afterSeq: number, limit: number, skipKinds?: readonly string[]): SearchRow[] | null;
    byRefRange(sessionId: string, lo: number, hi: number): SearchRow[] | null;
}

export interface Corpus {
    sessionId: string;
    key: string;
    blockSig: Map<string, string>;
    lastSeq: number;
    coverage: Map<number, string>;
    pending: Map<number, CorpusMessage>;
    consumed: Set<number>;
    /** Refs that have at least one live (not retired) row: a retired row
     *  for such a ref is an old generation and never enters the corpus. */
    liveRefs: Set<number>;
    laneLabelByKey: Map<string, string>;
    index: GramIndex;
    windows: Window[];
    summary: { sig: string; index: GramIndex; blockIds: string[]; texts: string[]; lowers: string[] };
    chars: number;
    builtMs: number;
    /** Desk lane her next visible text joins (carried across grows). */
    follow: FollowLane | null;
    /** Covered refs whose rows were read and never enter the corpus
     *  (reasoning, receipts): not collected again on every grow. */
    dropped: Set<number>;
    /** Refs that have had at least one row read. */
    seenRefs: Set<number>;
    /** Cheap fingerprint of the block list (fast path: nothing changed). */
    fastSig: string;
}

// ---------------------------------------------------------------- cleaning

const PATH_RE = /(?:\\\\\?\\[^\s"'<>|，。、）)\]】]*|[A-Za-z]:[\\/][^\s"'<>|，。、）)\]】]*|\/(?:[a-z]\/)?(?:Users|home)\/[^\s"'<>|，。、）)\]】]*)/g;
const TAG_RE = /<\/?[A-Za-z][\w:.-]*(?:\s[^<>\n]*)?\/?>/g;
const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;
const WS_RE = /\s+/g;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

interface Compiled {
    heads: RegExp[];
    envelope: RegExp | null;
    media: RegExp | null;
    drops: RegExp[];
    ownerIds: Set<string>;
    ownerLabels: Set<string>;
}

export function compileSettings(s: SearchV2Settings): Compiled {
    const safe = (src: string, flags: string): RegExp | null => {
        try {
            return new RegExp(src, flags);
        } catch {
            return null;
        }
    };
    return {
        heads: s.headPatterns.map((p) => safe(p, "")).filter((r): r is RegExp => r !== null),
        envelope: s.envelopePattern ? safe(s.envelopePattern, "g") : null,
        media: s.mediaPattern ? safe(s.mediaPattern, "g") : null,
        drops: s.dropPatterns.map((p) => safe(p, "")).filter((r): r is RegExp => r !== null),
        ownerIds: new Set(s.ownerIds),
        ownerLabels: new Set(s.ownerLabels),
    };
}

function mediaLabel(kind: string | undefined): string {
    if (!kind) return "[图]";
    if (kind.includes("表情")) return "[表情]";
    if (kind.includes("图")) return "[图]";
    return `[${kind}]`;
}

/** Model-visible text hygiene shared by every kept line: media tags →
 *  short labels (no paths), local paths → [路径], XML-like tags removed,
 *  control chars dropped, whitespace collapsed. */
export function scrubText(text: string, c: Compiled): string {
    let t = text;
    if (c.media) t = t.replace(c.media, (_m, kind: string | undefined) => mediaLabel(typeof kind === "string" ? kind : undefined));
    t = t.replace(PATH_RE, "[路径]");
    t = t.replace(TAG_RE, " ");
    t = t.replace(CTRL_RE, "");
    return t.replace(WS_RE, " ").trim();
}

function cleanName(s: string): string {
    const t = s.replace(CTRL_RE, "").replace(TAG_RE, "").replace(WS_RE, " ").trim();
    if (t.length <= 20) return t;
    // a long label that ends in a parenthetical keeps its last clause
    // (「Claude（帮主人打理插件的那个 AI，不是主人）」→「Claude（…不是主人）」)
    const pm = /^([^（(]+)[（(]([^（）()]*)[）)]$/.exec(t);
    if (pm) {
        const tail = (pm[2]!.split(/[，,、;；]/).pop() ?? "").trim();
        if (tail.length > 0 && tail.length <= 10) return `${safeSlice(pm[1]!.trim(), 0, 12)}（…${tail}）`;
    }
    return `${safeSlice(t, 0, 20)}…`;
}

/** Display name of a header label: long digit runs (ids) removed, empty
 *  brackets dropped, at most the first two " · " segments, and the second
 *  only while it is short (a name, not a reason sentence). */
function laneDisplay(label: string): string {
    const segs = label.split(" · ").map((x) => x.replace(/\d{5,}/g, "").replace(/[（(]\s*[）)]/g, "").replace(WS_RE, " ").trim()).filter(Boolean);
    if (segs.length === 0) return "聊天";
    const parts = [segs[0]!];
    if (segs.length > 1 && segs[1]!.length <= 12 && !/[，,。]/.test(segs[1]!)) parts.push(segs[1]!);
    return cleanName(parts.join(" · "));
}

const TOOL_LANE_LABEL: Array<[RegExp, string]> = [
    [/^bili_/, "B站"],
    [/^web_/, "网页"],
    [/^read$/, "读过的文件"],
    [/^mc$/, "MC"],
    [/^qq_history$/, "QQ 记录（别人的话）"],
    [/^her_note$/, "便条"],
    [/^her_diary$/, "日记"],
    [/^qzone_read$/, "QQ 空间"],
    [/^sts$/, "尖塔"],
];

function toolLaneLabel(tool: string): string {
    for (const [re, l] of TOOL_LANE_LABEL) if (re.test(tool)) return l;
    return cleanName(tool);
}

function weightOf(table: Record<string, number>, key: string): number {
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key]!;
    let best: { len: number; w: number } | null = null;
    for (const [k, w] of Object.entries(table)) {
        if (!k.endsWith("*")) continue;
        const p = k.slice(0, k.length - 1);
        if (key.startsWith(p) && (!best || p.length > best.len)) best = { len: p.length, w };
    }
    return best ? best.w : 0;
}

/** Speaker label for an envelope (id / nickname attrs). */
function envelopeSpeaker(attrs: Record<string, string>, s: SearchV2Settings, c: Compiled, headerOwner: boolean): string {
    const id = attrs[s.idAttr];
    const nick = cleanName(attrs[s.speakerAttr] ?? "");
    const owner = c.ownerIds.size > 0 ? (id !== undefined && c.ownerIds.has(id)) : headerOwner;
    if (owner) return s.ownerName;
    if (!nick) return "某人";
    if (nick === s.ownerName || nick.endsWith(`（${s.ownerName}）`) || nick.endsWith(`(${s.ownerName})`)) return `${nick}（不是${s.ownerName}）`;
    return nick;
}

interface ParsedMessage {
    role?: string;
    contentType?: string;
    text?: string;
    toolName?: string;
}

const CALL_TEXT: Record<string, { fields: string[]; weight: number; tag?: string; laneFrom?: string }> = {
    im_send: { fields: ["text_zh_cn", "text"], weight: 1, laneFrom: "chat" },
    her_note: { fields: ["text"], weight: 0.8, tag: "便条" },
    her_leave: { fields: ["text"], weight: 0.8, tag: "留言" },
};

/**
 * Classify + clean one stored row. Returns null when the row is not part of
 * the corpus. `laneLabels` learns the display label of each header lane.
 */
export function classifyRow(row: SearchRow, s: SearchV2Settings, c: Compiled, laneLabels: Map<string, string>): CorpusMessage | null {
    if (row.refNum === null) return null;
    let m: ParsedMessage;
    try {
        m = JSON.parse(row.content) as ParsedMessage;
    } catch {
        return null;
    }
    if (!m || typeof m !== "object") return null;
    const text = typeof m.text === "string" ? m.text : "";
    const base = { ref: row.refNum, seq: row.seq, live: !row.retired };
    const role = m.role ?? row.role;
    const kind = m.contentType ?? row.kind;
    if (role === "user" && kind === "text") {
        const u = classifyUser(text, base, s, c, laneLabels);
        if (u) u.origin = "user";
        return u;
    }
    if (role === "assistant" && kind === "text") {
        const t = scrubText(text, c);
        if (!t) return null;
        return { ...base, lane: "main", laneLabel: SELF_LANE_LABEL, kind: "talk", weight: 1, lines: [{ ref: base.ref, speaker: s.selfName, text: t }], origin: "self" };
    }
    if (role === "assistant" && kind === "reasoning") {
        if (!s.includeReasoning) return null;
        const t = scrubText(text, c);
        if (!t) return null;
        return { ...base, lane: "main", laneLabel: SELF_LANE_LABEL, kind: "talk", weight: 0.3, lines: [{ ref: base.ref, speaker: `${s.selfName}（心里想）`, text: t }] };
    }
    if (role === "assistant" && kind === "tool-call") {
        const tool = typeof m.toolName === "string" ? m.toolName : "";
        const spec = CALL_TEXT[tool];
        if (!spec) return null;
        const w = Object.prototype.hasOwnProperty.call(s.toolWeights, `call:${tool}`) ? s.toolWeights[`call:${tool}`]! : spec.weight;
        if (!(w > 0)) return null;
        let args: Record<string, unknown>;
        try {
            args = JSON.parse(text) as Record<string, unknown>;
        } catch {
            return null;
        }
        if (!args || typeof args !== "object") return null;
        let body = "";
        for (const f of spec.fields) if (typeof args[f] === "string" && (args[f] as string).trim()) { body = args[f] as string; break; }
        const t = scrubText(body, c);
        if (!t) return null;
        let lane = "main";
        let laneLabel = SELF_LANE_LABEL;
        if (spec.laneFrom && typeof args[spec.laneFrom] === "string") {
            lane = (args[spec.laneFrom] as string).trim() || "main";
            laneLabel = configuredLabel(s, lane, null) ?? laneLabels.get(lane) ?? channelLabel(lane);
            if (lane === "main") laneLabel = SELF_LANE_LABEL;
        }
        const ch = lane.split(":")[0] ?? "";
        if (ch === "sts" && !s.includeSts) return null;
        const speaker = spec.tag ? `${s.selfName}（${spec.tag}）` : s.selfName;
        return { ...base, lane, laneLabel, kind: "talk", weight: w, lines: [{ ref: base.ref, speaker, text: t }] };
    }
    if (role === "tool" && kind === "tool-result") {
        const tool = typeof m.toolName === "string" ? m.toolName : "";
        let w = weightOf(s.toolWeights, tool);
        if (tool === "sts") w = s.includeSts ? (w > 0 ? w : 0.3) : 0;
        if (!(w > 0)) return null;
        // a chat log (qq_history and the like) keeps one line per message
        const lines: Line[] = [];
        pushPlain(lines, base.ref, text, c);
        if (lines.length === 0) return null;
        return { ...base, lane: `tool:${tool}`, laneLabel: toolLaneLabel(tool), kind: tool === "qq_history" ? "others" : "exp", weight: w, lines };
    }
    return null;
}

/** Display label fixed by config: exact lane key, exact header label, then
 *  the longest key ending in ":" that prefixes the lane ("qq:group:"). A
 *  prefix label may carry "{id}": the rest of the lane key (letters, digits,
 *  _ and -, at most 20) — "QQ 群 {id}" tells two groups apart. */
function configuredLabel(s: SearchV2Settings, lane: string, label: string | null): string | null {
    const t = s.laneLabels;
    if (Object.prototype.hasOwnProperty.call(t, lane)) return t[lane]!;
    if (label !== null && Object.prototype.hasOwnProperty.call(t, label)) return t[label]!;
    let best: string | null = null;
    for (const k of Object.keys(t)) if (k.endsWith(":") && lane.startsWith(k) && (best === null || k.length > best.length)) best = k;
    if (best === null) return null;
    const v = t[best]!;
    if (!v.includes("{id}")) return v;
    const id = lane.slice(best.length);
    return /^[A-Za-z0-9_-]{1,20}$/.test(id) ? v.split("{id}").join(id) : v.split("{id}").join("").replace(WS_RE, " ").trim();
}

function channelLabel(lane: string): string {
    const [ch, sub] = lane.split(":");
    if (ch === "qq" && sub === "private") return "QQ 私聊";
    if (ch === "qq" && sub === "group") return "QQ 群";
    if (ch === "desk") return "桌面";
    return cleanName(ch ?? "聊天");
}

function classifyUser(raw: string, base: { ref: number; seq: number; live: boolean }, s: SearchV2Settings, c: Compiled, laneLabels: Map<string, string>): CorpusMessage | null {
    for (const d of c.drops) if (d.test(raw)) return null;
    let body = raw;
    let lane = "main";
    let label: string | null = null;
    for (const h of c.heads) {
        const m = h.exec(body);
        if (!m || m.index !== 0) continue;
        const g = m.groups ?? {};
        label = typeof g.label === "string" ? g.label.trim() : null;
        if (typeof g.lane === "string" && g.lane.trim()) lane = g.lane.trim();
        else if (label) lane = `label:${label}`;
        body = body.slice(m[0].length);
        break;
    }
    const ch = lane.split(":")[0] ?? "";
    if (ch === "sts" && !s.includeSts) return null;
    const headerOwner = label !== null && c.ownerLabels.has(label);
    const fixed = configuredLabel(s, lane, label);
    let laneLabel = fixed ?? (label ? laneDisplay(label) : lane === "main" ? SELF_LANE_LABEL : channelLabel(lane));
    if (label && !laneLabels.has(lane)) laneLabels.set(lane, laneLabel);
    if (lane === "main") laneLabel = SELF_LANE_LABEL;
    const weight = weightOf(s.laneWeights, ch) || 1;
    const lines: Line[] = [];
    if (c.envelope) {
        c.envelope.lastIndex = 0;
        let last = 0;
        let found = false;
        for (const em of body.matchAll(c.envelope)) {
            found = true;
            // onebot's lead-in before each envelope ([21:55] / [20:03 昵称(号)·成员][@我]
            // / [受限用户:仅问答]) is markup, not words: it never becomes a line
            const before = body.slice(last, em.index).replace(LEAD_IN_RE, " ");
            pushPlain(lines, base.ref, before, c);
            const attrs: Record<string, string> = {};
            const attrSrc = em.groups?.attrs ?? em[1] ?? "";
            for (const am of attrSrc.matchAll(ATTR_RE)) attrs[am[1]!] = am[2]!;
            const inner = em.groups?.text ?? em[2] ?? "";
            const t = scrubText(inner, c);
            if (t) lines.push({ ref: base.ref, speaker: envelopeSpeaker(attrs, s, c, headerOwner), text: t });
            last = (em.index ?? 0) + em[0].length;
        }
        if (found) pushPlain(lines, base.ref, body.slice(last), c);
        if (!found) {
            const speaker = headerOwner || (label === null && lane === "main" && c.heads.length === 0) ? s.ownerName : "";
            if (speaker) {
                const t = scrubText(body, c);
                if (t) lines.push({ ref: base.ref, speaker, text: t });
            } else pushPlain(lines, base.ref, body, c);
        }
    } else if (headerOwner) {
        const t = scrubText(body, c);
        if (t) lines.push({ ref: base.ref, speaker: s.ownerName, text: t });
    } else pushPlain(lines, base.ref, body, c);
    if (lines.length === 0) return null;
    return { ...base, lane, laneLabel, kind: "talk", weight, lines };
}

/** onebot lead-in markers in front of an envelope. */
const LEAD_IN_RE = /\[(?:\d{1,2}:\d{2}(?:[ \t][^\]\n]{0,80})?|@我|受限用户[:：][^\]\n]{0,20})\]/g;
/** A chat-log line: `HH:MM 谁：…`, optionally after a date (`11-15 20:03 `). */
const TIMED_LINE_RE = /^\s*(?:\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\s+)?\d{1,2}:\d{2}(?::\d{2})?\s/;
/** 旧桥（第 17 条，10-30 到 11-04）贴在群消息前面的说法块的抬头；和 reldate.mjs 的 LEGACY_EXPR 同一句。 */
const LEGACY_HEAD = "这个群里大家常这么说（看着用，不用照搬）：";

/** Speaker-less text: one line, or — for a pasted chat log such as the
 *  bridge's recent-group block (two or more "HH:MM 谁：话" lines) — one line
 *  per original line, so the log is not run together. */
function pushPlain(lines: Line[], ref: number, raw: string, c: Compiled): void {
    const parts = raw.split(/\r?\n/);
    let timed = 0;
    for (const p of parts) if (TIMED_LINE_RE.test(p)) timed++;
    if (timed >= 2) {
        // 旧说法块：抬头那一行和下面连着的「- 」行打上 noDates（和 reldate structure() 的 inLegacy 一样认法），注记跳过
        let inLegacy = false;
        for (const p of parts) {
            const t = scrubText(p, c);
            let legacy = false;
            if (inLegacy && p.startsWith("- ")) legacy = true;
            else {
                inLegacy = p.trim() === LEGACY_HEAD;
                legacy = inLegacy;
            }
            if (t) lines.push(legacy ? { ref, speaker: "", text: t, noDates: true } : { ref, speaker: "", text: t });
        }
        return;
    }
    const t = scrubText(raw, c);
    if (t) lines.push({ ref, speaker: "", text: t });
}

/** Desk follow-up (see FollowLane): call once per row, in seq order. */
export function applyFollow(h: { follow: FollowLane | null }, msg: CorpusMessage | null, ownerLabels: ReadonlySet<string>): void {
    if (!msg) return;
    if (msg.origin === "user") {
        h.follow = msg.lane.startsWith("label:") && ownerLabels.has(msg.lane.slice(6)) ? { lane: msg.lane, laneLabel: msg.laneLabel } : null;
        return;
    }
    if (msg.origin === "self" && msg.lane === "main" && h.follow) {
        msg.lane = h.follow.lane;
        msg.laneLabel = h.follow.laneLabel;
    }
}

// ---------------------------------------------------------------- windows

function lineText(l: Line): string {
    return l.speaker ? `${l.speaker}：${l.text}` : l.text;
}

function makeWindow(id: number, blockId: string, msg0: CorpusMessage, lines: Line[]): Window {
    let text = "";
    const spans: Window["spans"] = [];
    let refFirst = Infinity;
    let refLast = -Infinity;
    for (const l of lines) {
        if (text.length > 0) text += "\n";
        const start = text.length;
        text += lineText(l);
        spans.push(l.noDates ? { start, end: text.length, ref: l.ref, speaker: l.speaker, noDates: true } : { start, end: text.length, ref: l.ref, speaker: l.speaker });
        refFirst = Math.min(refFirst, l.ref);
        refLast = Math.max(refLast, l.ref);
    }
    return { id, blockId, lane: msg0.lane, laneLabel: msg0.laneLabel, kind: msg0.kind, weight: msg0.weight, text, lower: foldSameLength(text), spans, refFirst, refLast };
}

/** Cut one lane's message sequence (one block) into windows. */
export function cutWindows(blockId: string, msgs: CorpusMessage[], nextId: () => number): Window[] {
    const out: Window[] = [];
    if (msgs.length === 0) return out;
    const head = msgs[0]!;
    // a long single line is chunked on its own (800 / 120)
    const flat: Line[] = [];
    for (const m of msgs) for (const l of m.lines) flat.push(l);
    let cur: Line[] = [];
    let curLen = 0;
    let fresh = 0; // lines in `cur` not yet emitted in an earlier window
    const flush = (): void => {
        if (cur.length === 0 || fresh === 0) return;
        out.push(makeWindow(nextId(), blockId, head, cur));
        // carry: the last line, plus earlier lines while the carry stays <= overlap
        const carry: Line[] = [];
        let cl = 0;
        for (let i = cur.length - 1; i >= 0; i--) {
            const len = lineText(cur[i]!).length + 1;
            if (carry.length > 0 && cl + len > WINDOW_OVERLAP) break;
            carry.unshift(cur[i]!);
            cl += len;
        }
        if (carry.length === cur.length) {
            cur = [];
            curLen = 0;
        } else {
            cur = carry;
            curLen = cl;
        }
        fresh = 0;
    };
    for (const l of flat) {
        const len = lineText(l).length + 1;
        if (len > WINDOW_CHARS) {
            flush();
            cur = [];
            curLen = 0;
            fresh = 0;
            const prefix = l.speaker ? `${l.speaker}：` : "";
            const body = l.text;
            const step = WINDOW_CHARS - WINDOW_OVERLAP;
            for (let at = 0; at < body.length; at += step) {
                let s0 = at;
                let e0 = Math.min(body.length, at + WINDOW_CHARS - prefix.length);
                if (s0 > 0 && s0 < body.length) { const c = body.charCodeAt(s0); if (c >= 0xdc00 && c <= 0xdfff) s0++; }
                if (e0 > 0 && e0 < body.length) { const c = body.charCodeAt(e0 - 1); if (c >= 0xd800 && c <= 0xdbff) e0--; }
                const piece = makeWindow(nextId(), blockId, head, [{ ref: l.ref, speaker: l.speaker, text: body.slice(s0, e0) }]);
                piece.chunked = true;
                out.push(piece);
                if (e0 >= body.length) break;
            }
            continue;
        }
        if (curLen + len > WINDOW_CHARS && fresh > 0) flush();
        cur.push(l);
        curLen += len;
        fresh++;
    }
    flush();
    return out;
}

// ---------------------------------------------------------------- build

const corpora = new Map<string, Corpus>();
const building = new Map<string, Promise<Corpus | null>>();
const MAX_RESIDENT = 2;
/** Resident cap in indexed chars: past it only the corpus just used stays
 *  (memory follows distinct grams, ~65 MB per 2.85M chars of her chat). */
const MAX_RESIDENT_CHARS = 12_000_000;
/** Windows indexed between event-loop checks inside one block. */
const WINDOWS_PER_CHECK = 8;

/** Drop every resident corpus (tests / memory release). */
export function clearSearchCorpora(): void {
    corpora.clear();
    building.clear();
}

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

function refNumOf(ref: string | undefined): number | null {
    if (typeof ref !== "string") return null;
    const m = /^m0*(\d+)$/.exec(ref);
    return m ? Number(m[1]) : null;
}

/** ref → blockId of the lowest-tier block covering it (ties: first block). */
function coverageOf(state: CompressionState): Map<number, string> {
    const byRaw = state.messageRefs?.byRaw ?? {};
    const best = new Map<number, { tier: number; blockId: string }>();
    for (const b of state.blocks) {
        const tier = b.tier ?? 1;
        for (const raw of b.effectiveMessageIds ?? []) {
            const n = refNumOf(byRaw[raw]);
            if (n === null) continue;
            const cur = best.get(n);
            if (!cur || tier < cur.tier) best.set(n, { tier, blockId: b.blockId });
        }
    }
    const out = new Map<number, string>();
    for (const [n, v] of best) out.set(n, v.blockId);
    return out;
}

/**
 * fork（G2 终审 I1）：refs in [lo, hi] that some block covers (same source as
 * coverageOf: every block's effectiveMessageIds through messageRefs.byRaw).
 * `around` shows a retired row only when its ref is in here — what a
 * decompress of that block reaches; a retired row no block covers (an older
 * generation the session dropped) is never shown.
 */
export function coveredRefsIn(state: CompressionState, lo: number, hi: number): Set<number> {
    const byRaw = state.messageRefs?.byRaw ?? {};
    const out = new Set<number>();
    for (const b of state.blocks) {
        for (const raw of b.effectiveMessageIds ?? []) {
            const n = refNumOf(byRaw[raw]);
            if (n !== null && n >= lo && n <= hi) out.add(n);
        }
    }
    return out;
}

/** O(blocks) fingerprint: id, tier, id count and the first / last ids. */
function fastSigOf(state: CompressionState): string {
    const parts: string[] = [];
    for (const b of state.blocks) {
        const ids = b.effectiveMessageIds ?? [];
        parts.push(`${b.blockId}:${b.tier ?? 1}:${ids.length}:${ids[0] ?? ""}:${ids[ids.length - 1] ?? ""}:${(b.summary ?? "").length}`);
    }
    return parts.join("|");
}

function blockSigOf(state: CompressionState): Map<string, string> {
    const m = new Map<string, string>();
    for (const b of state.blocks) m.set(b.blockId, `${b.tier ?? 1}:${(b.effectiveMessageIds ?? []).length}`);
    return m;
}

function summaryText(b: CompressionBlock): string {
    return `${b.topic ?? ""} ${b.summary ?? ""}`;
}

function mergeInto(map: Map<number, CorpusMessage>, msg: CorpusMessage): void {
    const prev = map.get(msg.ref);
    if (!prev) { map.set(msg.ref, msg); return; }
    if (prev.live && !msg.live) return;
    if (!prev.live && msg.live) { map.set(msg.ref, msg); return; }
    // same generation, several cores for one ref: append distinct lines
    for (const l of msg.lines) if (!prev.lines.some((p) => p.text === l.text && p.speaker === l.speaker)) prev.lines.push(l);
}

interface EnsureOpts {
    rows: RowSource;
    log?: (msg: string) => void;
}

/**
 * The session's corpus, built or grown to match `state`. Null when the row
 * source is unavailable (no unified store) — the caller keeps the old path.
 */
export async function ensureCorpus(sessionId: string, state: CompressionState, s: SearchV2Settings, opts: EnsureOpts): Promise<Corpus | null> {
    // one build / grow per session at a time: every caller chains after the
    // previous one (two callers awaiting the same in-flight build must not
    // both grow the resident corpus); a failed grow drops the corpus so the
    // next call rebuilds from scratch instead of growing a half-updated one
    const prev = building.get(sessionId);
    const p = (prev ? prev.catch(() => null) : Promise.resolve(null)).then(() =>
        buildOrGrow(sessionId, state, s, opts).catch((err: unknown) => {
            corpora.delete(sessionId);
            throw err;
        }),
    );
    building.set(sessionId, p);
    try {
        return await p;
    } finally {
        if (building.get(sessionId) === p) building.delete(sessionId);
    }
}

async function buildOrGrow(sessionId: string, state: CompressionState, s: SearchV2Settings, opts: EnsureOpts): Promise<Corpus | null> {
    const t0 = Date.now();
    const key = corpusKeyOf(s);
    const fastSig = fastSigOf(state);
    let cp = corpora.get(sessionId);
    // fast path: same settings, same blocks, no new rows → nothing to do
    // (skips the O(covered refs) coverage walk on every search)
    if (cp && cp.key === key && cp.fastSig === fastSig) {
        const next = opts.rows.page(sessionId, cp.lastSeq, 1, s.includeReasoning ? [] : ["reasoning"]);
        if (next === null) return null;
        if (next.length === 0) {
            corpora.delete(sessionId);
            corpora.set(sessionId, cp);
            return cp;
        }
    }
    const sig = blockSigOf(state);
    const coverage = coverageOf(state);
    let rebuild = !cp || cp.key !== key;
    if (cp && !rebuild) {
        for (const [id, v] of cp.blockSig) if (sig.get(id) !== v) { rebuild = true; break; }
        if (!rebuild) for (const [n, b] of cp.coverage) if (coverage.get(n) !== b) { rebuild = true; break; }
    }
    if (rebuild) {
        // let the old corpus go before the new one is built: two full
        // indexes of one session never sit on the heap together
        corpora.delete(sessionId);
        cp = undefined;
        cp = {
            sessionId, key, blockSig: new Map(), lastSeq: -1, coverage: new Map(), pending: new Map(), consumed: new Set(), liveRefs: new Set(),
            laneLabelByKey: new Map(), index: new GramIndex(), windows: [],
            summary: { sig: "", index: new GramIndex(), blockIds: [], texts: [], lowers: [] }, chars: 0, builtMs: 0,
            follow: null, dropped: new Set(), seenRefs: new Set(), fastSig: "",
        };
    }
    const c = cp!;
    const compiled = compileSettings(s);
    // 1. read new rows
    let sliceStart = Date.now();
    let read = 0;
    for (;;) {
        const page = opts.rows.page(sessionId, c.lastSeq, PAGE_ROWS, s.includeReasoning ? [] : ["reasoning"]);
        if (page === null) return null;
        if (page.length === 0) break;
        for (const row of page) {
            c.lastSeq = Math.max(c.lastSeq, row.seq);
            read++;
            if (row.refNum === null || c.consumed.has(row.refNum)) continue;
            c.seenRefs.add(row.refNum);
            if (!row.retired && !c.liveRefs.has(row.refNum)) {
                c.liveRefs.add(row.refNum);
                const prev = c.pending.get(row.refNum);
                if (prev && !prev.live) c.pending.delete(row.refNum);
            }
            if (row.retired && c.liveRefs.has(row.refNum)) continue;
            const msg = classifyRow(row, s, compiled, c.laneLabelByKey);
            applyFollow(c, msg, compiled.ownerLabels);
            if (!msg) continue;
            c.dropped.delete(row.refNum);
            mergeInto(c.pending, msg);
        }
        if (page.length < PAGE_ROWS) break;
        if (Date.now() - sliceStart > SLICE_MS) { await yieldNow(); sliceStart = Date.now(); }
    }
    // 2. consume newly covered refs, block by block (state order)
    const newBlocks: string[] = [];
    for (const b of state.blocks) if (!c.blockSig.has(b.blockId)) newBlocks.push(b.blockId);
    const refsByBlock = new Map<string, number[]>();
    for (const [n, bid] of coverage) {
        if (c.coverage.has(n) || c.dropped.has(n)) continue;
        let a = refsByBlock.get(bid);
        if (!a) { a = []; refsByBlock.set(bid, a); }
        a.push(n);
    }
    let nextWindow = c.windows.length;
    const nextId = (): number => nextWindow++;
    let added = 0;
    const blockIndex = new Map<string, number>();
    state.blocks.forEach((b, i) => { if (!blockIndex.has(b.blockId)) blockIndex.set(b.blockId, i); });
    const blockOrder = [...refsByBlock.keys()].sort((x, y) => (blockIndex.get(x) ?? 0) - (blockIndex.get(y) ?? 0));
    for (const bid of blockOrder) {
        const refs = refsByBlock.get(bid)!.sort((a, b) => a - b);
        const byLane = new Map<string, CorpusMessage[]>();
        for (const n of refs) {
            // a covered ref whose row has not been read yet (store write
            // still on its way) stays uncovered: a later grow picks it up
            const msg = c.pending.get(n);
            if (!msg) {
                // read and judged (reasoning, a receipt): never collect it again
                if (c.seenRefs.has(n)) c.dropped.add(n);
                continue;
            }
            c.coverage.set(n, bid);
            c.pending.delete(n);
            c.consumed.add(n);
            // im_send lanes learn their label late (header seen after the call)
            if (msg.lane !== "main" && !msg.lane.startsWith("tool:") && configuredLabel(s, msg.lane, null) === null) {
                const l = c.laneLabelByKey.get(msg.lane);
                if (l) msg.laneLabel = l;
            }
            let a = byLane.get(msg.lane);
            if (!a) { a = []; byLane.set(msg.lane, a); }
            a.push(msg);
        }
        for (const lane of [...byLane.keys()].sort()) {
            const msgs = byLane.get(lane)!.sort((a, b) => a.ref - b.ref || a.seq - b.seq);
            const ws = cutWindows(bid, msgs, nextId);
            for (let k = 0; k < ws.length; k++) {
                const w = ws[k]!;
                const id = c.index.add(w.lower);
                if (id !== w.id) throw new Error("search corpus: window id drift");
                c.windows.push(w);
                c.chars += w.text.length;
                added++;
                // one huge block must not hold the event loop either
                if (k % WINDOWS_PER_CHECK === WINDOWS_PER_CHECK - 1 && Date.now() - sliceStart > SLICE_MS) { await yieldNow(); sliceStart = Date.now(); }
            }
        }
        if (Date.now() - sliceStart > SLICE_MS) { await yieldNow(); sliceStart = Date.now(); }
    }
    for (const [id, v] of sig) c.blockSig.set(id, v);
    // 3. summary path (cheap; rebuilt whenever blocks change)
    const sumSig = [...sig.entries()].map(([k, v]) => `${k}=${v}`).join("|") + `#${state.blocks.map((b) => (b.summary ?? "").length).join(",")}`;
    if (c.summary.sig !== sumSig) {
        const index = new GramIndex();
        const blockIds: string[] = [];
        const texts: string[] = [];
        const lowers: string[] = [];
        for (const b of state.blocks) {
            const t = scrubText(summaryText(b), compiled);
            blockIds.push(b.blockId);
            texts.push(t);
            const lw = foldSameLength(t);
            lowers.push(lw);
            index.add(lw);
            if (Date.now() - sliceStart > SLICE_MS) { await yieldNow(); sliceStart = Date.now(); }
        }
        c.summary = { sig: sumSig, index, blockIds, texts, lowers };
    }
    c.builtMs += Date.now() - t0;
    c.fastSig = fastSig;
    corpora.delete(sessionId);
    corpora.set(sessionId, c);
    let residentChars = 0;
    for (const x of corpora.values()) residentChars += x.chars;
    while (corpora.size > MAX_RESIDENT || (corpora.size > 1 && residentChars > MAX_RESIDENT_CHARS)) {
        const k = corpora.keys().next().value as string;
        residentChars -= corpora.get(k)!.chars;
        corpora.delete(k);
    }
    opts.log?.(`[search-v2] ${rebuild ? "build" : "grow"} rows=${read} windows+${added} total=${c.windows.length} chars=${c.chars} ms=${Date.now() - t0}`);
    return c;
}
