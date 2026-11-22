// fork（日期，D2–D5，合并那一轮 local/fish-1120）：相对日期注记。只用合成数据。
//   1. reldate：src/fish/reldate.mjs 的 sha 和正本、记录、加载器里写死的那个一致；共用用例（fish-dsh
//      sessionless/reldate/reldate-cases.json 的逐字节拷贝）除 row 那组外全过（row 要 anchor-from-row.mjs，
//      那是桥 / 核心的，fork 不带）；sha 不对 / 文件不在 → 模块不载，注记整条不启用。
//   2. 配置：顶层 fish.dateNotes 严格解析；loadOptions 认它；写坏整块当没写。
//   3. B 档：重铸潮、同一请求、LNDS、区间。
//   4. search_context（cjk）：关着时和这一包之前逐字节一样；开着时只多注记和一行图例（去掉以后逐字节一样）；
//      A 档优先于 B 档；群里近况那种带钟点的行按行钉；只标对话；sha 不对时和关着一样；around 同理。
//   5. decompress：正文逐段认（ref 标签 / 统一库逐字对上），只标对话和她用 im_send 说的话；
//      真走 resolveDecompress 时临时文件开头写图例；关着时一个字节不变。
//   6. D4：recordOccurrence 关着时 session_ext 一个 fish:occ:* 都不写（真起代理）；开着时写当地月的键。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.BILI_PERSIST = "0";

import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { RELDATE_SHA256, loadRelDate, relDateModule, relDateLoadState, _loadRelDateFromForTest, _resetRelDateForTest, type RelDateModule } from "../src/fish/reldate-load.ts";
import { DATE_NOTES_DEFAULTS, parseFishSettings, type DateNotesSettings } from "../src/fish/date-notes-settings.ts";
import { setFishDateNotes, fishDateNotesWanted, fishOccRecordOn, fishDateNotesHealthField, openResultNoter, openSearchDateNoter, noteDecompressBody, noteDecompress, markFirstOutside, lineShape, _resetDateNotesForTest, type CoveredMessage } from "../src/fish/date-notes.ts";
import { bTierAnchors, openOccLookup, readOccShards, readBackfill, _resetOccurrenceForTest, type TimelineEntry } from "../src/fish/occurrence.ts";
import { recordOccurrences, occMonthKey, _resetOccLedgerForTest } from "../src/fish/occ-ledger.ts";
import { loadOptions } from "../src/config.ts";
import { resolveSearchV2Settings } from "../src/search-cjk/settings.ts";
import { clearSearchCorpora, type RowSource } from "../src/search-cjk/corpus.ts";
import { maybeSearchV2, storeEffectiveSearchV2 } from "../src/search-v2.ts";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { getSession } from "../src/session.ts";
import { getStore, _setStoreForTest } from "../src/persist.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges } from "../src/stream.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { ZH_SETTINGS, OWNER_ID, PRIVATE_LANE } from "./helpers/search-zh-fixture.ts";
import type { SearchRow } from "../src/storage/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TZ = 540;
const MIN = 60_000;
/** 当地墙钟（+9）→ 毫秒 */
const L = (y: number, mo: number, d: number, h: number, mi: number): number => Date.UTC(y, mo - 1, d, h, mi) - TZ * MIN;
const ON: DateNotesSettings = { ...DATE_NOTES_DEFAULTS, enabled: true };

async function mod(): Promise<RelDateModule> {
    const m = await loadRelDate();
    assert.ok(m, `reldate 载入：${relDateLoadState()}`);
    return m;
}

// ---------------------------------------------------------------- 1. reldate

test("reldate：拷贝的 sha = 记录 = 加载器写死的；共用用例（除 row）全过", async () => {
    const bytes = readFileSync(path.join(ROOT, "src", "fish", "reldate.mjs"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha, RELDATE_SHA256);
    assert.equal(readFileSync(path.join(ROOT, "src", "fish", "reldate.sha256"), "utf8").trim().split(/\s+/)[0], sha);
    _resetRelDateForTest();
    const m = await mod();
    assert.equal(relDateLoadState(), "ok");
    assert.equal(m.RELDATE_VERSION, "2");
    assert.ok(!/他/.test(m.RELDATE_LEGEND), "图例里没有「他」");
    const cases = JSON.parse(readFileSync(path.join(HERE, "fixtures", "reldate-cases.json"), "utf8")) as Record<string, unknown> & { tzOffsetMin: number; defaultAt: string };
    const tz0 = cases.tzOffsetMin;
    const localMs = (s: string, tz = tz0): number => {
        const x = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s)!;
        return Date.UTC(+x[1]!, +x[2]! - 1, +x[3]!, +x[4]!, +x[5]!) - tz * MIN;
    };
    type C = Record<string, unknown> & { id: string };
    const anchorOf = (c: C): unknown => {
        const tz = (c.tz as number | undefined) ?? tz0;
        if ("anchor" in c) return c.anchor;
        if ("atMs" in c) return { at: c.atMs };
        if (c.lo) return { lo: localMs(c.lo as string, tz), hi: localMs(c.hi as string, tz) };
        return { at: localMs((c.at as string | undefined) ?? cases.defaultAt, tz) };
    };
    const optsOf = (c: C) => ({ ...((c.opts as object | undefined) ?? {}), tzOffsetMin: (c.tz as number | undefined) ?? tz0 });
    const skipKeys = (c: C): string[] => (c.skip === undefined ? [] : Array.isArray(c.skip) ? (c.skip as string[]) : [c.skip as string]);
    const bad: string[] = [];
    let n = 0;
    const check = (c: C, r: { text: string; hits: unknown[]; skips: Record<string, number> }): void => {
        n++;
        const errs: string[] = [];
        if (r.text !== c.want) errs.push(`text ${JSON.stringify(r.text)}`);
        for (const k of skipKeys(c)) if (!((r.skips[k] ?? 0) >= 1)) errs.push(`skip ${k}`);
        if (c.none && (r.hits.length || Object.keys(r.skips).length)) errs.push("none");
        if (c.hits !== undefined && r.hits.length !== c.hits) errs.push(`hits ${r.hits.length}`);
        for (const k of Object.keys(r.skips)) if (!m.RELDATE_SKIP_KEYS.includes(k)) errs.push(`unknown skip ${k}`);
        if (errs.length) bad.push(`${c.id}: ${errs.join("; ")}`);
    };
    for (const c of cases.annotate as C[]) check(c, m.annotateText(c.text as string, anchorOf(c) as never, optsOf(c)));
    for (const c of cases.window as C[]) check(c, m.annotateWindow(c.text as string, (c.win as number[])[0]!, (c.win as number[])[1]!, anchorOf(c) as never, optsOf(c)));
    for (const c of cases.pin as C[]) {
        n++;
        const got = m.pinClock(localMs(c.ref as string), c.hh as number, c.mm as number, tz0, (c.maxBackMin as number | undefined) ?? 360);
        const want = c.want === null ? null : localMs(c.want as string);
        if (got !== want) bad.push(`${c.id}: pin ${got}`);
    }
    for (const c of cases.localParts as C[]) {
        n++;
        const tz = (c.tz as number | undefined) ?? tz0;
        const p = m.localParts(localMs(c.at as string, tz), tz) as unknown as Record<string, number>;
        if (!Object.entries(c.want as Record<string, number>).every(([k, v]) => p[k] === v)) bad.push(`${c.id}: local`);
    }
    for (const c of cases.resolve as C[]) {
        n++;
        const r = m.resolveAnchor(anchorOf(c) as never, tz0) as unknown as Record<string, unknown> | null;
        const ok = c.want === null ? r === null : r !== null && Object.entries(c.want as Record<string, unknown>).every(([k, v]) => r[k] === v);
        if (!ok) bad.push(`${c.id}: resolve`);
    }
    for (const c of cases.strip as C[]) {
        n++;
        if (m.stripRelDates(c.text as string) !== c.want) bad.push(`${c.id}: strip`);
    }
    assert.deepEqual(bad, [], `共用用例失败 ${bad.length}/${n}`);
    const rows = (cases.row as unknown[]).length;
    assert.equal(n, (cases.annotate as unknown[]).length + (cases.window as unknown[]).length + (cases.pin as unknown[]).length + (cases.localParts as unknown[]).length + (cases.resolve as unknown[]).length + (cases.strip as unknown[]).length);
    assert.ok(n >= 360 && rows >= 1, `跑了 ${n} 条，row ${rows} 条不在 fork 跑`);
});

test("reldate：sha 不对 → 不载（sha-mismatch）；文件不在 → missing；之后正常载回来", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fish-dates-sha-"));
    try {
        const bad = path.join(dir, "reldate.mjs");
        const bytes = readFileSync(path.join(ROOT, "src", "fish", "reldate.mjs"));
        writeFileSync(bad, Buffer.concat([bytes, Buffer.from("\n")]));
        let r = await _loadRelDateFromForTest([bad]);
        assert.equal(r.mod, null);
        assert.equal(r.state, "sha-mismatch");
        assert.equal(relDateModule(), null);
        r = await _loadRelDateFromForTest([path.join(dir, "absent.mjs")]);
        assert.equal(r.state, "missing");
        const good = path.join(dir, "good.mjs");
        copyFileSync(path.join(ROOT, "src", "fish", "reldate.mjs"), good);
        r = await _loadRelDateFromForTest([path.join(dir, "absent.mjs"), good]);
        assert.equal(r.state, "ok");
    } finally {
        _resetRelDateForTest();
        await loadRelDate();
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------- 2. 配置

test("配置：fish.dateNotes 严格解析，写坏整块当没写；loadOptions 认它，没写 = 不带键", () => {
    assert.deepEqual(parseFishSettings(undefined), { problems: [] });
    assert.deepEqual(parseFishSettings({ dateNotes: { enabled: true } }).fish, { dateNotes: { ...DATE_NOTES_DEFAULTS, enabled: true } });
    assert.deepEqual(parseFishSettings({ dateNotes: { maxPerResult: 10, tzOffsetMin: -300, recordOccurrence: true } }).fish?.dateNotes, { ...DATE_NOTES_DEFAULTS, maxPerResult: 10, tzOffsetMin: -300, recordOccurrence: true });
    for (const bad of [{ dateNotes: { enabled: "yes" } }, { dateNotes: { maxPerSnippet: 0 } }, { dateNotes: { tzOffsetMin: 541.5 } }, { dateNotes: { nightEndHour: 13 } }, { dateNotes: { enabled: true, colour: 1 } }, { other: 1 }, { dateNotes: [] }, "x"]) {
        const r = parseFishSettings(bad);
        assert.equal(r.fish, undefined, JSON.stringify(bad));
        assert.ok(r.problems.length > 0);
    }
    const dir = mkdtempSync(path.join(tmpdir(), "fish-dates-cfg-"));
    const saved = process.env.BILI_CONFIG_FILE;
    try {
        const f = path.join(dir, "billion-context.json");
        process.env.BILI_CONFIG_FILE = f;
        writeFileSync(f, JSON.stringify({ fish: { dateNotes: { enabled: true, maxPerResult: 12 } } }));
        assert.deepEqual(loadOptions().fish, { dateNotes: { ...DATE_NOTES_DEFAULTS, enabled: true, maxPerResult: 12 } });
        writeFileSync(f, JSON.stringify({ fish: { dateNotes: { enabled: 1 } } }));
        assert.equal("fish" in loadOptions(), false, "写坏 = 不带键（全关）");
        writeFileSync(f, JSON.stringify({ log: false }));
        assert.equal("fish" in loadOptions(), false, "没写 = 不带键");
    } finally {
        if (saved === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = saved;
        rmSync(dir, { recursive: true, force: true });
    }
    _resetDateNotesForTest();
    assert.equal(fishDateNotesWanted(), false);
    assert.equal(fishOccRecordOn(), false);
    assert.deepEqual(fishDateNotesHealthField(), {}, "关着时 health 不多键");
    setFishDateNotes(ON);
    assert.equal(fishDateNotesWanted(), true);
    assert.equal(fishOccRecordOn(), false);
    assert.ok("dateNotes" in fishDateNotesHealthField());
    _resetDateNotesForTest();
});

// ---------------------------------------------------------------- 3. B 档

const E = (ref: number, asst: boolean, ts: number | null): TimelineEntry => ({ ref, asst, ts });

test("B 档：别人的话用自己的章；她的回复是 [请求时刻, min(+20 分钟, 自己的章, 后一个可信点)]", () => {
    const t0 = L(2026, 11, 18, 20, 0);
    const b = bTierAnchors([E(1, false, t0), E(2, true, t0 + 5 * MIN), E(3, false, t0 + 5 * MIN), E(4, true, t0 + 60 * MIN), E(5, false, t0 + 60 * MIN)]);
    assert.deepEqual(b.get(1), { at: t0 });
    assert.deepEqual(b.get(2), { lo: t0, hi: t0 + 5 * MIN });
    assert.deepEqual(b.get(3), { at: t0 + 5 * MIN });
    assert.deepEqual(b.get(4), { lo: t0 + 5 * MIN, hi: t0 + 25 * MIN }, "最多 20 分钟");
    assert.deepEqual(b.get(5), { at: t0 + 60 * MIN });
});

test("B 档：17 条以上 30 毫秒内的重铸潮整段不信；同一批里 assistant 不在最前面也不信", () => {
    const t0 = L(2026, 11, 18, 9, 0);
    const wave: TimelineEntry[] = [E(1, false, t0)];
    for (let i = 0; i < 18; i++) wave.push(E(2 + i, i % 2 === 1, t0 + 3 * 60 * MIN + i));
    wave.push(E(30, false, t0 + 4 * 60 * MIN));
    const b = bTierAnchors(wave);
    assert.deepEqual(b.get(1), { at: t0 });
    for (let i = 0; i < 18; i += 2) assert.deepEqual(b.get(2 + i), { lo: t0, hi: t0 + 4 * 60 * MIN }, "潮里的别人的话只剩前后可信点夹出的区间");
    assert.deepEqual(b.get(30), { at: t0 + 4 * 60 * MIN });
    const mixed = bTierAnchors([E(1, false, t0), E(2, false, t0 + MIN), E(3, true, t0 + MIN + 5), E(4, false, t0 + 2 * MIN)]);
    assert.equal("at" in (mixed.get(2) ?? {}), false, "user 后面跟着 assistant 的同一批不信");
    assert.deepEqual(mixed.get(4), { at: t0 + 2 * MIN });
});

test("B 档：早到的章（内容相同共用 id）被 LNDS 剔掉，夹在前后两个可信点之间", () => {
    const t0 = L(2026, 11, 18, 10, 0);
    const b = bTierAnchors([E(1, false, t0), E(2, false, t0 + MIN), E(3, false, t0 - 3 * 24 * 60 * MIN), E(4, false, t0 + 2 * MIN)]);
    assert.deepEqual(b.get(1), { at: t0 });
    assert.deepEqual(b.get(2), { at: t0 + MIN });
    assert.deepEqual(b.get(3), { lo: t0 + MIN, hi: t0 + 2 * MIN });
    assert.deepEqual(b.get(4), { at: t0 + 2 * MIN });
    assert.equal(bTierAnchors([E(1, false, null), E(2, true, null)]).size, 0, "没有章 = 没有锚点");
});

test("A / A2 档：session_ext 的 fish:occ:* 和回填文件；值不对的不认", () => {
    const m = readOccShards("s", { list: () => [{ key: "fish:occ:202611", value: { v: 1, m: { a: 5, b: -1, c: "x" } }, updatedAt: 0 }, { key: "fish:occ:202610", value: JSON.stringify({ v: 1, m: { d: 7 } }), updatedAt: 0 }, { key: "other", value: { v: 1, m: { e: 9 } }, updatedAt: 0 }, { key: "fish:occ:bad", value: { v: 2, m: { f: 1 } }, updatedAt: 0 }] });
    assert.deepEqual([...m.entries()].sort(), [["a", 5], ["d", 7]]);
    const dup = readOccShards("s", { list: () => [{ key: "fish:occ:202612", value: { v: 1, m: { a: 9 } }, updatedAt: 0 }, { key: "fish:occ:202611", value: { v: 1, m: { a: 5 } }, updatedAt: 0 }] });
    assert.equal(dup.get("a"), 5, "两个月份键都有时认早的");
    assert.equal(readOccShards("s", null).size, 0);
    assert.equal(readOccShards("s", { list: () => { throw new Error("x"); } }).size, 0);
    const dir = mkdtempSync(path.join(tmpdir(), "fish-dates-a2-"));
    try {
        const f = path.join(dir, "fish-occ-backfill.json");
        assert.equal(readBackfill(f).size, 0, "没有文件 = 空表");
        writeFileSync(f, JSON.stringify({ v: 1, kind: "fish-occ-backfill", tzOffsetMin: 540, m: { x: 11, y: 0 } }));
        assert.deepEqual([...readBackfill(f).entries()], [["x", 11]]);
        writeFileSync(f, "{bad");
        assert.equal(readBackfill(f).size, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------- 4. search_context

function row(seq: number, refNum: number, role: string, kind: string, body: Record<string, unknown>): SearchRow {
    return { seq, refNum, role, kind, retired: false, content: JSON.stringify({ role, contentType: kind, ...body }) };
}
const GROUP = "qq:group:20002";
const priv = (text: string): string => `（QQ 私聊 · 兔 · ${PRIVATE_LANE}）\n<user_message qq="${OWNER_ID}" nickname="兔" mid="1">\n${text}\n</user_message>`;
const T_BASE = L(2026, 11, 18, 18, 50);

interface Fx {
    rows: SearchRow[];
    source: RowSource;
    state: never;
    stamps: Record<string, number>;
    raw: (ref: number) => string;
}

function fixture(): Fx {
    const rows: SearchRow[] = [];
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const stamps: Record<string, number> = {};
    const ids: string[] = [];
    for (let i = 1; i <= 200; i++) {
        let r: SearchRow;
        if (i === 70) r = row(i, i, "user", "text", { text: priv("下周三去老码头吃火锅吧") });
        else if (i === 71) r = row(i, i, "assistant", "text", { text: "好呀，明天先订位子" });
        else if (i === 120) r = row(i, i, "user", "text", { text: `（QQ 群 20002 · 群里最近 · ${GROUP}）\n20:41 小明：明天几点集合\n20:42 小红：后天吧，“明天”下雨` });
        else if (i === 140) r = row(i, i, "tool", "tool-result", { toolName: "web_fetch", text: "灯塔公告：明天停电检修" });
        else r = i % 2 ? row(i, i, "user", "text", { text: priv(`第${i}件小事，没什么特别的，吃饭、走路、看了一会儿书`) }) : row(i, i, "assistant", "text", { text: `嗯，第${i}件也记下了，晚上早点睡` });
        rows.push(r);
        const id = `raw-${i}`;
        ids.push(id);
        const mref = `m${String(i).padStart(5, "0")}`;
        byRaw[id] = mref;
        byRef[mref] = id;
        stamps[id] = T_BASE + i * MIN;
    }
    stamps["raw-120"] = L(2026, 11, 18, 20, 50);
    const state = { blocks: [{ blockId: "b1", tier: 1, topic: "杂事", summary: "一些杂事，下周三去吃火锅", effectiveMessageIds: ids, directBlockIds: [], active: true }], messageRefs: { byRaw, byRef }, tsStamps: stamps } as never;
    const source: RowSource = { page: (_i, after, limit) => rows.filter((x) => x.seq > after).slice(0, limit), byRefRange: (_i, lo, hi) => rows.filter((x) => x.refNum! >= lo && x.refNum! <= hi) };
    return { rows, source, state, stamps, raw: (ref) => `raw-${ref}` };
}

function sessionOf(fx: Fx, id: string) {
    const session = { id, state: fx.state, metadata: {} as Record<string, unknown> } as never;
    storeEffectiveSearchV2(session, resolveSearchV2Settings(ZH_SETTINGS, "deepseek-flash"));
    return session;
}

async function search(fx: Fx, sid: string, args: Record<string, unknown>, s: DateNotesSettings | undefined, ext: { list: () => Array<{ key: string; value: unknown; updatedAt: number }> } | null = { list: () => [] }): Promise<string> {
    clearSearchCorpora();
    _resetOccurrenceForTest();
    setFishDateNotes(s);
    const r = await maybeSearchV2(args, sessionOf(fx, sid), { around: true, raw: ZH_SETTINGS }, () => {}, fx.source, ext);
    assert.ok(r, "v2 答了");
    return r.text;
}

const stripLegend = (m: RelDateModule, t: string): string => m.stripRelDates(t.split(`\n\n${m.RELDATE_LEGEND}`).join("").split(`\n${m.RELDATE_LEGEND}`).join(""));

test("search_context：关着时一个注记都没有；开着时只多注记和图例（去掉后逐字节一样）", async () => {
    const m = await mod();
    const fx = fixture();
    const off = await search(fx, "dates-s1", { query: "老码头 火锅" }, undefined);
    assert.ok(!off.includes("（="), "关着：没有注记");
    assert.ok(!off.includes(m.RELDATE_LEGEND));
    const on = await search(fx, "dates-s1", { query: "老码头 火锅" }, ON);
    const want = m.annotateText("下周三去老码头吃火锅吧", { at: T_BASE + 70 * MIN }, { tzOffsetMin: TZ }).text;
    assert.ok(want.includes("下周三（=2026-11-25"), want);
    assert.ok(on.includes("下周三（=2026-11-25"), on);
    assert.ok(on.endsWith(m.RELDATE_LEGEND), "结尾一行图例");
    assert.equal(stripLegend(m, on), off, "去掉注记和图例以后和关着时逐字节一样");
    const off2 = await search(fx, "dates-s1", { query: "老码头 火锅" }, { ...ON, enabled: false, recordOccurrence: true });
    assert.equal(off2, off, "enabled 关着、只开 recordOccurrence：结果不变");
    setFishDateNotes(undefined);
});

test("search_context：A 档（fish:occ:*）优先于 B 档", async () => {
    const m = await mod();
    const fx = fixture();
    const at = L(2026, 11, 12, 20, 0);
    const on = await search(fx, "dates-s2", { query: "老码头 火锅" }, ON, { list: () => [{ key: "fish:occ:202611", value: { v: 1, m: { "raw-70": at } }, updatedAt: 0 }] });
    const want = m.annotateText("下周三去老码头吃火锅吧", { at }, { tzOffsetMin: TZ }).text;
    assert.ok(want.includes("（=2026-11-18"), want);
    assert.ok(stripLegend(m, on).length < on.length);
    assert.ok(on.includes("（=2026-11-18"), on);
    assert.ok(!on.includes("（=2026-11-25"));
    setFishDateNotes(undefined);
});

test("search_context：群里近况的行按自己的钟点钉；引号里的不标；工具回执（web_fetch）不标", async () => {
    const m = await mod();
    const fx = fixture();
    const off = await search(fx, "dates-s3", { query: "集合" }, undefined);
    const on = await search(fx, "dates-s3", { query: "集合" }, ON);
    const pinned = m.pinClock(L(2026, 11, 18, 20, 50), 20, 41, TZ)!;
    assert.equal(pinned, L(2026, 11, 18, 20, 41));
    const want = m.annotateText("明天几点集合", { at: pinned }, { tzOffsetMin: TZ }).text;
    assert.ok(want.includes("（=2026-11-19"), want);
    assert.ok(on.includes("（=2026-11-19"), on);
    assert.equal(stripLegend(m, on), off);
    assert.ok(!/“明天（=/.test(on), "引号里的不标");
    const toolOff = await search(fx, "dates-s3", { query: "灯塔 停电" }, undefined);
    const toolOn = await search(fx, "dates-s3", { query: "灯塔 停电" }, ON);
    assert.equal(toolOn, toolOff, "工具回执：开着也一个字节不变");
    setFishDateNotes(undefined);
});

test("search_context：reldate sha 不对（模块没载）时开着也和关着一样", async () => {
    const fx = fixture();
    const off = await search(fx, "dates-s4", { query: "老码头 火锅" }, undefined);
    const dir = mkdtempSync(path.join(tmpdir(), "fish-dates-sha2-"));
    try {
        const bad = path.join(dir, "reldate.mjs");
        writeFileSync(bad, Buffer.concat([readFileSync(path.join(ROOT, "src", "fish", "reldate.mjs")), Buffer.from(" ")]));
        await _loadRelDateFromForTest([bad]);
        clearSearchCorpora();
        _resetOccurrenceForTest();
        // 不经 search()：那里会 setFishDateNotes → loadRelDate 用缓存里的失败结果
        setFishDateNotes(ON);
        const r = await maybeSearchV2({ query: "老码头 火锅" }, sessionOf(fx, "dates-s4"), { around: true, raw: ZH_SETTINGS }, () => {}, fx.source, { list: () => [] });
        assert.equal(r!.text, off);
        assert.equal(relDateLoadState(), "sha-mismatch");
    } finally {
        setFishDateNotes(undefined);
        _resetRelDateForTest();
        await loadRelDate();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("search_context around：前后的对话每行用自己的锚点；关着时一个字节不变", async () => {
    const m = await mod();
    const fx = fixture();
    const off = await search(fx, "dates-s5", { query: "火锅", around: "m00070" }, undefined);
    const on = await search(fx, "dates-s5", { query: "火锅", around: "m00070" }, ON);
    assert.ok(!off.includes("（="));
    assert.ok(on.includes("（=2026-11-25"), on);
    assert.equal(stripLegend(m, on).replace("，日期括号另算）：", "）："), off, "去掉注记、图例和头行那半句以后和关着一样");
    setFishDateNotes(undefined);
});

test("注记器：只标 talk 窗、跳过被切开的长行；【】不标进注记里；行的形状", async () => {
    await mod();
    const fx = fixture();
    setFishDateNotes(ON);
    _resetOccurrenceForTest();
    const dn = openSearchDateNoter("dates-n1", fx.state, fx.source, null)!;
    assert.ok(dn);
    const w = { id: 0, blockId: "b1", lane: "x", laneLabel: "x", kind: "talk" as const, weight: 1, text: "兔：明天见", lower: "", spans: [{ start: 0, end: 5, ref: 70, speaker: "兔" }], refFirst: 70, refLast: 70 };
    assert.ok(dn.slice(w, 0, 5, 3).text.includes("（="));
    assert.equal(dn.slice({ ...w, kind: "exp" }, 0, 5, 3).text, "兔：明天见");
    assert.equal(dn.slice({ ...w, chunked: true }, 0, 5, 3).text, "兔：明天见");
    assert.equal(markFirstOutside("下周三（=2026-11-25 周三）2026", "2026"), "下周三（=2026-11-25 周三）【2026】");
    assert.equal(lineShape("[引用 小明：明天] 好", "兔"), null);
    assert.equal(lineShape("11-15 20:03 小明：明天", ""), null);
    assert.deepEqual(lineShape("20:03 小明：明天", ""), { timed: true });
    assert.deepEqual(lineShape("明天见", "兔"), { timed: false });
    setFishDateNotes(undefined);
});

test("search_context（G2 复核 F1）：旧桥「这个群里大家常这么说」块里的「- …」行不标（检索和 around），和核心一样", async () => {
    const m = await mod();
    const fx = fixture();
    const legacy = `（QQ 群 20002 · 群里最近 · ${GROUP}）\n20:41 小明：灯塔那边人多\n20:42 小红：嗯嗯\n这个群里大家常这么说（看着用，不用照搬）：\n- 明天再说\n- 下周一见`;
    fx.rows[149] = row(150, 150, "user", "text", { text: legacy });
    const core = m.annotateText(legacy, { at: fx.stamps["raw-150"]! }, { tzOffsetMin: TZ });
    assert.equal(core.hits.length, 0, "核心：旧说法块整块不标");
    let legacyLines = 0;
    for (const args of [{ query: "下周一见" }, { query: "明天再说 下周一见" }, { query: "下周一见", around: "m00150" }]) {
        const on = await search(fx, "dates-legacy", args, ON);
        assert.ok(/- 【?下周/.test(on), on);
        for (const l of on.split("\n")) if (/- 【?(?:下周|明天)/.test(l)) { legacyLines++; assert.ok(!l.includes("（="), `旧说法块的行没有注记：${l}`); }
    }
    assert.ok(legacyLines >= 3, `旧说法块的行出现在结果里（${legacyLines}）`);
    setFishDateNotes(undefined);
});

test("【】（G2 复核 F5）：按去掉注记的原文找第一处；跨过注记时只括注记前那一截", () => {
    assert.equal(markFirstOutside("明天（=2026-11-20 周五）去", "明天去"), "【明天】（=2026-11-20 周五）去");
    assert.equal(markFirstOutside("明天（=2026-11-20 周五）去，明天去", "明天去"), "【明天】（=2026-11-20 周五）去，明天去", "第一处是原文里的第一处");
    assert.equal(markFirstOutside("下周三（=2026-11-25 周三）去码头", "码头"), "下周三（=2026-11-25 周三）去【码头】");
    assert.equal(markFirstOutside("没有注记的话", "注记"), "没有【注记】的话");
    assert.equal(markFirstOutside("下周三（=2026-11-25 周三）", "周五"), "下周三（=2026-11-25 周三）", "只在注记里出现：不标");
});

test("around（G2 复核 F6）：有注记时头行说「日期括号另算」；没有注记时头行和以前一样", async () => {
    const fx = fixture();
    const on = await search(fx, "dates-s6", { query: "火锅", around: "m00070" }, ON);
    assert.match(on.split("\n")[0]!, /最多 1500 字，日期括号另算）：$/);
    const off = await search(fx, "dates-s6", { query: "火锅", around: "m00070" }, undefined);
    assert.match(off.split("\n")[0]!, /最多 1500 字）：$/);
    setFishDateNotes(undefined);
});

// ---------------------------------------------------------------- 5. decompress

test("decompress 正文：ref 标签那段、统一库对上的那段、她 im_send 的话标；思考、工具回执、子块摘要不标", async () => {
    const m = await mod();
    const fx = fixture();
    setFishDateNotes(ON);
    _resetOccurrenceForTest();
    const noter = openResultNoter("dates-d1", fx.state, fx.source, null)!;
    const send = JSON.stringify({ chat: PRIVATE_LANE, text_zh_cn: "好呀，下周三见" });
    const covered: CoveredMessage[] = [
        { ref: 70, role: "user", contentType: "text", text: "\x3cacp tokens=\"1K\" type=\"text\"\x3em00070\x3c/acp\x3e\n下周三去" },
        { ref: 71, role: "assistant", contentType: "reasoning", text: "想一想明天的事" },
        { ref: 72, role: "assistant", contentType: "tool-call", toolName: "im_send", text: send },
        { ref: 73, role: "tool", contentType: "tool-result", toolName: "qq_history", text: "明天 见" },
        { ref: 74, role: "user", contentType: "text", text: "后天再说" },
    ];
    const body = [
        "[Summary of compressed content] — b0: 旧的\n明天的摘要",
        "[user]\n\x3cacp tokens=\"1K\" type=\"text\"\x3em00070\x3c/acp\x3e\n下周三去",
        "[assistant]\n想一想明天的事",
        `[assistant • im_send]\n${send}`,
        "[tool • qq_history]\n明天 见",
        "[user]\n后天再说",
    ].join("\n\n");
    const r = noteDecompressBody(noter, body, covered);
    assert.equal(r.hits, 3, r.text);
    assert.ok(r.text.includes("下周三（=2026-11-25"), "标签那段");
    assert.ok(r.text.includes("想一想明天的事"), "思考不标");
    assert.ok(r.text.includes("[tool • qq_history]\n明天 见"), "工具回执不标");
    assert.ok(r.text.includes("明天的摘要"), "子块摘要不标");
    const sent = JSON.parse(r.text.split("[assistant • im_send]\n")[1]!.split("\n\n")[0]!) as { text_zh_cn: string };
    assert.ok(/下周三（=\d{4}-\d{2}-\d{2}/.test(sent.text_zh_cn), "im_send 参数里她的话标了，JSON 还是合法的");
    assert.ok(/后天（=/.test(r.text), "统一库对上的那段");
    assert.equal(m.stripRelDates(r.text), body);
    const plain = noteDecompressBody(noter, "[user]\n没有日期的话", [{ ref: 75, role: "user", contentType: "text", text: "没有日期的话" }]);
    assert.equal(plain.hits, 0);
    assert.equal(plain.text, "[user]\n没有日期的话");
    setFishDateNotes(undefined);
    assert.equal(noteDecompress("dates-d1", fx.state, ["raw-70"], body, fx.source, null, fx.source), null, "关着 → null（调用方原样）");
});

const pad = (n: number): string => String(n).padStart(5, "0");

function fold(sid: string): { core: ReturnType<typeof createCore>; config: Config; session: ReturnType<typeof getSession>; msgs: CoreMessage[]; blockId: string } {
    const core = createCore();
    const config = applyCompressSettings(defaultConfig(200_000), 200_000, { ccr: { enabled: false, minToolTokens: 50 } }) as Config;
    const session = getSession(sid);
    const raw: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
        raw.push({ id: `h_${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\n${i === 0 ? "下周三去看海。" : ""}Historical detail ${i}. ${"x".repeat(2000)}` });
    }
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup and a plan for next week.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active)!;
    return { core, config, session, msgs: turn.messages, blockId: block.blockId };
}

test("decompress 真走 resolveDecompress：关着逐字节不变；开着时（A 档有锚点）临时文件开头是图例、只多注记", async () => {
    const m = await mod();
    const real = getStore();
    const at = L(2026, 11, 18, 21, 0);
    const files: string[] = [];
    try {
        const f = fold(`dates-rd-${Math.random().toString(36).slice(2)}`);
        const ctx = { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
        setFishDateNotes(undefined);
        const off = resolveDecompress({ blockId: f.blockId }, ctx).text;
        const pathOf = (t: string): string => /written to: (.+)\n/.exec(t)![1]!;
        files.push(pathOf(off));
        const offFile = readFileSync(pathOf(off), "utf8");
        assert.ok(!offFile.includes("（="));
        setFishDateNotes(ON);
        const noAnchor = resolveDecompress({ blockId: f.blockId }, ctx).text;
        files.push(pathOf(noAnchor));
        assert.equal(readFileSync(pathOf(noAnchor), "utf8"), offFile, "开着但没有锚点（统一库不可用、没有 A 档）：一个字节不变");
        const rawId = f.session.state.messageRefs.byRef["m00001"]!;
        assert.ok(rawId);
        _setStoreForTest(Object.assign(Object.create(real), { listSessionExt: () => [{ key: "fish:occ:202611", value: { v: 1, m: { [rawId]: at } }, updatedAt: 0 }], unifiedSearchRowsPage: () => null, unifiedSearchRowsByRefRange: () => null }));
        const on = resolveDecompress({ blockId: f.blockId }, ctx).text;
        files.push(pathOf(on));
        const onFile = readFileSync(pathOf(on), "utf8");
        assert.ok(onFile.startsWith(`${m.RELDATE_LEGEND}\n`), "文件开头是图例");
        assert.ok(onFile.includes("下周三（=2026-11-25"), onFile.slice(0, 300));
        assert.equal(m.stripRelDates(onFile.slice(m.RELDATE_LEGEND.length + 1)), offFile);
        assert.equal(on.replace(pathOf(on), "P").replace(/\(\d+ chars\)/, "(N chars)"), off.replace(pathOf(off), "P").replace(/\(\d+ chars\)/, "(N chars)"));
    } finally {
        _setStoreForTest(real);
        setFishDateNotes(undefined);
        for (const p of files) rmSync(p, { force: true });
    }
});

// ---------------------------------------------------------------- 6. D4

test("D4 recordOccurrences：新盖章的别人的话记自己的章；上一段回复记结算时刻；重铸潮 / 顺序不对不记；不覆盖", () => {
    _resetOccLedgerForTest();
    const ext = new Map<string, unknown>();
    const store = { getSessionExt: (_s: string, k: string) => ext.get(k), setSessionExt: (_s: string, k: string, v: unknown) => void ext.set(k, v) };
    const t = L(2026, 11, 30, 23, 50);
    const prev = { tsStamps: { u0: t - 10 * MIN } } as never;
    const next = { tsStamps: { u0: t - 10 * MIN, a1: t, u2: t } } as never;
    const msgs = [{ id: "u0", role: "user", contentType: "text" }, { id: "a1", role: "assistant", contentType: "text" }, { id: "u2", role: "user", contentType: "text" }] as never;
    assert.equal(recordOccurrences("s", prev, next, msgs, store, TZ, t), 1, "没有结算时刻：她的回复不记");
    assert.deepEqual(ext.get("fish:occ:202611"), { v: 1, m: { u2: t } });
    // 下一轮：回复结算在 t+2min，下一份请求 t+30min（当地 12-01 00:20）
    recordOccurrences("s", next, next, [] as never, store, TZ, t + MIN);
    const { noteOccResponseEnd } = { noteOccResponseEnd: (id: string, ms: number) => import("../src/fish/occ-ledger.ts").then((x) => x.noteOccResponseEnd(id, ms)) };
    return noteOccResponseEnd("s", t + 2 * MIN).then(() => {
        const n2 = { tsStamps: { ...((next as { tsStamps: Record<string, number> }).tsStamps), a3: t + 30 * MIN, u4: t + 30 * MIN } } as never;
        assert.equal(recordOccurrences("s", next, n2, [{ id: "a3", role: "assistant", contentType: "text" }, { id: "u4", role: "user", contentType: "text" }] as never, store, TZ, t + 30 * MIN), 2);
        assert.deepEqual(ext.get("fish:occ:202611"), { v: 1, m: { u2: t, a3: t + 2 * MIN } }, "回复记结算时刻，落在 11 月");
        assert.deepEqual(ext.get("fish:occ:202612"), { v: 1, m: { u4: t + 30 * MIN } }, "当地 12-01 的落在 12 月");
        assert.equal(occMonthKey(L(2026, 12, 1, 0, 5), TZ), "fish:occ:202612");
        const wave: Record<string, number> = {};
        const wm: Array<{ id: string; role: string }> = [];
        for (let i = 0; i < 17; i++) { wave[`w${i}`] = t + 40 * MIN; wm.push({ id: `w${i}`, role: i % 2 ? "assistant" : "user", contentType: "text" } as never); }
        assert.equal(recordOccurrences("s", n2, { tsStamps: wave } as never, wm as never, store, TZ, t + 40 * MIN), 0, "17 条：重铸潮，不记");
        assert.equal(recordOccurrences("s", n2, { tsStamps: { x1: t, x2: t } } as never, [{ id: "x1", role: "user", contentType: "text" }, { id: "x2", role: "assistant", contentType: "text" }] as never, store, TZ, t + 41 * MIN), 0, "assistant 不在最前面：不记");
        assert.equal(recordOccurrences("s", {} as never, { tsStamps: { u2: t + 5 * MIN } } as never, [{ id: "u2", role: "user", contentType: "text" }] as never, store, TZ, t + 5 * MIN), 0, "已经记过的不覆盖");
        assert.equal((ext.get("fish:occ:202611") as { m: Record<string, number> }).m.u2, t);
        _resetOccLedgerForTest();
    });
});

test("D4（G2 复核 F2）：只记正文和她说话的工具调用；工具回执、别的调用、思考不记；写失败有计数", async () => {
    _resetOccLedgerForTest();
    const { occLedgerTotals, noteOccResponseEnd } = await import("../src/fish/occ-ledger.ts");
    const ext = new Map<string, unknown>();
    const store = { getSessionExt: (_s: string, k: string) => ext.get(k), setSessionExt: (_s: string, k: string, v: unknown) => void ext.set(k, v) };
    const t = L(2026, 11, 20, 12, 0);
    noteOccResponseEnd("k", t - MIN);
    recordOccurrences("k", {} as never, {} as never, [] as never, store, TZ, t - 2 * MIN);
    const ids = ["a-text", "a-send", "a-call", "a-think", "t-res", "u-text"];
    const next = { tsStamps: Object.fromEntries(ids.map((id) => [id, t])) } as never;
    const msgs = [
        { id: "a-text", role: "assistant", contentType: "text" },
        { id: "a-send", role: "assistant", contentType: "tool-call", toolName: "im_send" },
        { id: "a-call", role: "assistant", contentType: "tool-call", toolName: "web_fetch" },
        { id: "a-think", role: "assistant", contentType: "reasoning" },
        { id: "t-res", role: "tool", contentType: "tool-result", toolName: "im_send" },
        { id: "u-text", role: "user", contentType: "text" },
    ] as never;
    assert.equal(recordOccurrences("k", {} as never, next, msgs, store, TZ, t), 3);
    assert.deepEqual(Object.keys((ext.get("fish:occ:202611") as { m: Record<string, number> }).m).sort(), ["a-send", "a-text", "u-text"]);
    const tot = occLedgerTotals() as Record<string, number>;
    assert.equal(tot.recorded, 3);
    assert.equal(tot.notRecordedKinds, 3);
    assert.equal(tot.writeFailed, 0);
    assert.ok(tot.largestShardBytes > 0);
    const bad = { getSessionExt: () => undefined, setSessionExt: () => { throw new Error("[storage] extension value exceeds 4194304 bytes"); } };
    assert.equal(recordOccurrences("k2", {} as never, { tsStamps: { z: t } } as never, [{ id: "z", role: "user", contentType: "text" }] as never, bad, TZ, t), 0, "写失败：回 0、不抛");
    const tot2 = occLedgerTotals() as Record<string, number | string>;
    assert.equal(tot2.writeFailed, 1);
    assert.equal(tot2.recorded, 3, "失败的不算记上");
    assert.match(String(tot2.lastFailure), /exceeds/);
    setFishDateNotes({ ...DATE_NOTES_DEFAULTS, recordOccurrence: true });
    const h = fishDateNotesHealthField().dateNotes as Record<string, unknown>;
    assert.equal((h.occ as Record<string, number>).writeFailed, 1, "health 里看得到");
    setFishDateNotes(undefined);
    _resetOccLedgerForTest();
});

test("D4 真起代理：recordOccurrence 关着时一个 fish:occ:* 都不写；开着时写当地月的键", async () => {
    const { anthropicJsonReply, anthropicTurn, bringUpProxy, postAnthropic } = await import("./fish-ledger-harness.ts");
    // 测试环境默认关掉了内核的盖章（preload-test-env）；这里要有章，关着时「一个都不写」才有意义
    const savedTs = process.env.BILI_MESSAGE_TIMESTAMPS;
    process.env.BILI_MESSAGE_TIMESTAMPS = "1";
    try {
    for (const on of [false, true]) {
        const h = await bringUpProxy(`dates-d4-${on}`, { reply: () => anthropicJsonReply({ input: 40, output: 5 }), extra: on ? ({ fish: { dateNotes: { ...DATE_NOTES_DEFAULTS, recordOccurrence: true } } } as never) : {} });
        const writes: Array<{ key: string; value: unknown }> = [];
        const ext = new Map<string, unknown>();
        const st = h.store as unknown as { setSessionExt: (s: string, k: string, v: unknown) => void; getSessionExt: (s: string, k: string) => unknown };
        const origSet = st.setSessionExt.bind(st);
        const origGet = st.getSessionExt.bind(st);
        st.setSessionExt = (s, k, v) => { if (k.startsWith("fish:occ:")) { writes.push({ key: k, value: v }); ext.set(k, v); } else origSet(s, k, v); };
        st.getSessionExt = (s, k) => (k.startsWith("fish:occ:") ? ext.get(k) : origGet(s, k));
        try {
            const sid = `session-fictional-d4-${on}`;
            const first = anthropicTurn("fictional question 0");
            assert.equal((await postAnthropic(h, sid, first)).status, 200);
            const msgs = (first.messages as unknown[]).concat([{ role: "assistant", content: [{ type: "text", text: "answer" }] }, { role: "user", content: [{ type: "text", text: "fictional question 1" }] }]);
            assert.equal((await postAnthropic(h, sid, { ...first, messages: msgs })).status, 200);
            if (!on) assert.equal(writes.length, 0, "关着：一个 fish:occ:* 都不写");
            else {
                assert.ok(writes.length >= 1, "开着：写了");
                for (const w of writes) {
                    assert.match(w.key, /^fish:occ:\d{6}$/);
                    const v = w.value as { v: number; m: Record<string, number> };
                    assert.equal(v.v, 1);
                    assert.ok(Object.values(v.m).every((x) => typeof x === "number" && x > 0));
                }
            }
        } finally {
            h.store.cancelAll();
            for (const s of [h.proxy, h.upstream]) await new Promise<void>((r) => s.close(() => r()));
            rmSync(h.root, { recursive: true, force: true });
            setFishDateNotes(undefined);
            _resetOccLedgerForTest();
        }
    }
    } finally {
        if (savedTs === undefined) delete process.env.BILI_MESSAGE_TIMESTAMPS;
        else process.env.BILI_MESSAGE_TIMESTAMPS = savedTs;
    }
});
