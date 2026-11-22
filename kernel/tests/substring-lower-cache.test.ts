/**
 * fork S0 (11-20): the substring channel reads a lower-case-only memo
 * (docLower) instead of building the full docFeatures set. Pins: scores are
 * bit-identical to counting on text.toLowerCase(), the substring channel no
 * longer fills the docFeatures cache, the memo hands back the same string on
 * a repeat, and clearDocFeatures() drops it too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { clearDocFeatures, docCacheInfo, searchBlocks, type SearchDoc } from "../src/index.js";
import { docLower } from "../src/search/doc-cache.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALPHABET = ["兔", "药", "拿", "周", "三", "A", "b", "Auth", " ", "\n", "😀", "İ", "ß", "Σ", "token", "TOKEN", "缓存", "命中"];

function refCount(text: string, query: string): number {
  const terms = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
  const hay = text.toLowerCase();
  let n = 0;
  for (const t of terms) n += hay.split(t).length - 1;
  return n;
}

test("substring scores equal counting on text.toLowerCase() (random mixed corpora)", () => {
  const rnd = lcg(1120);
  for (let round = 0; round < 40; round++) {
    clearDocFeatures();
    const docs: SearchDoc[] = [];
    for (let i = 0; i < 12; i++) {
      let t = "";
      const len = 5 + Math.floor(rnd() * 60);
      for (let k = 0; k < len; k++) t += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      docs.push({ kind: "block", ref: `b${i}`, text: t, blockId: `b${i}`, tier: 1 });
    }
    for (const q of ["兔", "auth token", "缓存 命中", "İ", "ß σ", "😀", "三 周"]) {
      const got = searchBlocks(docs, q, { limit: docs.length, algorithm: "substring", minScore: 1e-9 });
      const want = docs
        .map((d) => ({ ref: d.ref, score: refCount(d.text, q) }))
        .filter((x) => x.score >= 1e-9);
      const gotMap = new Map(got.map((r) => [r.ref, r.score]));
      for (const w of want) assert.equal(gotMap.get(w.ref), w.score, `round ${round} q=${q} ref=${w.ref}`);
      assert.equal(got.length, want.length);
      // a second call (memo warm) is identical
      const again = searchBlocks(docs, q, { limit: docs.length, algorithm: "substring", minScore: 1e-9 });
      assert.deepEqual(again, got);
    }
  }
});

test("the substring channel no longer fills the docFeatures cache", () => {
  clearDocFeatures();
  const before = docCacheInfo().entries;
  const docs: SearchDoc[] = [{ kind: "block", ref: "b1", text: "缓存命中 cache hit", blockId: "b1", tier: 1 }];
  searchBlocks(docs, "cache", { algorithm: "substring", minScore: 1e-9 });
  assert.equal(docCacheInfo().entries, before);
});

test("docLower: memoized, and cleared with clearDocFeatures()", () => {
  clearDocFeatures();
  const text = "Hello 世界 ÀÉÎ".repeat(3);
  const a = docLower(text);
  const b = docLower(text);
  assert.equal(a, text.toLowerCase());
  assert.equal(a, b);
  clearDocFeatures();
  assert.equal(docLower(text), text.toLowerCase());
  assert.equal(docLower(""), "");
});
