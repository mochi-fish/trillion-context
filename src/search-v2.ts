/**
 * fork search v2 (11-20) — the `cjk` search_context engine and the `around`
 * continuation (research1119/plan-1119/search.md §4, S1–S4 + S6).
 *
 * Two corpora, one query: (1) the original words of folded messages (the
 * search corpus, src/search-cjk/corpus.ts) and (2) the block summaries the
 * model wrote. Both are scored with CJK unigram+bigram BM25; a window must
 * pass an evidence gate to be listed at all, so "nothing found" stays a real
 * answer. The result is deterministic Chinese text: excerpts share a fixed
 * char budget (per-model, `budget` / `budgetByModel`), each excerpt is a
 * small slice around the matched words with who said it.
 *
 * Gating: engine = cjk is read from the per-request stamp
 * (session.metadata.searchV2, written by handle.ts only while the merged
 * config says engine = "cjk"); `around` follows the BASE config's
 * compress.search.around (same rule as the manifest, #1712), independent of
 * the engine. Anything this module cannot serve (no unified store, a foreign
 * session id, an internal error) returns null and the caller runs the old
 * substring path unchanged.
 */

import type { CompressionState } from "acp-kernel";
import type { Session } from "./session.js";
import { getStore } from "./persist.js";
import { toolFail, toolOk, type ProxyToolResult } from "./proxy-tool-result.js";
import { applyFollow, classifyRow, compileSettings, coveredRefsIn, ensureCorpus, scrubText, type Corpus, type CorpusMessage, type FollowLane, type RowSource, type Window } from "./search-cjk/corpus.js";
import { allocateExcerptBudget, bestSpan, findHits, markFirst, naturalSpan, safeSlice, type SpanHit } from "./search-cjk/excerpt.js";
import type { GramIndex, QueryGroup } from "./search-cjk/gram-index.js";
import { resolveSearchV2Settings, SEARCH_V2_MAX_HITS, type SearchV2Raw, type SearchV2Settings } from "./search-cjk/settings.js";
import { bigramSet, foldSameLength, isCjkCode, jaccard, queryUnits, type GramKey } from "./search-cjk/tokenize.js";
import { fishDateNotesWanted, markFirstOutside, openSearchDateNoter, readyFishDateNotes, summaryAnchor, type SearchDateNoter } from "./fish/date-notes.js";
import type { OccExtReader } from "./fish/occurrence.js";
import { fishOccExt } from "./fish/store-readers.js";

export const SEARCH_V2_META_KEY = "searchV2";

/** Stamp the per-request engine decision (latest wins). Writes only while
 *  engine = cjk; otherwise removes a stale stamp, and leaves metadata
 *  untouched when there is none (default config ⇒ no new key, E0-wire). */
export function storeEffectiveSearchV2(session: Session, settings: SearchV2Settings | undefined): void {
    if (settings) session.metadata[SEARCH_V2_META_KEY] = settings;
    else if (Object.prototype.hasOwnProperty.call(session.metadata, SEARCH_V2_META_KEY)) delete session.metadata[SEARCH_V2_META_KEY];
}

export function effectiveSearchV2(session: Session | undefined): SearchV2Settings | undefined {
    const v = session?.metadata[SEARCH_V2_META_KEY] as SearchV2Settings | undefined;
    return v && typeof v === "object" && v.engine === "cjk" ? v : undefined;
}

/** Plugin-lane context: the BASE config's search block (around gate). */
export interface SearchLane {
    around: boolean;
    raw?: SearchV2Raw;
}

const STOP_CHARS = new Set(Array.from("的了是在也就都和吗呢吧啊"));
/** Sentence-final particles cut from the end of a 3+ char run (成都吗 →
 *  成都). Not 吧: 酒吧 / 贴吧 end in it. */
const SENTENCE_FINAL = new Set(Array.from("吗呢啊呀嘛啦"));
/** Particles that join two words inside a short query (坏了的梨, 狗的药):
 *  a one-char word on either side also stands on its own. Not 都 / 在:
 *  成都市 / 存在感 are one word. */
const JOINERS = new Set(Array.from("的了和"));
/** A CJK run this long reads as a sentence: question / pointer words weigh
 *  nothing there. In a 2–4 char word they are part of the word (小时候, 哪吒). */
const SENTENCE_RUN = 5;
/** Question and pointer words of a whole-sentence query: they ask for the
 *  answer and never occur in it (「…叫什么」「…是哪天」「上次…那家」).
 *  Zero-weight inside a sentence-length run; a token made only of them (and
 *  hubs / stop chars) is dropped. Never cut out of a word. */
const QUESTION_WORDS = [
    "为什么", "叫什么", "是什么", "什么时候", "怎么样", "有没有", "是不是", "多少钱", "哪一天",
    "什么", "哪个", "哪些", "哪里", "哪儿", "哪天", "哪家", "哪首", "几点", "几个", "多少", "多大", "多久", "怎么", "是谁", "来着", "还记得", "记得",
    "上次", "之前", "那个", "那家", "那次", "这个", "时候", "一下", "过来",
    "啥", "谁", "哪",
].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
/** Question words that are never part of a word: cut out of the query
 *  wherever they stand (他几点睡 → 他 / 睡), like a space. The rest of
 *  QUESTION_WORDS (时候, 上次, 那个, 哪 …) do form words (小时候, 哪吒)
 *  and only weigh nothing inside a sentence. */
const CUT_QUESTION_WORDS = QUESTION_WORDS.filter((w) => !["记得", "上次", "之前", "那个", "那家", "那次", "这个", "时候", "一下", "过来", "多大", "啥", "谁", "哪"].includes(w));
/** A query of this many keywords (space-separated) is a keyword list: a
 *  window that holds half of them whole passes even when they are the
 *  lighter half (「wordbuddy token 中转 充值」). */
const KEYWORD_LIST_MIN = 3;
const PROMISE_RE = /答应|说好|约好|保证|欠|一定会|发誓/;
const PROMISE_WORDS = ["答应", "说好", "约好", "保证", "一定会", "发誓", "欠"];
const STRONG_IDF = 2.0;
/** …or a unit in at most this share of the windows (never fewer than two):
 *  a small corpus (a new session, a helper's) has no unit with idf ≥ 2. */
const STRONG_DF_SHARE = 0.135;
const GATE_THETA = 0.5;
const PHRASE_BONUS = 1.3;
const MAX_PER_BLOCK = 2;
const DUP_JACCARD = 0.6;
const SUMMARY_MAX_BLOCKS = 3;
const SUMMARY_SNIPPET = 120;
const SUMMARY_MAX_CHARS = 400;
const AROUND_SPAN = 40;
const AROUND_EACH = 10;
const AROUND_MAX_CHARS = 1500;
/** Leftover excerpt budget given to the reply right after a hit, per hit. */
const REPLY_MAX = 240;

interface Group extends QueryGroup {
    idf: number;
    df: number;
    /** Query positions covered (query char offsets; aliases get their own). */
    pos: number[];
    /** Covers at least one evidence position (not only hubs / stop chars /
     *  question words). Only such a unit makes a window "strong". */
    content: boolean;
}

interface Prepared {
    groups: Group[];
    /** Every token was a hub / stop char / question word (太宽). */
    tooBroad: boolean;
    /** Nothing searchable at all (only symbols / emoji). */
    noUnits: boolean;
    /** Words that occur nowhere. */
    missing: string[];
    /** The folded query with aliases and dropped tokens blanked out (same
     *  length as the typed query; positions index into it). */
    q: string;
    /** 1 = zero-weight position (hub, stop char, question word in a sentence). */
    zero: Uint8Array;
    phrase: string;
    /** Evidence mass per position: the LOWEST idf among the kept units
     *  covering it; a position only absent units cover weighs what its own
     *  character tells (a latin word / number that occurs nowhere weighs
     *  one maximally rare position in all). Zero-weight positions: none. */
    posWeight: Map<number, number>;
    totalMass: number;
    /** Short words (2–4 char runs): a window must cover every content char
     *  of one it touches, or it is only a near match (王小明 vs 王小红). */
    runs: Array<{ required: number[] }>;
    /** Keyword-list queries (KEYWORD_LIST_MIN+ typed tokens that weigh
     *  something): each token's weighted positions; empty otherwise. */
    segs: number[][];
}

function hasContent(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (isCjkCode(c) || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return true;
    }
    return false;
}

function replaceAllLiteral(hay: string, needle: string, by: string): string {
    if (!needle) return hay;
    return hay.split(needle).join(by);
}

const isAsciiAlnum = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** Offsets of `term` in `hay`; a term that starts / ends with a latin letter
 *  or digit matches only at a word edge there (mc is not inside mcdonald). */
function findTerm(hay: string, term: string): number[] {
    const out: number[] = [];
    if (!term) return out;
    const edgeL = isAsciiAlnum(term.charCodeAt(0));
    const edgeR = isAsciiAlnum(term.charCodeAt(term.length - 1));
    for (let at = hay.indexOf(term); at !== -1; at = hay.indexOf(term, at + 1)) {
        if (edgeL && at > 0 && isAsciiAlnum(hay.charCodeAt(at - 1))) continue;
        if (edgeR && at + term.length < hay.length && isAsciiAlnum(hay.charCodeAt(at + term.length))) continue;
        out.push(at);
    }
    return out;
}

function cjkRuns(q: string): Array<{ lo: number; hi: number }> {
    const out: Array<{ lo: number; hi: number }> = [];
    let i = 0;
    while (i < q.length) {
        if (!isCjkCode(q.charCodeAt(i))) { i++; continue; }
        let j = i;
        while (j < q.length && isCjkCode(q.charCodeAt(j))) j++;
        out.push({ lo: i, hi: j });
        i = j;
    }
    return out;
}

const byLengthDesc = (a: string, b: string): number => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);

/** Strong evidence: a rare unit by idf, or by share of the windows. */
function isStrong(index: GramIndex, df: number): boolean {
    return df > 0 && (index.idf(df) >= STRONG_IDF || df <= Math.max(2, Math.floor(STRONG_DF_SHARE * index.size)));
}

/** A latin word / number unit (its mass is spread over its letters). */
const isWordUnit = (g: Group): boolean => g.alts.length === 1 && g.alts[0]!.length === 1 && typeof g.alts[0]![0] === "string" && g.pos.length > 0 && g.pos.every((x) => x >= 0);

function emptyPrepared(q: string, tooBroad: boolean, noUnits: boolean): Prepared {
    return { groups: [], tooBroad, noUnits, missing: [], q, zero: new Uint8Array(q.length), phrase: "", posWeight: new Map(), totalMass: 0, runs: [], segs: [] };
}

/**
 * Cut the query into groups against `index` (df / idf from that index).
 * Hubs (the owner's name / 你 / 我 …), stop chars and question words are never cut out of
 * the text of the query: a token made only of them is dropped, inside a word
 * they stay part of it (熊兔, 成都, 你好, 小时候 keep their bigrams) and only
 * weigh nothing as evidence.
 */
function prepareQuery(query: string, s: SearchV2Settings, index: GramIndex): Prepared {
    const folded = foldSameLength(query);
    let q = folded;
    const blank = (lo: number, hi: number): void => {
        if (hi > lo) q = q.slice(0, lo) + " ".repeat(hi - lo) + q.slice(hi);
    };
    const groups: Group[] = [];
    // 1. aliases (whole terms, longest first; latin ones only at word edges)
    const aliasTerms: Array<{ term: string; group: string[] }> = [];
    for (const g of s.aliases) for (const t of g) aliasTerms.push({ term: foldSameLength(t), group: g.map((x) => foldSameLength(x)) });
    aliasTerms.sort((a, b) => byLengthDesc(a.term, b.term));
    const usedAlias = new Set<string>();
    const aliasAt = new Map<number, number>();
    for (const { term, group } of aliasTerms) {
        const at = findTerm(q, term);
        if (at.length === 0) continue;
        for (const i of at) blank(i, i + term.length);
        const key = group.join("\u0000");
        if (usedAlias.has(key)) continue;
        usedAlias.add(key);
        const alts: GramKey[][] = group.map((t) => queryUnits(t).map((u) => u.key)).filter((a) => a.length > 0);
        if (alts.length === 0) continue;
        const neg = -1 - groups.length;
        aliasAt.set(neg, at[0]!);
        groups.push({ alts, surfaces: [...group], phrases: [...group], label: term, idf: 0, df: 0, pos: [neg], content: true });
    }
    // 2. a whole token made only of hubs / question words / stop chars says nothing
    const hubs = [...s.hubs].map((h) => foldSameLength(h)).filter(Boolean).sort(byLengthDesc);
    const weak = [...hubs, ...QUESTION_WORDS].sort(byLengthDesc);
    for (const m of [...q.matchAll(/\S+/g)]) {
        let rest = m[0];
        for (const w of weak) rest = replaceAllLiteral(rest, w, " ");
        let left = "";
        for (const ch of rest) left += STOP_CHARS.has(ch) ? " " : ch;
        if (!hasContent(left)) blank(m.index!, m.index! + m[0].length);
    }
    for (const w of CUT_QUESTION_WORDS) for (const at of findTerm(q, w)) blank(at, at + w.length);
    if (!hasContent(q) && groups.length === 0) return emptyPrepared(q, hasContent(folded), !hasContent(folded));
    // 3. a sentence-final particle at the end of a 3+ char run (成都吗 → 成都)
    for (const r of cjkRuns(q)) {
        let hi = r.hi;
        while (hi - r.lo >= 3 && SENTENCE_FINAL.has(q[hi - 1]!)) {
            blank(hi - 1, hi);
            hi--;
        }
    }
    // 4. zero-weight positions: hubs and stop chars everywhere, question
    //    words inside sentence-length runs
    const zero = new Uint8Array(q.length);
    const runs = cjkRuns(q);
    const runOf = new Int32Array(q.length).fill(-1);
    runs.forEach((r, i) => { for (let x = r.lo; x < r.hi; x++) runOf[x] = i; });
    const inSentence = (x: number): boolean => x >= 0 && runOf[x]! >= 0 && runs[runOf[x]!]!.hi - runs[runOf[x]!]!.lo >= SENTENCE_RUN;
    for (const h of hubs) for (const at of findTerm(q, h)) zero.fill(1, at, at + h.length);
    for (let x = 0; x < q.length; x++) if (STOP_CHARS.has(q[x]!)) zero[x] = 1;
    for (const r of runs) {
        if (r.hi - r.lo < SENTENCE_RUN) continue;
        const run = q.slice(r.lo, r.hi);
        for (const w of QUESTION_WORDS) for (const at of findTerm(run, w)) zero.fill(1, r.lo + at, r.lo + at + w.length);
    }
    // 5. units; one covering only zero-weight chars is dropped in a sentence
    //    (兔上 / 什么) and kept for ranking only inside a short word (兔兔 of 兔兔虫)
    const addUnit = (key: GramKey, surfaces: string[], label: string, pos: number[], content: boolean): void => {
        const same = groups.find((g) => g.alts.length === 1 && g.alts[0]!.length === 1 && g.alts[0]![0] === key);
        if (same) {
            for (const x of pos) if (!same.pos.includes(x)) same.pos.push(x);
            for (const sf of surfaces) if (!same.surfaces.includes(sf)) same.surfaces.push(sf);
            same.content ||= content;
            return;
        }
        groups.push({ alts: [[key]], surfaces: [...surfaces], label, idf: 0, df: 0, pos: [...pos], content });
    };
    for (const u0 of queryUnits(q)) {
        for (const u of splitGluedLatin(u0, index)) {
            const content = u.pos.some((x) => zero[x] === 0);
            if (!content && (typeof u.key !== "number" || inSentence(u.pos[0]!))) continue;
            let lo = Infinity;
            let hi = -1;
            for (const x of u.pos) { if (x < lo) lo = x; if (x > hi) hi = x; }
            const label = u.pos.length > 0 ? q.slice(lo, hi + 1) : (u.surfaces[0] ?? "");
            addUnit(u.key, u.surfaces, label, u.pos, content);
        }
    }
    // 6. df / idf
    const kept: Group[] = [];
    const absent: Group[] = [];
    for (const g of groups) {
        g.df = index.groupDf(g);
        if (g.df === 0) {
            absent.push(g);
            continue;
        }
        g.idf = index.idf(g.df);
        kept.push(g);
    }
    // 7. a char's own unigram where its bigrams only cross a word edge: in a
    //    sentence, a content char no present unit covers (那家【店】叫什么);
    //    in a short query a particle splits (坏了的梨, 狗的药), a one-char word
    const coveredKept = new Set<number>();
    for (const g of kept) for (const x of g.pos) coveredKept.add(x);
    const addUnigram = (x: number): void => {
        const code = q.charCodeAt(x);
        const df = index.df(code);
        if (df === 0) return;
        const same = kept.find((g) => g.alts.length === 1 && g.alts[0]!.length === 1 && g.alts[0]![0] === code);
        if (same) {
            if (!same.pos.includes(x)) same.pos.push(x);
            same.content = true;
        } else kept.push({ alts: [[code]], surfaces: [q[x]!], label: q[x]!, idf: index.idf(df), df, pos: [x], content: true });
        coveredKept.add(x);
    };
    for (const r of runs) {
        if (r.hi - r.lo >= SENTENCE_RUN) {
            for (let x = r.lo; x < r.hi; x++) if (!zero[x] && !coveredKept.has(x)) addUnigram(x);
            continue;
        }
        const words: Array<[number, number]> = [];
        for (let x = r.lo; x < r.hi;) {
            if (JOINERS.has(q[x]!)) { x++; continue; }
            let y = x;
            while (y < r.hi && !JOINERS.has(q[y]!)) y++;
            words.push([x, y]);
            x = y;
        }
        if (words.length < 2) continue;
        for (const [a, b] of words) if (b - a === 1 && !zero[a]) addUnigram(a);
    }
    // 8. evidence mass per position. A hub / stop char inside a short word
    //    weighs what the word's unit weighs when that unit matched (成都 is
    //    two positions like 去过, or 「去过 成都」 would let 去过 alone pass);
    //    in a sentence and on its own it weighs nothing.
    const inShortRun = (x: number): boolean => x >= 0 && runOf[x]! >= 0 && runs[runOf[x]!]!.hi - runs[runOf[x]!]!.lo < SENTENCE_RUN;
    const posWeight = new Map<number, number>();
    for (const g of kept) {
        // a latin word / number / alias weighs what a two-char Chinese word
        // weighs (two positions of its idf); one that occurs nowhere weighs
        // a single maximally rare position (below), so it cannot sink the rest
        const per = isWordUnit(g) ? (2 * g.idf) / g.pos.length : g.pos.length === 1 && g.pos[0]! < 0 ? 2 * g.idf : g.idf;
        for (const x of g.pos) {
            if (x >= 0 && zero[x] && !(g.content && inShortRun(x))) continue;
            posWeight.set(x, Math.min(posWeight.get(x) ?? Infinity, per));
        }
    }
    const absentPos = new Set<number>();
    for (const g of absent) {
        for (const x of g.pos) {
            if ((x >= 0 && zero[x]) || posWeight.has(x)) continue;
            absentPos.add(x);
            const code = x >= 0 ? q.charCodeAt(x) : -1;
            const w = x >= 0 && isCjkCode(code) ? index.idf(index.df(code)) : isWordUnit(g) ? index.idf(0) / g.pos.length : index.idf(0);
            posWeight.set(x, w);
        }
    }
    let totalMass = 0;
    for (const w of posWeight.values()) totalMass += w;
    // 9. short words: the content chars a window must cover to be the word itself
    const shortRuns: Prepared["runs"] = [];
    for (const r of runs) {
        const len = r.hi - r.lo;
        if (len < 2 || len >= SENTENCE_RUN) continue;
        const required: number[] = [];
        for (let x = r.lo; x < r.hi; x++) if (!zero[x]) required.push(x);
        if (required.length >= 2) shortRuns.push({ required });
    }
    // 10. what is really absent: a short word none of whose content chars a
    //     present unit covers, or (sentences, latin) a run of absent
    //     positions that weighs like a real word
    const missing: string[] = [];
    const reported = new Set<number>();
    for (const r of runs) {
        const len = r.hi - r.lo;
        if (len < 2 || len >= SENTENCE_RUN) continue;
        let content = false;
        let any = false;
        for (let x = r.lo; x < r.hi; x++) {
            if (zero[x]) continue;
            content = true;
            if (coveredKept.has(x)) { any = true; break; }
        }
        if (content && !any) {
            missing.push(q.slice(r.lo, r.hi));
            for (let x = r.lo; x < r.hi; x++) reported.add(x);
        }
    }
    const absentSorted = [...absentPos].filter((x) => x >= 0 && !reported.has(x)).sort((a, b) => a - b);
    for (let i = 0; i < absentSorted.length;) {
        let j = i;
        while (j + 1 < absentSorted.length && absentSorted[j + 1] === absentSorted[j]! + 1) j++;
        const lo = absentSorted[i]!;
        const hi = absentSorted[j]!;
        let mass = 0;
        for (let x = lo; x <= hi; x++) mass += posWeight.get(x) ?? 0;
        // a whole cut-out segment, or 3+ chars inside a longer one
        const wholeSeg = (lo === 0 || /\s/.test(q[lo - 1]!)) && (hi + 1 >= q.length || /\s/.test(q[hi + 1]!));
        if (mass >= STRONG_IDF && hi > lo && (wholeSeg || hi - lo >= 2)) missing.push(q.slice(lo, hi + 1));
        i = j + 1;
    }
    for (const g of absent) if (g.pos.length === 1 && g.pos[0]! < 0) missing.push(g.label);
    // 10b. keyword lists: the weighted positions of each typed token
    const segs: number[][] = [];
    for (const m of [...folded.matchAll(/\S+/g)]) {
        const lo = m.index!;
        const hi = lo + m[0].length;
        const xs: number[] = [];
        for (let x = lo; x < hi; x++) if (posWeight.has(x)) xs.push(x);
        for (const [neg, at] of aliasAt) if (at >= lo && at < hi && posWeight.has(neg)) xs.push(neg);
        if (xs.length > 0) segs.push(xs);
    }
    // 11. the verbatim phrase bonus: a 3–4 char word as typed, or the longest
    //     stretch of content chars in a sentence (3+)
    let phrase = "";
    for (const r of runs) {
        const len = r.hi - r.lo;
        if (len < SENTENCE_RUN) {
            if (len >= 3 && len > phrase.length) phrase = q.slice(r.lo, r.hi);
            continue;
        }
        for (let x = r.lo; x < r.hi;) {
            if (zero[x]) { x++; continue; }
            let y = x;
            while (y < r.hi && !zero[y]) y++;
            if (y - x >= 3 && y - x > phrase.length) phrase = q.slice(x, y);
            x = y;
        }
    }
    return { groups: kept, tooBroad: false, noUnits: false, missing, q, zero, phrase, posWeight, totalMass, runs: shortRuns, segs: segs.length >= KEYWORD_LIST_MIN ? segs : [] };
}

/** A latin word the index has never seen, typed without the space between
 *  two words it does know (`ab cd` → `abcd` when a whole-sentence query
 *  drops spaces): split it into the fewest known words (each 2+ letters).
 *  Anything else, or no clean split, stays as typed. */
function splitGluedLatin(u: ReturnType<typeof queryUnits>[number], index: GramIndex): Array<ReturnType<typeof queryUnits>[number]> {
    if (typeof u.key !== "string" || !u.key.startsWith("w:")) return [u];
    const word = u.key.slice(2);
    if (word.length < 4 || word.length > 40 || u.pos.length !== word.length || index.df(u.key) > 0) return [u];
    const n = word.length;
    const best: number[] = Array(n + 1).fill(Infinity);
    const from: number[] = Array(n + 1).fill(-1);
    best[0] = 0;
    for (let e = 2; e <= n; e++) {
        for (let b = 0; b + 2 <= e; b++) {
            if (best[b] === Infinity || best[b]! + 1 >= best[e]!) continue;
            if (index.df(`w:${word.slice(b, e)}`) > 0) { best[e] = best[b]! + 1; from[e] = b; }
        }
    }
    if (best[n] === Infinity || best[n]! < 2) return [u];
    const parts: Array<ReturnType<typeof queryUnits>[number]> = [];
    for (let e = n; e > 0; e = from[e]!) {
        const b = from[e]!;
        const w = word.slice(b, e);
        parts.unshift({ key: `w:${w}`, surfaces: [w], single: false, pos: u.pos.slice(b, e) });
    }
    return parts;
}

/** Swap 你↔我 / 你们↔我们 (promise flip, S6). */
export function flipPerson(q: string): string {
    return q.replace(/你们|我们|你|我/g, (m) => (m === "你们" ? "我们" : m === "我们" ? "你们" : m === "你" ? "我" : "你"));
}

interface Scored {
    doc: number;
    score: number;
    tf: number[];
    /** Near matches: the content chars of a short word this window misses. */
    miss?: number[];
}

function scoreWindows(p: Prepared, index: GramIndex, docs: { lower: string; weight: number }[]): { passed: Scored[]; near: Scored[]; edge: number } {
    if (p.groups.length === 0) return { passed: [], near: [], edge: 0 };
    const cand = index.match(p.groups);
    const passed: Scored[] = [];
    const near: Scored[] = [];
    let edge = 0;
    for (const [doc, tf] of cand) {
        const w = docs[doc]!;
        // alias groups: the bigram AND is a bound — verify a whole term
        p.groups.forEach((g, gi) => {
            if (tf[gi]! > 0 && g.phrases && !g.phrases.some((ph) => w.lower.includes(ph))) tf[gi] = 0;
        });
        let strong = false;
        let score = 0;
        const covered = new Set<number>();
        p.groups.forEach((g, gi) => {
            const t = tf[gi]!;
            if (t <= 0) return;
            for (const x of g.pos) covered.add(x);
            if (g.content && isStrong(index, g.df)) strong = true;
            score += g.idf * index.tfWeight(t, doc);
        });
        let matched = 0;
        for (const x of covered) matched += p.posWeight.get(x) ?? 0;
        // only zero-weight chars (a hub's bigram) matched: not even an edge
        if (matched <= 0) continue;
        let pass = matched >= GATE_THETA * p.totalMass;
        if (!pass && p.segs.length > 0) {
            let whole = 0;
            for (const sg of p.segs) if (sg.every((x) => covered.has(x))) whole++;
            pass = whole * 2 >= p.segs.length;
        }
        if (!(strong && pass)) {
            edge++;
            continue;
        }
        const miss: number[] = [];
        // a short word it touches: every content char must be in the window
        // (in another order is fine: 看电影 ↔ 电影看完); one that is not
        // there at all makes this a near match (王小明 ↔ 王小红)
        for (const r of p.runs) {
            let touched = false;
            const lack: number[] = [];
            for (const x of r.required) {
                if (covered.has(x)) touched = true;
                else if (!w.lower.includes(p.q[x]!)) lack.push(x);
            }
            if (touched && lack.length > 0) miss.push(...lack);
        }
        if (p.phrase && w.lower.includes(p.phrase)) score *= PHRASE_BONUS;
        if (miss.length > 0) near.push({ doc, score: score * w.weight, tf, miss });
        else passed.push({ doc, score: score * w.weight, tf });
    }
    const order = (a: Scored, b: Scored): number => b.score - a.score || a.doc - b.doc;
    passed.sort(order);
    near.sort(order);
    return { passed, near, edge };
}

/** A window keeps the higher of its two scores (promise flip). */
function mergeBest(a: Scored[], b: Scored[]): Scored[] {
    const best = new Map<number, Scored>();
    for (const x of a) best.set(x.doc, x);
    for (const x of b) {
        const prev = best.get(x.doc);
        if (!prev || x.score > prev.score) best.set(x.doc, { ...x, tf: prev ? prev.tf : x.tf, miss: prev ? prev.miss : x.miss });
    }
    return [...best.values()].sort((m, n) => n.score - m.score || m.doc - n.doc);
}

/** The query chars at `positions`, contiguous ones joined: 「明」「红」. */
function charsAt(p: Prepared, positions: readonly number[]): string[] {
    const xs = [...new Set(positions)].filter((x) => x >= 0 && x < p.q.length).sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 0; i < xs.length;) {
        let j = i;
        while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j++;
        out.push(p.q.slice(xs[i]!, xs[j]! + 1));
        i = j + 1;
    }
    return out;
}

function parentMap(state: CompressionState): Map<string, string> {
    const m = new Map<string, string>();
    for (const b of state.blocks) for (const c of b.directBlockIds ?? []) if (!m.has(c)) m.set(c, b.blockId);
    return m;
}

function topParent(parents: Map<string, string>, id: string): string | null {
    let cur = parents.get(id);
    if (!cur) return null;
    const seen = new Set<string>([id]);
    for (;;) {
        const up = parents.get(cur);
        if (!up || seen.has(up)) return cur;
        seen.add(cur);
        cur = up;
    }
}

const mref = (n: number): string => `m${String(n).padStart(5, "0")}`;

/** What to wrap in 【】: the longest stretch of the query (2+ chars, at
 *  least one content char) that occurs verbatim in `text` — so 兔兔虫 /
 *  熊兔 are marked whole — else the rarest matched unit's surface. */
function markNeedle(p: Prepared, tf: number[], text: string): string {
    const lower = foldSameLength(text);
    // bigram idf of the query's units: equal-length stretches → the rarer one
    const idfOf = new Map<string, number>();
    for (const g of p.groups) for (const sf of g.surfaces) idfOf.set(sf, Math.max(idfOf.get(sf) ?? 0, g.content ? g.idf : 0));
    const rarity = (sub: string): number => {
        let r = 0;
        for (let i = 0; i + 1 < sub.length; i++) r += idfOf.get(sub.slice(i, i + 2)) ?? 0;
        return r;
    };
    let best = "";
    let bestR = -1;
    for (const r of cjkRuns(p.q)) {
        const run = p.q.slice(r.lo, r.hi);
        for (let len = Math.min(run.length, 12); len >= 2 && len >= best.length; len--) {
            let foundHere = false;
            for (let i = 0; i + len <= run.length; i++) {
                let content = false;
                for (let x = r.lo + i; x < r.lo + i + len; x++) if (!p.zero[x]) { content = true; break; }
                if (!content) continue;
                const sub = run.slice(i, i + len);
                if (!lower.includes(sub)) continue;
                foundHere = true;
                const rr = rarity(sub);
                if (len > best.length || rr > bestR) { best = sub; bestR = rr; }
            }
            if (foundHere) break;
        }
    }
    if (best) return best;
    const order = p.groups.map((g, i) => ({ g, i })).filter((x) => tf[x.i]! > 0 && x.g.content).sort((a, b) => b.g.idf - a.g.idf || a.i - b.i);
    for (const { g } of order) for (const sf of g.surfaces) if (lower.includes(sf)) return sf;
    return "";
}

/** Speaker of the window line that contains `pos`. */
function lineAt(w: Window, pos: number): Window["spans"][number] | undefined {
    for (const sp of w.spans) if (pos >= sp.start && pos < sp.end + 1) return sp;
    return undefined;
}

interface Cut {
    text: string;
    refLo: number;
    refHi: number;
    mark: string;
    /** Ref and speaker of the excerpt's last line. */
    lastRef: number;
    lastSpeaker: string;
    /** fork（日期）：不算注记的长度（预算照旧按原话算，开关开不开选出来的段一样）。 */
    rawLen: number;
    /** fork（日期）：这一段里加了几处注记。 */
    noteHits: number;
}

function cutExcerpt(w: Window, hits: SpanHit[], len: number, natural: { start: number; end: number }, p: Prepared, tf: number[], dates: SearchDateNoter | null = null): Cut {
    let start: number;
    let end: number;
    if (natural.end - natural.start <= len) {
        start = natural.start;
        end = natural.end;
    } else {
        const b = bestSpan(hits, w.text.length, len);
        start = b.start;
        end = b.end;
    }
    // mid-line start: re-attach who said it (inside the "名字：" prefix → snap to the line start)
    let prefix = "";
    const line = lineAt(w, start);
    if (line && start > line.start) {
        const spk = line.speaker ? `${line.speaker}：` : "";
        if (spk && start < line.start + spk.length) start = line.start;
        else prefix = spk ? `${spk}……` : "……";
    }
    const body = safeSlice(w.text, start, end);
    const tail = end < w.text.length && w.text.charCodeAt(end) !== 0x0a ? "……" : "";
    const mark = markNeedle(p, tf, prefix + body + tail);
    const plain = markFirst(prefix + body + tail, mark);
    // fork（日期，D5）：开着时同一段原话加注记（每行用自己的锚点），【】不标进注记里；关着时一个字节不变
    let noteHits = 0;
    let out = plain;
    if (dates) {
        const bs = safeBounds(w.text, start, end);
        const noted = dates.slice(w, bs[0], bs[1], dates.maxPerSnippet);
        noteHits = noted.hits;
        if (noteHits > 0) out = markFirstOutside(prefix + noted.text + tail, mark);
    }
    let refLo = Infinity;
    let refHi = -Infinity;
    for (const sp of w.spans) {
        if (sp.end <= start || sp.start >= end) continue;
        refLo = Math.min(refLo, sp.ref);
        refHi = Math.max(refHi, sp.ref);
    }
    if (!Number.isFinite(refLo)) { refLo = w.refFirst; refHi = w.refLast; }
    const last = lineAt(w, Math.max(start, end - 1));
    return { text: out, refLo, refHi, mark, lastRef: last?.ref ?? refHi, lastSpeaker: last?.speaker ?? "", rawLen: plain.length, noteHits };
}

/** safeSlice 实际切的范围（不切开代理对）。 */
function safeBounds(text: string, start: number, end: number): [number, number] {
    let s0 = Math.max(0, start);
    let e0 = Math.min(text.length, end);
    if (s0 > 0 && s0 < text.length) {
        const c = text.charCodeAt(s0);
        if (c >= 0xdc00 && c <= 0xdfff) s0 += 1;
    }
    if (e0 > 0 && e0 < text.length) {
        const c = text.charCodeAt(e0 - 1);
        if (c >= 0xd800 && c <= 0xdbff) e0 -= 1;
    }
    return [s0, Math.max(s0, e0)];
}

/** The first line after `afterRef` in the same lane and block (this window,
 *  else the next one). */
function followingLine(w: Window, afterRef: number, docs: readonly Window[]): { text: string; ref: number; speaker: string; w: Window } | null {
    let src = w;
    let sp = w.spans.find((x) => x.ref > afterRef);
    if (!sp) {
        const nx = docs[w.id + 1];
        if (nx && nx.blockId === w.blockId && nx.lane === w.lane) {
            src = nx;
            sp = nx.spans.find((x) => x.ref > afterRef);
        }
    }
    if (!sp) return null;
    return { text: src.text.slice(sp.start, sp.end), ref: sp.ref, speaker: sp.speaker, w: src };
}

/** A line cut to at most `max` chars, at a sentence end when there is one. */
function clipLine(text: string, max: number): string {
    if (text.length <= max) return text;
    for (let e = max; e >= Math.floor(max / 2); e--) {
        const c = text.charCodeAt(e - 1);
        if (c === 0x3002 || c === 0xff01 || c === 0xff1f || c === 0xff1b || c === 0x2026 || c === 0x21 || c === 0x3f) return safeSlice(text, 0, e);
    }
    return max > 4 ? `${safeSlice(text, 0, max - 2)}……` : "";
}

function laneTitle(w: Window): string {
    if (w.kind === "others") return `${w.laneLabel}（别人的话）`;
    return w.laneLabel;
}

/** The search: null = cannot serve (caller falls back to the old path). */
async function executeSearchContextV2(
    args: Record<string, unknown>,
    session: Session,
    settings: SearchV2Settings,
    opts: { rows: RowSource; log?: (m: string) => void; aroundOn?: boolean; ext?: OccExtReader | null },
): Promise<ProxyToolResult | null> {
    // no unified store (persistence off, shadow disabled) → the old path answers everything
    if (opts.rows.page(session.id, Number.MAX_SAFE_INTEGER, 1) === null) return null;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query.length === 0) return toolFail("[search_context 没执行：query 是空的]");
    const state = session.state;
    if (state.blocks.length === 0) return toolOk("（还没有折起来的旧对话，没有可找的。）");
    const rawLimit = typeof args.limit === "number" ? args.limit : typeof args.limit === "string" && /^\d+$/.test(args.limit.trim()) ? Number(args.limit.trim()) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(SEARCH_V2_MAX_HITS, Math.floor(rawLimit)) : settings.maxHits;
    const t0 = Date.now();
    const corpus = await ensureCorpus(session.id, state, settings, { rows: opts.rows, log: opts.log });
    if (!corpus) return null;
    const tBuilt = Date.now();
    // fork（日期，S7/D5）：fish.dateNotes 开着、reldate 核过 sha 才有注记器；关着时这里不读任何东西
    const dates = fishDateNotesWanted() ? openSearchDateNoter(session.id, state, opts.rows, opts.ext ?? null) : null;
    const text = renderSearch(query, limit, corpus, state, settings, { aroundOn: opts.aroundOn === true, dates });
    dates?.done();
    opts.log?.(`[search-v2] query units=${text.units} hits=${text.hits} edge=${text.edge} summaries=${text.summaries} chars=${text.out.length} build_ms=${tBuilt - t0} query_ms=${Date.now() - tBuilt}`);
    return toolOk(text.out);
}

const NOT_FOUND_TAIL = "只找了折起来的部分，眼前还看得到的对话不在这里；没找到不等于没说过，换个更具体的词再试。";

/** Pure render over a built corpus (exported for tests / evaluation). */
export function renderSearch(
    query: string,
    limit: number,
    corpus: Corpus,
    state: CompressionState,
    s: SearchV2Settings,
    opts: { aroundOn?: boolean; dates?: SearchDateNoter | null } = {},
): { out: string; hits: number; edge: number; summaries: number; units: number } {
    const dates = opts.dates ?? null;
    const docs = corpus.windows;
    const q = query.replace(/\s+/g, " ");
    const p = prepareQuery(query, s, corpus.index);
    if (p.noUnits) return { out: `「${q}」：这种符号找不了（只认中文、字母和数字）；换成字词再找。`, hits: 0, edge: 0, summaries: 0, units: 0 };
    if (p.tooBroad) return { out: `「${q}」：这几个字到处都有，太宽了；换个更具体的词（人名、地方、东西、数字）再找。`, hits: 0, edge: 0, summaries: 0, units: 0 };
    let { passed, near, edge } = scoreWindows(p, corpus.index, docs);
    // S6 promise flip: a second reading with 你↔我 swapped; a window keeps the
    // higher of its two scores (the swap keeps the length, so positions agree).
    let flipP: Prepared | null = null;
    if (s.promiseFlip && PROMISE_RE.test(query)) {
        const fq = flipPerson(query);
        if (fq !== query) {
            flipP = prepareQuery(fq, s, corpus.index);
            if (!flipP.tooBroad && !flipP.noUnits) {
                const r2 = scoreWindows(flipP, corpus.index, docs);
                passed = mergeBest(passed, r2.passed);
                const full = new Set(passed.map((x) => x.doc));
                near = mergeBest(near, r2.near).filter((x) => !full.has(x.doc));
                edge = Math.max(edge, r2.edge);
            }
        }
    }
    // only near matches (a short word with a char off: 王小明 → 王小红): list
    // them as such; otherwise they count with the edge
    const useNear = passed.length === 0 && near.length > 0;
    if (!useNear) edge += near.length;
    const pool = useNear ? near : passed;
    // dedupe / diversity
    const picked: Scored[] = [];
    const perBlock = new Map<string, number>();
    const taken: Array<{ w: Window; grams: Set<string> }> = [];
    for (const c of pool) {
        if (picked.length >= limit) break;
        const w = docs[c.doc]!;
        if ((perBlock.get(w.blockId) ?? 0) >= MAX_PER_BLOCK) continue;
        let dup = false;
        let grams: Set<string> | null = null;
        for (const t of taken) {
            if (t.w.lane === w.lane && t.w.blockId === w.blockId && t.w.refFirst <= w.refLast && w.refFirst <= t.w.refLast) { dup = true; break; }
            if (t.w.lane !== w.lane) {
                grams ??= bigramSet(w.text);
                if (jaccard(grams, t.grams) >= DUP_JACCARD) { dup = true; break; }
            }
        }
        if (dup) continue;
        picked.push(c);
        perBlock.set(w.blockId, (perBlock.get(w.blockId) ?? 0) + 1);
        taken.push({ w, grams: grams ?? bigramSet(w.text) });
    }
    // excerpts: natural lengths → fair split of the budget
    const groupsForSpan = (g: Prepared): Array<{ surfaces: string[]; idf: number }> => g.groups.filter((x) => x.content).map((x) => ({ surfaces: x.surfaces, idf: x.idf }));
    const spanGroups = groupsForSpan(p);
    const promiseBonus = flipP ? PROMISE_WORDS.filter((x) => query.includes(x)).map((x) => ({ surfaces: [x], idf: 1 })) : [];
    const prepared = picked.map((c) => {
        const w = docs[c.doc]!;
        const hits = findHits(w.lower, [...spanGroups, ...promiseBonus]);
        const nat = naturalSpan(w.text, hits, 400);
        const line = lineAt(w, nat.start);
        const spk = line && nat.start > line.start && line.speaker ? line.speaker.length + 3 : 0;
        return { c, w, hits, nat, natural: nat.end - nat.start + spk };
    });
    const lens = allocateExcerptBudget(prepared.map((x) => x.natural), s.budget);
    const cuts: Array<{ x: (typeof prepared)[number]; cut: Cut }> = [];
    prepared.forEach((x, i) => {
        const len = lens[i]!;
        if (len <= 0) return;
        cuts.push({ x, cut: cutExcerpt(x.w, x.hits, len, x.nat, p, x.c.tf, dates) });
    });
    // what the budget leaves goes to the reply right after a hit (the next
    // line of the same chat, said by someone else): a question shows its answer
    let left = s.budget;
    for (const k of cuts) left -= k.cut.rawLen;
    for (const k of cuts) {
        if (left < 30) break;
        const nx = followingLine(k.x.w, k.cut.lastRef, docs);
        if (!nx || !nx.speaker || nx.speaker === k.cut.lastSpeaker) continue;
        const piece = clipLine(nx.text, Math.min(left, REPLY_MAX));
        if (!piece) continue;
        if (dates && k.cut.noteHits < dates.maxPerSnippet) {
            // fork（日期）：回话那一行用它自己的锚点；clipLine 只会在末尾加「……」
            const core = nx.text.startsWith(piece) ? piece.length : piece.length - 2;
            const noted = dates.line(nx.w, nx.text, nx.ref, nx.speaker, core, dates.maxPerSnippet - k.cut.noteHits);
            k.cut.noteHits += noted.hits;
            k.cut.text += `\n${noted.hits > 0 ? noted.text + piece.slice(core) : piece}`;
        } else k.cut.text += `\n${piece}`;
        k.cut.refHi = Math.max(k.cut.refHi, nx.ref);
        left -= piece.length + 1;
    }
    const parents = parentMap(state);
    const items: string[] = [];
    let n = 0;
    let tip: { ref: number; mark: string; block: string } | null = null;
    for (const { x, cut } of cuts) {
        n++;
        tip ??= { ref: cut.refLo, mark: cut.mark, block: x.w.blockId };
        const span = cut.refLo === cut.refHi ? mref(cut.refLo) : `${mref(cut.refLo)}–${mref(cut.refHi)}`;
        const up = topParent(parents, x.w.blockId);
        const upNote = up ? `（已折进 ${up}）` : "";
        // fork（日期）：头行不写日期（这一版只在原话里加注记，见 fork-1120 MERGE.md）
        const missNote = useNear && x.c.miss ? `（「${charsAt(p, x.c.miss).join("」「")}」没对上）` : "";
        const head = `[${n}] ${x.w.blockId} · ${laneTitle(x.w)} · ${span}${upNote}${missNote}`;
        items.push(`${head}\n${cut.text.split("\n").map((l) => `  ${l}`).join("\n")}`);
    }
    // summary path
    const compiled = compileSettings(s);
    const sum = corpus.summary;
    const sp = prepareQuery(query, s, sum.index);
    const sres = scoreWindows(sp, sum.index, sum.lowers.map((l) => ({ lower: l, weight: 1 })));
    const sumLines: string[] = [];
    let sumChars = 0;
    for (const c of sres.passed) {
        if (sumLines.length >= SUMMARY_MAX_BLOCKS) break;
        const bid = sum.blockIds[c.doc]!;
        const b = state.blocks.find((x) => x.blockId === bid);
        const t = sum.texts[c.doc]!;
        // the indexed text is "topic summary": the topic shows once (in 「」),
        // the snippet comes from the summary part
        const topicFull = scrubText(b?.topic ?? "", compiled);
        const bodyAt = topicFull && t.startsWith(topicFull) ? Math.min(t.length, topicFull.length + 1) : 0;
        const body = t.slice(bodyAt);
        const hits = findHits(sum.lowers[c.doc]!.slice(bodyAt), groupsForSpan(sp));
        const span = bestSpan(hits, body.length, SUMMARY_SNIPPET);
        let snip = safeSlice(body, span.start, span.end);
        if (snip && span.start > 0) snip = `……${snip}`;
        if (snip && span.end < body.length) snip = `${snip}……`;
        const sumMark = markNeedle(sp, c.tf, snip);
        // fork（日期）：她写的摘要只在 fish.dateNotes.summaries 开着时标，锚点是块覆盖的那段时间（跨日不标）
        const sb = safeBounds(body, span.start, span.end);
        const sumNoted = dates && b && snip ? dates.summary(body, sb[0], sb[1], summaryAnchor(b, state)) : null;
        if (sumNoted !== null && sumNoted !== body.slice(sb[0], sb[1])) {
            snip = markFirstOutside(`${span.start > 0 ? "……" : ""}${sumNoted}${span.end < body.length ? "……" : ""}`, sumMark);
        } else snip = markFirst(snip, sumMark);
        const topic = topicFull.length > 30 ? `${safeSlice(topicFull, 0, 30)}…` : topicFull;
        const line = `- ${bid}${topic ? `「${topic}」` : ""}${b && !b.active ? "（已折进更大的块）" : ""}${snip ? " " + snip : ""}`;
        if (sumChars + line.length > SUMMARY_MAX_CHARS && sumLines.length > 0) break;
        sumLines.push(line);
        sumChars += line.length;
    }
    // render
    const notes: string[] = [];
    if (p.missing.length > 0) notes.push(`「${p.missing.slice(0, 6).join("」「")}」一处都没有。`);
    if (n === 0 && sumLines.length === 0) {
        const content = p.groups.filter((g) => g.content);
        // every word of the query is everywhere: 太宽, not 没找到
        if (content.length > 0 && p.missing.length === 0 && content.every((g) => !isStrong(corpus.index, g.df))) {
            const most = content.reduce((m, g) => Math.max(m, g.df), 0);
            return {
                out: `「${q}」：这些字词到处都有（约 ${most} 处都沾得上），单靠它们分不出是哪一段，太宽了；加一个更具体的词（人名、地方、东西、数字）一起找。\n${NOT_FOUND_TAIL}`,
                hits: 0,
                edge,
                summaries: 0,
                units: p.groups.length,
            };
        }
        const common = content.filter((g) => !isStrong(corpus.index, g.df)).map((g) => g.label).slice(0, 4);
        const parts = [`「${q}」：在折起来的旧对话里没找到。`];
        if (common.length > 0) parts.push(`「${common.join("」「")}」到处都有，单靠它们分不出是哪一段。`);
        if (edge > 0) parts.push(`另有约 ${edge} 处只沾到一点边，没列。`);
        parts.push(...notes);
        parts.push(NOT_FOUND_TAIL);
        return { out: parts.join("\n"), hits: 0, edge, summaries: 0, units: p.groups.length };
    }
    const sumPart = sumLines.length > 0 ? `、${sumLines.length} 块摘要` : "";
    const header = n === 0
        ? `「${q}」：原话里没找到，摘要里有 ${sumLines.length} 块（按相关排；没列出来的不等于没有）`
        : useNear
            ? `「${q}」：没有原样对上的；下面 ${n} 处只对上了一部分${sumPart ? `（另有${sumPart.slice(1)}）` : ""}，可能是别的名字或东西，看清楚再用`
            : `「${q}」：找到 ${n} 处原话${sumPart}（按相关排，每处只给命中的一小段；没列出来的不等于没有）`;
    const blocks: string[] = [header];
    if (notes.length > 0) blocks.push(notes.join("\n"));
    if (items.length > 0) blocks.push(items.join("\n"));
    if (sumLines.length > 0) blocks.push(`你写的摘要：\n${sumLines.join("\n")}`);
    if (edge > 0 && n < limit) blocks.push(`另有约 ${edge} 处只沾到一点边，没列。`);
    const t = tip as { ref: number; mark: string; block: string } | null;
    // the tip's query: the marked word, else what was typed (never empty)
    const tipQuery = safeSlice((t && t.mark ? t.mark : q).replace(/["\\\n]/g, "").trim(), 0, 30);
    const aroundTip = t && opts.aroundOn && tipQuery ? `要看哪一处前后：search_context({ query: "${tipQuery}", around: "${mref(t.ref)}" })；` : "";
    const firstBlock = t ? t.block : sres.passed.length > 0 ? sum.blockIds[sres.passed[0]!.doc]! : "";
    blocks.push(`${aroundTip}要看整块：decompress({ blockId: "${firstBlock}" })`);
    const legend = dates ? dates.legend() : "";
    if (legend) blocks.push(legend);
    return { out: blocks.join("\n\n"), hits: n, edge, summaries: sumLines.length, units: p.groups.length };
}

// ------------------------------------------------------------ around (S4)

/**
 * `around: "m12345"` — the messages before and after one ref in the same
 * lane, read from the ledger rows (conversation and experience only, never
 * reasoning), at most 1,500 chars; `query` (optional) only marks 【】.
 */
export function executeSearchAround(
    args: Record<string, unknown>,
    session: Session,
    settings: SearchV2Settings,
    rows: RowSource,
    ext: OccExtReader | null = null,
): ProxyToolResult | null {
    const around = typeof args.around === "string" ? args.around.trim() : "";
    const m = /^m0*(\d+)$/.exec(around);
    if (!m) return toolFail(`[search_context 没执行：around 要填结果里的 m 编号，比如 "m12345"]`);
    const target = Number(m[1]);
    const lo = Math.max(0, target - AROUND_SPAN);
    const hi = target + AROUND_SPAN;
    const got = rows.byRefRange(session.id, lo, hi);
    if (got === null) return null;
    // fork（G2 终审 I1）：看得到的编号 = 有活行的，或被某个块盖住的（decompress 够得着的那些）。
    // 只剩旧一代、又没有块盖住的行（会话已经不带它们，比如被拿掉的消息）不给看，编号本身也答「没有」。
    const liveHere = new Set<number>();
    for (const row of got) if (!row.retired && row.refNum !== null) liveHere.add(row.refNum);
    const coveredHere = coveredRefsIn(session.state, lo, hi);
    const reachable = (n: number): boolean => liveHere.has(n) || coveredHere.has(n);
    if (!reachable(target)) return toolOk(`（没有 ${mref(target)} 这个编号；换一个结果里的 m 编号。）`);
    const s: SearchV2Settings = { ...settings, includeReasoning: false };
    const c = compileSettings(s);
    const labels = new Map<string, string>();
    const byRef = new Map<number, CorpusMessage>();
    // seq order: her visible text right after a desk message joins the desk
    const follow: { follow: FollowLane | null } = { follow: null };
    for (const row of [...got].sort((a, b) => a.seq - b.seq)) {
        if (row.retired && row.refNum !== null && liveHere.has(row.refNum)) continue;
        const msg = classifyRow(row, s, c, labels);
        applyFollow(follow, msg, c.ownerLabels);
        if (!msg) continue;
        if (!reachable(msg.ref)) continue; // G2 终审 I1（分道照旧按全部行走，和语料一样）
        const prev = byRef.get(msg.ref);
        if (!prev || (!prev.live && msg.live)) byRef.set(msg.ref, msg);
        else if (prev.live === msg.live) for (const l of msg.lines) if (!prev.lines.some((x) => x.text === l.text && x.speaker === l.speaker)) prev.lines.push(l);
    }
    const center = byRef.get(target);
    if (!center) return toolOk(`（${mref(target)} 不是对话或看过的东西（可能是工具回执或想法），没有前后可看；换一个结果里的 m 编号。）`);
    const lane = center.lane;
    const refs = [...byRef.keys()].filter((r) => byRef.get(r)!.lane === lane).sort((a, b) => a - b);
    const lineOf = (r: number): string => byRef.get(r)!.lines.map((l) => `${r === target ? "→ " : ""}${mref(r)} ${l.speaker ? `${l.speaker}：` : ""}${l.text}`).join("\n");
    const ci = refs.indexOf(target);
    const chosen = new Set<number>([target]);
    let used = lineOf(target).length;
    let L = ci - 1;
    let R = ci + 1;
    while ((L >= 0 && ci - L <= AROUND_EACH) || (R < refs.length && R - ci <= AROUND_EACH)) {
        let progressed = false;
        if (R < refs.length) {
            const t = lineOf(refs[R]!).length + 1;
            if (used + t <= AROUND_MAX_CHARS) { chosen.add(refs[R]!); used += t; progressed = true; }
            R++;
        }
        if (L >= 0) {
            const t = lineOf(refs[L]!).length + 1;
            if (used + t <= AROUND_MAX_CHARS) { chosen.add(refs[L]!); used += t; progressed = true; }
            L--;
        }
        if (!progressed && used >= AROUND_MAX_CHARS - 20) break;
    }
    let body = [...chosen].sort((a, b) => a - b).map(lineOf).join("\n");
    // fork（日期，D5）：前后的对话（中心那一路是 talk 才标）每行用自己的锚点加注记；超长要截的不标（截法按原话算）
    let datesLegend = "";
    let noted = false;
    if (fishDateNotesWanted() && center.kind === "talk" && body.length <= AROUND_MAX_CHARS) {
        const dn = openSearchDateNoter(session.id, session.state, rows, ext);
        if (dn) {
            const notedLine = (r: number): string => byRef.get(r)!.lines.map((l) => {
                const lt = l.speaker ? `${l.speaker}：${l.text}` : l.text;
                const nl = dn.line(null, lt, r, l.speaker, lt.length, Number.MAX_SAFE_INTEGER, l.noDates === true);
                return `${r === target ? "→ " : ""}${mref(r)} ${nl.text}`;
            }).join("\n");
            const nb = [...chosen].sort((a, b) => a - b).map(notedLine).join("\n");
            datesLegend = dn.legend();
            dn.done();
            if (datesLegend) { body = nb; noted = true; }
        }
    }
    if (body.length > AROUND_MAX_CHARS && !noted) body = `${safeSlice(body, 0, AROUND_MAX_CHARS)}……`;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query) {
        const hubs = new Set(s.hubs.map((h) => foldSameLength(h)));
        for (const u of queryUnits(foldSameLength(query))) {
            if (u.single && hubs.has(u.surfaces[0]!)) continue;
            const mk = noted ? markFirstOutside(body, u.surfaces[0]!) : markFirst(body, u.surfaces[0]!);
            if (mk !== body) { body = mk; break; }
        }
    }
    const label = center.laneLabel;
    // G2 复核 F6：有注记时正文会比 ${AROUND_MAX_CHARS} 字长（括号是加上去的），头行照实说；没有注记时这一行逐字节不变
    return toolOk(`${mref(target)} 前后（${label}，同一处的，最多 ${AROUND_MAX_CHARS} 字${noted ? "，日期括号另算" : ""}）：\n${body}${datesLegend ? `\n${datesLegend}` : ""}`);
}

// ------------------------------------------------------------ dispatch

const storeRowSource: RowSource = {
    page: (id, after, limit, skipKinds) => getStore().unifiedSearchRowsPage(id, after, limit, skipKinds),
    byRefRange: (id, lo, hi) => getStore().unifiedSearchRowsByRefRange(id, lo, hi),
};

/**
 * Entry from executeProxyToolAsync. Null ⇒ run the old path unchanged.
 * Only own-session searches are served (a foreign conversation_id keeps the
 * old read-only path).
 */
export async function maybeSearchV2(
    args: Record<string, unknown>,
    session: Session,
    lane: SearchLane | undefined,
    log: (m: string) => void,
    rows: RowSource = storeRowSource,
    ext: OccExtReader | null = fishOccExt,
): Promise<ProxyToolResult | null> {
    const requested = typeof args.conversation_id === "string" ? args.conversation_id.trim() : "";
    if (requested && requested !== session.id && requested.toLowerCase() !== "current") return null;
    const v2 = effectiveSearchV2(session);
    try {
        // fork（日期）：开着时先等 reldate 载好（核 sha；对不上就没有注记，结果和关着一样）
        if (fishDateNotesWanted()) await readyFishDateNotes();
        const around = typeof args.around === "string" ? args.around.trim() : "";
        if (around && lane?.around === true) {
            const s = v2 ?? resolveSearchV2Settings(lane.raw, typeof session.metadata.lastModel === "string" ? session.metadata.lastModel : undefined);
            const r = executeSearchAround(args, session, s, rows, ext);
            if (r) log(`[search-v2] around outcome=${r.outcome ?? "success"}`);
            return r;
        }
        if (!v2) return null;
        return await executeSearchContextV2(args, session, v2, { rows, log, aroundOn: lane?.around === true, ext });
    } catch (err) {
        log(`[search-v2] fell back to substring: ${err instanceof Error ? err.name : "error"}`);
        return null;
    }
}
