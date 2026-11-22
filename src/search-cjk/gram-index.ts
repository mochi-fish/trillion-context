/**
 * fork search v2 (11-20) — append-only BM25 index over CJK gram tokens.
 *
 * Postings are packed ints (docId * 16 + min(tf, 15)) in one plain array per
 * term — tf saturates long before 15 under k1 = 1.2, and the packing halves
 * the postings memory. Documents are only ever appended; a corpus that
 * shrinks (block reap, retirement) is rebuilt from scratch by the caller.
 * Scores are deterministic: no randomness, no clock, ties broken by docId.
 */

import { forEachIndexToken, type GramKey } from "./tokenize.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TF_CAP = 15;

/** A query group: alternatives that all satisfy the same concept (a unit, or
 *  an alias set). The group matches a doc when any alternative does. */
export interface QueryGroup {
    /** Alternatives as index keys; a multi-key alternative must match ALL of
     *  its keys (alias phrases: the bigrams of 我的世界). */
    alts: GramKey[][];
    /** Surface strings for excerpt marking / phrase checks. */
    surfaces: string[];
    /** Alias phrases verified verbatim in the doc text (lower-cased). */
    phrases?: string[];
    label: string;
}

export class GramIndex {
    private readonly dict = new Map<GramKey, number>();
    private readonly postings: number[][] = [];
    private readonly docLen: number[] = [];
    private totalLen = 0;

    get size(): number {
        return this.docLen.length;
    }

    get avgLen(): number {
        return this.docLen.length === 0 ? 0 : this.totalLen / this.docLen.length;
    }

    /** Add one document; returns its id (dense, 0-based). */
    add(text: string): number {
        const id = this.docLen.length;
        const tf = new Map<GramKey, number>();
        let len = 0;
        forEachIndexToken(text, (k) => {
            tf.set(k, (tf.get(k) ?? 0) + 1);
            len++;
        });
        for (const [k, n] of tf) {
            let t = this.dict.get(k);
            if (t === undefined) {
                t = this.postings.length;
                this.dict.set(k, t);
                this.postings.push([]);
            }
            this.postings[t]!.push(id * 16 + Math.min(n, TF_CAP));
        }
        this.docLen.push(len);
        this.totalLen += len;
        return id;
    }

    /** Document frequency of one key. */
    df(key: GramKey): number {
        const t = this.dict.get(key);
        return t === undefined ? 0 : this.postings[t]!.length;
    }

    /** BM25 idf (always > 0). */
    idf(df: number): number {
        const N = this.docLen.length;
        return Math.log(1 + (N - df + 0.5) / (df + 0.5));
    }

    /** tf of `key` in each doc that has it (docId → tf). */
    private tfMap(key: GramKey): Map<number, number> {
        const out = new Map<number, number>();
        const t = this.dict.get(key);
        if (t === undefined) return out;
        for (const p of this.postings[t]!) out.set(p >> 4, p & 15);
        return out;
    }

    docLength(id: number): number {
        return this.docLen[id] ?? 0;
    }

    /**
     * Candidate docs for the groups: every doc matching at least one group,
     * with the per-group tf (an alternative's tf = the min tf over its keys —
     * a cheap upper bound for an alias phrase; the caller verifies phrases).
     */
    match(groups: QueryGroup[]): Map<number, number[]> {
        const out = new Map<number, number[]>();
        groups.forEach((g, gi) => {
            for (const alt of g.alts) {
                if (alt.length === 0) continue;
                let acc: Map<number, number> | null = null;
                for (const key of alt) {
                    const m = this.tfMap(key);
                    if (acc === null) acc = m;
                    else {
                        const next = new Map<number, number>();
                        for (const [d, n] of m) {
                            const prev: number | undefined = acc.get(d);
                            if (prev !== undefined) next.set(d, Math.min(prev, n));
                        }
                        acc = next;
                    }
                    if (acc.size === 0) break;
                }
                if (!acc) continue;
                for (const [d, n] of acc) {
                    let row = out.get(d);
                    if (!row) {
                        row = new Array<number>(groups.length).fill(0);
                        out.set(d, row);
                    }
                    if (n > row[gi]!) row[gi] = n;
                }
            }
        });
        return out;
    }

    /** Group df: docs matching any alternative (upper bound for phrases). */
    groupDf(g: QueryGroup): number {
        const docs = new Set<number>();
        for (const alt of g.alts) {
            if (alt.length === 0) continue;
            // min-df key of the alternative bounds the alternative's df
            let bestKey: GramKey | null = null;
            let bestDf = Infinity;
            for (const k of alt) {
                const d = this.df(k);
                if (d < bestDf) { bestDf = d; bestKey = k; }
            }
            if (bestKey === null || bestDf === 0) continue;
            const t = this.dict.get(bestKey)!;
            for (const p of this.postings[t]!) docs.add(p >> 4);
        }
        return docs.size;
    }

    /** BM25 term weight for one (tf, doc) pair. */
    tfWeight(tf: number, docId: number): number {
        if (tf <= 0) return 0;
        const avg = this.avgLen || 1;
        const len = this.docLen[docId] ?? avg;
        return (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / avg));
    }
}
