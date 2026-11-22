// fork search v2 (11-20) — E1: the synthetic Chinese companion bench
// (research1119 search.md §8). 60 blocks / 1,500 messages of invented chat
// (bridge headers, onebot envelopes, group friends, desk notes, MC / B站 /
// file results) plus noise the corpus must ignore (acp receipts, sts JSON,
// reasoning, host notices, media paths, a retired duplicate generation),
// ≈120 queries in 11 categories. The gates below are the plan's acceptance
// numbers; the old substring path runs on the same state for comparison.
import test from "node:test";
import assert from "node:assert/strict";
import { buildZhFixture, ZH_QUERIES, ZH_SETTINGS, type ZhQuery } from "./helpers/search-zh-fixture.ts";
import { ensureCorpus, type Corpus } from "../src/search-cjk/corpus.ts";
import { resolveSearchV2Settings } from "../src/search-cjk/settings.ts";
import { renderSearch } from "../src/search-v2.ts";
import { executeSearchContext } from "../src/decompress-shared.ts";

interface Item { block: string; lo: number; hi: number; excerpt: string }

function parseItems(out: string): Item[] {
    const items: Item[] = [];
    let cur: Item | null = null;
    for (const line of out.split("\n")) {
        const m = /^\[\d+\] (b\d+) · .*? · m(\d+)(?:–m(\d+))?/.exec(line);
        if (m) {
            cur = { block: m[1]!, lo: Number(m[2]), hi: Number(m[3] ?? m[2]), excerpt: "" };
            items.push(cur);
            continue;
        }
        if (cur && line.startsWith("  ")) cur.excerpt += line.slice(2).replace(/[【】]/g, "") + "\n";
        else cur = null;
    }
    return items;
}

const fx = buildZhFixture();
const settings = resolveSearchV2Settings(ZH_SETTINGS, "deepseek-flash");
let corpus: Corpus;

test("E1 setup: corpus builds from the synthetic rows", async () => {
    const t0 = Date.now();
    corpus = (await ensureCorpus(fx.sessionId, fx.state, settings, { rows: fx.source }))!;
    assert.ok(corpus, "corpus built");
    assert.ok(corpus.windows.length > 50, `windows: ${corpus.windows.length}`);
    // noise never enters the corpus
    const all = corpus.windows.map((w) => w.text).join("\n");
    for (const bad of ["acp_status", "Jaw Worm", "Time sampled", "AppData", "滑雪板", "<user_message", "qq:private", "10001", "·成员", "[@我]", "受限用户", "(30000)", "(30003)"]) {
        assert.ok(!all.includes(bad), `corpus must not contain ${bad}`);
    }
    console.log(`[e1] windows=${corpus.windows.length} chars=${corpus.chars} build_ms=${Date.now() - t0}`);
});

interface Res { q: ZhQuery; newHit: boolean; newEx: boolean; oldHit: boolean; noHitNew: boolean; noHitOld: boolean; chars: number; ms: number }

function runAll(promiseFlip: boolean): Res[] {
    const s = { ...settings, promiseFlip };
    const out: Res[] = [];
    for (const q of ZH_QUERIES) {
        const t0 = process.hrtime.bigint();
        const r = renderSearch(q.q, s.maxHits, corpus, fx.state, s);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const items = parseItems(r.out).slice(0, 5);
        const ref = q.fact ? fx.factRef.get(q.fact)! : -1;
        const hitItems = items.filter((it) => ref >= it.lo && ref <= it.hi);
        const newHit = hitItems.length > 0;
        const newEx = !!q.answer && items.some((it) => it.excerpt.includes(q.answer!));
        const old = executeSearchContext({ query: q.q, limit: 5 }, undefined as never, fx.state, undefined, undefined, () => fx.originals);
        const oldHit = !!q.fact && new RegExp(`(^|\\n)${fx.factBlock.get(q.fact)} `).test(old.text);
        out.push({ q, newHit, newEx, oldHit, noHitNew: r.hits === 0 && r.summaries === 0, noHitOld: old.text.startsWith("[No blocks matched"), chars: r.out.length, ms });
    }
    return out;
}

const rate = (xs: boolean[]): number => (xs.length === 0 ? 0 : xs.filter(Boolean).length / xs.length);
const p95 = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0; };

test("E1 gates (promiseFlip off)", () => {
    const res = runAll(false);
    const by = (c: string): Res[] => res.filter((r) => r.q.cat === c);
    const table: Record<string, string> = {};
    for (const c of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "k"]) {
        const rs = by(c);
        table[c] = `n=${rs.length} R@5 new=${rate(rs.map((r) => r.newHit)).toFixed(2)} old=${rate(rs.map((r) => r.oldHit)).toFixed(2)} excerpt@5=${rate(rs.map((r) => r.newEx)).toFixed(2)}`;
    }
    const j = by("j");
    table.j = `n=${j.length} no-hit new=${rate(j.map((r) => r.noHitNew)).toFixed(2)} old=${rate(j.map((r) => r.noHitOld)).toFixed(2)}`;
    const gated = res.filter((r) => "abcdefghk".includes(r.q.cat));
    table.all = `R@5(a–h,k)=${rate(gated.map((r) => r.newHit)).toFixed(2)} excerpt@5=${rate(gated.map((r) => r.newEx)).toFixed(2)} chars_p95=${p95(res.map((r) => r.chars))} ms_p95=${p95(res.map((r) => r.ms)).toFixed(1)}`;
    for (const [k, v] of Object.entries(table)) console.log(`[e1] ${k}: ${v}`);
    // misses (ids only — synthetic data)
    const misses = gated.filter((r) => !r.newHit).map((r) => `${r.q.cat}:${r.q.fact}`);
    if (misses.length) console.log(`[e1] misses: ${misses.join(" ")}`);
    const exMiss = gated.filter((r) => r.newHit && !r.newEx).map((r) => `${r.q.cat}:${r.q.fact}`);
    if (exMiss.length) console.log(`[e1] excerpt misses: ${exMiss.join(" ")}`);
    const jMiss = res.filter((r) => r.q.cat === "j" && !r.noHitNew).map((r) => ZH_QUERIES.indexOf(r.q));
    if (jMiss.length) console.log(`[e1] j false hits (query index): ${jMiss.join(" ")}`);

    for (const c of ["a", "b", "c", "e", "f", "g", "h", "k"]) assert.ok(rate(by(c).map((r) => r.newHit)) >= 0.9, `${c} R@5 ≥ 0.90: ${table[c]}`);
    assert.ok(rate(by("d").map((r) => r.newHit)) >= 0.85, `d R@5 ≥ 0.85: ${table.d}`);
    assert.ok(rate(gated.map((r) => r.newEx)) >= 0.85, `excerpt@5 ≥ 0.85: ${table.all}`);
    assert.ok(rate(by("f").map((r) => r.newHit)) >= rate(by("f").map((r) => r.oldHit)) + 0.3 || rate(by("f").map((r) => r.newHit)) === 1, `f beats old by 0.3: ${table.f}`);
    assert.ok(rate(j.map((r) => r.noHitNew)) >= 0.95, `no-hit accuracy ≥ 0.95: ${table.j}`);
    assert.ok(p95(res.map((r) => r.chars)) <= 2000, `result p95 ≤ 2000 chars: ${table.all}`);
    assert.ok(p95(res.map((r) => r.ms)) <= 50, `query p95 ≤ 50 ms: ${table.all}`);
    // promise twins: both halves of each pair
    const g = by("g");
    const pairs = [[0, 1], [2, 3], [4, 5], [6, 7]].map(([x, y]) => g[x!]!.newHit && g[y!]!.newHit);
    assert.ok(rate(pairs) >= 0.8, `g twins both found ≥ 0.8`);
});

test("E1 promiseFlip on: g twins and the rest stay within the gates", () => {
    const res = runAll(true);
    const g = res.filter((r) => r.q.cat === "g");
    console.log(`[e1] promiseFlip on: g R@5=${rate(g.map((r) => r.newHit)).toFixed(2)} excerpt@5=${rate(g.map((r) => r.newEx)).toFixed(2)}`);
    const pairs = [[0, 1], [2, 3], [4, 5], [6, 7]].map(([x, y]) => g[x!]!.newHit && g[y!]!.newHit);
    assert.ok(rate(pairs) >= 0.8);
    const j = res.filter((r) => r.q.cat === "j");
    assert.ok(rate(j.map((r) => r.noHitNew)) >= 0.95);
});

test("E1 determinism: same query, same corpus → same bytes", () => {
    for (const q of ZH_QUERIES.slice(0, 30)) {
        const a = renderSearch(q.q, 5, corpus, fx.state, settings).out;
        const b = renderSearch(q.q, 5, corpus, fx.state, settings).out;
        assert.equal(a, b);
    }
});

test("E1 output hygiene: Chinese, no XML-like tags, no 他, no paths, no ids", () => {
    for (const q of ZH_QUERIES) {
        const out = renderSearch(q.q, 5, corpus, fx.state, settings).out;
        assert.ok(!/<\/?[A-Za-z][\w:-]*[\s>]/.test(out), `no tags: ${q.q}`);
        assert.ok(!/(?<![吉其])他/.test(out), `no 他 (吉他 / 其他 are words): ${q.q}`);
        assert.ok(!/[A-Za-z]:\\|AppData|\/Users\//.test(out), `no paths: ${q.q}`);
        assert.ok(!out.includes("10001") && !out.includes("qq:private") && !out.includes("qq:group"), `no chat ids: ${q.q}`);
    }
});
