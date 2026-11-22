/**
 * fork search v2 (11-20) — excerpt budget and span selection.
 *
 * allocateExcerptBudget: fair water-filling (shortest natural lengths are
 * served in full, the rest split what is left; never below the floor — if
 * the floor does not fit, the lowest-ranked hits are dropped instead). The
 * idea follows Suzu's allocateTextLengths; clean-room.
 *
 * bestSpan: the window of a given length covering the largest summed idf of
 * DISTINCT matched groups (ties → the earliest start). Hub words are never
 * query units, so a span can never be anchored on one.
 */

import { foldSameLength } from "./tokenize.js";

export interface SpanHit {
    pos: number;
    len: number;
    group: number;
    idf: number;
}

/** Fair split of `budget` chars over hits (natural lengths in rank order).
 *  Returns one length per hit; 0 = dropped. */
export function allocateExcerptBudget(natural: readonly number[], budget: number, floor = 60, cap = 400): number[] {
    const out = natural.map(() => 0);
    let k = natural.length;
    // drop lowest-ranked hits until every survivor can get the floor
    while (k > 0 && k * floor > budget) k--;
    const live = natural.slice(0, k).map((n, i) => ({ i, n: Math.max(1, n) }));
    live.sort((a, b) => a.n - b.n || a.i - b.i);
    let left = budget;
    let rem = live.length;
    for (const { i, n } of live) {
        const share = Math.floor(left / rem);
        rem--;
        const v = Math.min(n, cap, Math.max(floor, share));
        out[i] = v;
        left -= v;
    }
    return out;
}

/** All occurrences of each surface in `lower` (a lower-cased text). */
export function findHits(lower: string, groups: ReadonlyArray<{ surfaces: string[]; idf: number }>): SpanHit[] {
    const hits: SpanHit[] = [];
    groups.forEach((g, gi) => {
        for (const s of g.surfaces) {
            if (!s) continue;
            let from = 0;
            for (;;) {
                const at = lower.indexOf(s, from);
                if (at === -1) break;
                hits.push({ pos: at, len: s.length, group: gi, idf: g.idf });
                from = at + 1;
                if (hits.length > 4000) return;
            }
        }
    });
    hits.sort((a, b) => a.pos - b.pos || b.len - a.len || a.group - b.group);
    return hits;
}

function coverScore(hits: readonly SpanHit[], start: number, end: number): number {
    const seen = new Set<number>();
    let s = 0;
    for (const h of hits) {
        if (h.pos < start) continue;
        if (h.pos + h.len > end) break;
        if (seen.has(h.group)) continue;
        seen.add(h.group);
        s += h.idf;
    }
    return s;
}

/** Best [start, end) of length `len` in a text of length `total`. */
export function bestSpan(hits: readonly SpanHit[], total: number, len: number): { start: number; end: number; score: number } {
    if (len >= total || hits.length === 0) return { start: 0, end: Math.min(total, len), score: coverScore(hits, 0, Math.min(total, len)) };
    let best = { start: 0, end: len, score: -1 };
    const tryAt = (s0: number): void => {
        const s = Math.max(0, Math.min(total - len, s0));
        const sc = coverScore(hits, s, s + len);
        if (sc > best.score || (sc === best.score && s < best.start)) best = { start: s, end: s + len, score: sc };
    };
    for (const h of hits) {
        tryAt(h.pos - Math.floor((len - h.len) / 2));
        tryAt(h.pos - 8);
        tryAt(h.pos + h.len + 8 - len);
    }
    return best;
}

/** Shortest span covering the best cluster (within `cap`), widened to the
 *  nearest sentence/line boundaries (at most `widen` chars each side). */
export function naturalSpan(text: string, hits: readonly SpanHit[], cap: number, widen = 20): { start: number; end: number } {
    if (hits.length === 0) return { start: 0, end: Math.min(text.length, 80) };
    const b = bestSpan(hits, text.length, cap);
    let lo = Infinity;
    let hi = -Infinity;
    const seen = new Set<number>();
    for (const h of hits) {
        if (h.pos < b.start || h.pos + h.len > b.end) continue;
        if (seen.has(h.group)) continue;
        seen.add(h.group);
        lo = Math.min(lo, h.pos);
        hi = Math.max(hi, h.pos + h.len);
    }
    if (!Number.isFinite(lo)) { lo = b.start; hi = Math.min(b.end, b.start + 80); }
    let s = lo;
    const sMin = Math.max(0, lo - widen);
    while (s > sMin && !isBoundary(text.charCodeAt(s - 1))) s--;
    let e = hi;
    const eMax = Math.min(text.length, hi + widen);
    while (e < eMax && !isBoundary(text.charCodeAt(e - 1))) e++;
    while (e > s && text.charCodeAt(e - 1) === 0x0a) e--;
    return { start: s, end: e };
}

function isBoundary(c: number): boolean {
    // 。！？；… newline, ASCII .!?;
    return c === 0x3002 || c === 0xff01 || c === 0xff1f || c === 0xff1b || c === 0x2026 || c === 0x0a || c === 0x2e || c === 0x21 || c === 0x3f || c === 0x3b;
}

/** Code-unit-safe slice (never leaves a lone surrogate at an edge). */
export function safeSlice(text: string, start: number, end: number): string {
    let s = Math.max(0, start);
    let e = Math.min(text.length, end);
    if (s > 0 && s < text.length) {
        const c = text.charCodeAt(s);
        if (c >= 0xdc00 && c <= 0xdfff) s += 1;
    }
    if (e > 0 && e < text.length) {
        const c = text.charCodeAt(e - 1);
        if (c >= 0xd800 && c <= 0xdbff) e -= 1;
    }
    return text.slice(s, e);
}

/** Wrap the first occurrence of `needle` (folded match) in 【】. The fold
 *  keeps every offset (İ, full-width letters), so the mark lands on the
 *  matched characters of the original text. */
export function markFirst(text: string, needle: string): string {
    if (!needle) return text;
    const at = foldSameLength(text).indexOf(needle);
    if (at === -1) return text;
    return text.slice(0, at) + "【" + text.slice(at, at + needle.length) + "】" + text.slice(at + needle.length);
}
