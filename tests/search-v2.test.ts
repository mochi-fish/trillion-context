// fork search v2 (11-20): unit coverage for the cjk search_context engine —
// tokenizer symmetry, Chinese numerals, the evidence gate, cleaning (bridge
// header / envelope / media / paths), speaker labels, retired generations,
// fair excerpt budget, per-model caps, around, promise flip, config
// sanitizing, and the dispatch fallbacks. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { forEachIndexToken, queryUnits, zhNumeralValue, type GramKey } from "../src/search-cjk/tokenize.ts";
import { GramIndex } from "../src/search-cjk/gram-index.ts";
import { allocateExcerptBudget, safeSlice } from "../src/search-cjk/excerpt.ts";
import { budgetForModel, resolveSearchV2Settings, SEARCH_V2_DEFAULT_HUBS } from "../src/search-cjk/settings.ts";
import { classifyRow, compileSettings, cutWindows, ensureCorpus, clearSearchCorpora, type CorpusMessage } from "../src/search-cjk/corpus.ts";
import { effectiveSearchV2, executeSearchAround, flipPerson, maybeSearchV2, renderSearch, storeEffectiveSearchV2, SEARCH_V2_META_KEY } from "../src/search-v2.ts";
import { parseCompressSettings } from "../src/config.ts";
import { withSearchAroundParam, BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, BILI_ACP_TOOLS_OPENAI_NO_RANGE, BILI_ACP_TOOLS_RESPONSES_NO_RANGE } from "../src/compress-tool.ts";
import { buildZhFixture, ZH_SETTINGS, OWNER_ID, PRIVATE_LANE } from "./helpers/search-zh-fixture.ts";
import type { SearchRow } from "../src/storage/store.ts";

const keys = (t: string): GramKey[] => {
    const out: GramKey[] = [];
    forEachIndexToken(t, (k) => out.push(k));
    return out;
};

test("tokenizer: query units are a subset of the text's index tokens (symmetry)", () => {
    const text = "下次去老码头吃火锅吧，我给兔买了12个种子和minecraft的皮肤";
    const idx = new Set(keys(text.toLowerCase()));
    for (const q of ["老码头", "火锅", "12个种子", "十二 种子", "Minecraft 皮肤"]) {
        for (const u of queryUnits(q.toLowerCase())) assert.ok(idx.has(u.key), `${q}: unit ${String(u.key)} indexed`);
    }
});

test("tokenizer: Chinese numerals 0–99 meet Arabic digits; a lone 一 stays text", () => {
    assert.equal(zhNumeralValue("十二"), 12);
    assert.equal(zhNumeralValue("二十"), 20);
    assert.equal(zhNumeralValue("三十八"), 38);
    assert.equal(zhNumeralValue("两"), 2);
    assert.equal(zhNumeralValue("十十"), null);
    assert.ok(keys("种了十二个").includes("n:12"));
    assert.ok(keys("第008关").includes("n:8"));
    assert.ok(!queryUnits("一起").some((u) => u.key === "n:1"), "一起 is not the number one");
    assert.ok(queryUnits("十二个").some((u) => u.key === "n:12"));
});

test("gram index: BM25 idf falls with df, postings saturate tf at 15", () => {
    const ix = new GramIndex();
    for (let i = 0; i < 20; i++) ix.add(i === 3 ? "奶糕兽奶糕兽" : "今天天气不错");
    const rare = ix.idf(ix.df(queryUnits("奶糕")[0]!.key));
    const common = ix.idf(ix.df(queryUnits("天气")[0]!.key));
    assert.ok(rare > 2 && common < 0.2, `rare=${rare} common=${common}`);
    const big = new GramIndex();
    big.add("哈".repeat(100));
    const m = big.match([{ alts: [[queryUnits("哈")[0]!.key]], surfaces: ["哈"], label: "哈" }]);
    assert.equal(m.get(0)![0], 15);
});

test("excerpt budget: short hits served in full, long ones split fairly, floor drops the lowest rank", () => {
    assert.deepEqual(allocateExcerptBudget([50, 900, 900], 1000), [50, 400, 400]);
    const two = allocateExcerptBudget([600, 600], 500);
    assert.deepEqual(two, [250, 250]);
    const many = allocateExcerptBudget(Array(20).fill(300), 1000);
    assert.equal(many.filter((x) => x > 0).length, 16);
    assert.ok(many.every((x) => x === 0 || x >= 60));
    assert.equal(safeSlice("a😀b", 1, 2), "", "never a lone surrogate");
});

test("settings: per-model budget (exact, then the part after the last /) and clamps", () => {
    const raw = { budget: 1000, budgetByModel: { scarletkc: 800, "anthropic/claude-opus-5-5": 1200 } };
    assert.equal(budgetForModel(raw, "nvidia-spark/scarletkc"), 800);
    assert.equal(budgetForModel(raw, "scarletkc"), 800);
    assert.equal(budgetForModel(raw, "anthropic/claude-opus-5-5"), 1200);
    assert.equal(budgetForModel(raw, "claude-opus-5-5"), 1200);
    assert.equal(budgetForModel(raw, "deepseek-flash"), 1000);
    assert.equal(budgetForModel({ budget: 10 }, "x"), 300, "clamped to the minimum");
    assert.deepEqual(resolveSearchV2Settings(undefined, undefined).hubs, SEARCH_V2_DEFAULT_HUBS);
});

test("config: compress.search accepts the v2 keys; a wrong type drops the whole search block", () => {
    const ok = parseCompressSettings({ search: { engine: "cjk", around: true, hubs: ["兔"], budgetByModel: { scarletkc: 800 }, headPatterns: ["^（(?<label>.*?)）"] } });
    assert.equal(ok?.search?.engine, "cjk");
    assert.equal(ok?.search?.around, true);
    assert.deepEqual(ok?.search?.budgetByModel, { scarletkc: 800 });
    const plan = parseCompressSettings({ search: { planAware: true } });
    assert.deepEqual(plan?.search, { planAware: true }, "planAware-only block sanitizes exactly as before");
    for (const bad of [{ engine: "vector" }, { around: "yes" }, { hubs: [1] }, { headPatterns: ["(unclosed"] }, { aliases: [["一个"]] }, { budgetByModel: { x: -1 } }]) {
        const r = parseCompressSettings({ search: { planAware: true, ...bad } });
        assert.equal(r?.search, undefined, `dropped: ${JSON.stringify(bad)}`);
    }
});

function row(seq: number, refNum: number | null, role: string, kind: string, body: Record<string, unknown>, retired = false): SearchRow {
    return { seq, refNum, role, kind, retired, content: JSON.stringify({ role, contentType: kind, ...body }) };
}

test("cleaning: bridge header, onebot envelope, owner by id, look-alike nickname, media and paths", () => {
    const s = resolveSearchV2Settings(ZH_SETTINGS, undefined);
    const c = compileSettings(s);
    const labels = new Map<string, string>();
    const own = classifyRow(row(1, 1, "user", "text", { text: `（QQ 私聊 · 兔 · ${PRIVATE_LANE}）\n<user_message qq="${OWNER_ID}" nickname="晴" mid="9">\n看这个[图片:C:\\Users\\x\\a.png] 好看吗\n</user_message>` }), s, c, labels)!;
    assert.equal(own.lane, PRIVATE_LANE);
    assert.equal(own.laneLabel, "兔的私聊");
    assert.deepEqual(own.lines.map((l) => [l.speaker, l.text]), [["兔", "看这个[图] 好看吗"]]);
    const fake = classifyRow(row(2, 2, "user", "text", { text: `（QQ 群 20002 · 有人 @ 你 · qq:group:20002）\n<user_message qq="30009" nickname="兔" mid="10">\n我是兔\n</user_message>` }), s, c, labels)!;
    assert.equal(fake.laneLabel, "QQ 群");
    assert.equal(fake.lines[0]!.speaker, "兔（不是兔）", "a nickname equal to the owner name is marked");
    const desk = classifyRow(row(3, 3, "user", "text", { text: "（桌面 · 兔直接打的，写在这里兔看得到）\n周五交报告 D:\\work\\r.docx" }), s, c, labels)!;
    assert.equal(desk.lines[0]!.speaker, "兔");
    assert.equal(desk.lines[0]!.text, "周五交报告 [路径]");
    assert.equal(classifyRow(row(4, 4, "user", "text", { text: "Time sampled while idle" }), s, c, labels), null);
    assert.equal(classifyRow(row(5, 5, "user", "text", { text: "（尖塔 · sts:game）\n{\"hp\":3}" }), s, c, labels), null, "sts off by default");
    assert.equal(classifyRow(row(6, 6, "assistant", "reasoning", { text: "想一想" }), s, c, labels), null, "reasoning off by default");
    assert.equal(classifyRow(row(7, 7, "tool", "tool-result", { toolName: "acp_status", text: "Compressed" }), s, c, labels), null);
    const send = classifyRow(row(8, 8, "assistant", "tool-call", { toolName: "im_send", text: JSON.stringify({ chat: PRIVATE_LANE, text_zh_cn: "好呀", text_ja_jp: "いいよ" }) }), s, c, labels)!;
    assert.equal(send.laneLabel, "兔的私聊");
    assert.deepEqual(send.lines.map((l) => [l.speaker, l.text]), [["你", "好呀"]]);
    const tagged = classifyRow(row(9, 9, "assistant", "text", { text: "好的<tool_call>x</tool_call>完成" }), s, c, labels)!;
    assert.ok(!/[<>]/.test(tagged.lines[0]!.text), "XML-like tags never reach the corpus");
});

test("windows: 800-char cap with an overlapping tail, never across lanes", () => {
    const msgs: CorpusMessage[] = [];
    for (let i = 0; i < 40; i++) msgs.push({ ref: i + 1, seq: i, lane: "x", laneLabel: "x", kind: "talk", weight: 1, live: true, lines: [{ ref: i + 1, speaker: "兔", text: `第${i}句`.padEnd(60, "嗯") }] });
    let id = 0;
    const ws = cutWindows("b1", msgs, () => id++);
    assert.ok(ws.length >= 3);
    for (const w of ws) assert.ok(w.text.length <= 800 + 70, `window ${w.text.length}`);
    for (let i = 1; i < ws.length; i++) assert.ok(ws[i]!.refFirst <= ws[i - 1]!.refLast, "consecutive windows overlap");
});

test("retired generation: used only for refs without a live row", async () => {
    clearSearchCorpora();
    const s = resolveSearchV2Settings(ZH_SETTINGS, undefined);
    const rows: SearchRow[] = [
        row(1, 1, "assistant", "text", { text: "旧一代说过滑雪板" }, true),
        row(2, 1, "assistant", "reasoning", { text: "新一代只有想法" }),
        row(3, 2, "assistant", "text", { text: "只剩旧一代的冰淇淋" }, true),
    ];
    const state = { blocks: [{ blockId: "b1", tier: 1, topic: "t", summary: "s", effectiveMessageIds: ["r1", "r2"], directBlockIds: [], active: true }], messageRefs: { byRaw: { r1: "m00001", r2: "m00002" } } } as never;
    const cp = (await ensureCorpus("ret", state, s, { rows: { page: (_i, after) => rows.filter((r) => r.seq > after), byRefRange: () => rows } }))!;
    const all = cp.windows.map((w) => w.text).join("\n");
    assert.ok(!all.includes("滑雪板"), "a retired row of a ref with a live row stays out");
    assert.ok(all.includes("冰淇淋"), "a retired-only ref falls back to its retired row");
});

test("glued latin words: a space-less query splits an unknown word into known ones", async () => {
    clearSearchCorpora();
    const s = resolveSearchV2Settings(ZH_SETTINGS, undefined);
    const rows: SearchRow[] = [];
    const ids: string[] = [];
    const byRaw: Record<string, string> = {};
    for (let i = 1; i <= 240; i++) {
        const text = i === 70 ? "公司的 gitlab runner 又坏了，排了半天" : i === 120 ? "gitlab 上的代码" : i === 160 ? "跑步机的 runner 模式" : `今天的第${i}件小事，没什么特别的，吃饭、走路、看了一会儿书，晚上早点睡`;
        rows.push(row(i, i, i % 2 ? "user" : "assistant", "text", { text }));
        ids.push(`r${i}`);
        byRaw[`r${i}`] = `m${String(i).padStart(5, "0")}`;
    }
    const state = { blocks: [{ blockId: "b1", tier: 1, topic: "杂事", summary: "一些杂事", effectiveMessageIds: ids, directBlockIds: [], active: true }], messageRefs: { byRaw } } as never;
    const cp = (await ensureCorpus("latin", state, s, { rows: { page: (_i, after) => rows.filter((r) => r.seq > after), byRefRange: () => rows } }))!;
    const spaced = renderSearch("gitlab runner 坏了", 5, cp, state, s).out;
    const glued = renderSearch("gitlabrunner坏了", 5, cp, state, s).out;
    assert.match(spaced, /m00070/);
    assert.match(glued, /m00070/, "the glued query finds the same message");
    assert.ok(!glued.includes("「gitlabrunner」"), "not reported as missing");
    const none = renderSearch("zzqqxxww", 5, cp, state, s).out;
    assert.match(none, /没找到/);
});

test("grow: rows that land after their block are still indexed; concurrent calls do not double-add", async () => {
    clearSearchCorpora();
    const fx = buildZhFixture();
    const s = resolveSearchV2Settings(ZH_SETTINGS, "deepseek-flash");
    const fresh = (await ensureCorpus(fx.sessionId, fx.state, s, { rows: fx.source }))!;
    const freshChars = fresh.chars;
    clearSearchCorpora();
    let upTo = Math.floor(fx.rows.length / 2);
    const visible = () => fx.rows.slice(0, upTo);
    const src = { page: (_i: string, after: number, limit: number) => visible().filter((r) => r.seq > after).slice(0, limit), byRefRange: () => visible() };
    await ensureCorpus(fx.sessionId, fx.state, s, { rows: src });
    upTo = fx.rows.length;
    const [a, b] = await Promise.all([ensureCorpus(fx.sessionId, fx.state, s, { rows: src }), ensureCorpus(fx.sessionId, fx.state, s, { rows: src })]);
    assert.equal(a, b);
    const all = a!.windows.map((w) => w.text).join("\n");
    for (const ref of [fx.factRef.get("a1")!, fx.factRef.get("k3")!]) assert.ok(a!.windows.some((w) => w.refFirst <= ref && ref <= w.refLast), `ref ${ref} indexed`);
    assert.ok(a!.chars <= freshChars * 1.2, `no double-adding (${a!.chars} vs ${freshChars})`);
    assert.ok(all.length > 0);
});

async function fixtureCorpus() {
    clearSearchCorpora();
    const fx = buildZhFixture();
    const s = resolveSearchV2Settings(ZH_SETTINGS, "deepseek-flash");
    const cp = (await ensureCorpus(fx.sessionId, fx.state, s, { rows: fx.source }))!;
    return { fx, s, cp };
}

test("render: found / not found / too broad, speaker labels, 【】 on the query, no ids or tags", async () => {
    const { fx, s, cp } = await fixtureCorpus();
    const hit = renderSearch("火锅 老码头", 5, cp, fx.state, s, { aroundOn: true }).out;
    assert.match(hit, /^「火锅 老码头」：找到 1 处原话/);
    assert.match(hit, /\n\[1\] b\d+ · 兔的私聊 · m\d{5}/);
    assert.match(hit, /兔：下次去【老码头】吃火锅吧/);
    assert.match(hit, /around: "m\d{5}"/);
    const noAround = renderSearch("火锅 老码头", 5, cp, fx.state, s).out;
    assert.ok(!noAround.includes("around"), "the around tip only shows while around is on");
    const none = renderSearch("滑雪", 5, cp, fx.state, s).out;
    assert.match(none, /^「滑雪」：在折起来的旧对话里没找到。/);
    assert.match(none, /「滑雪」一处都没有。/);
    const broad = renderSearch("兔 你", 5, cp, fx.state, s).out;
    assert.match(broad, /太宽了/);
    for (const out of [hit, none, broad]) {
        assert.ok(!/<\/?[A-Za-z]/.test(out));
        assert.ok(!out.includes(OWNER_ID) && !out.includes("qq:"));
    }
});

test("render: the per-model budget caps the excerpt chars", async () => {
    const { fx, cp } = await fixtureCorpus();
    const wide = resolveSearchV2Settings({ ...ZH_SETTINGS, budget: 4000 }, "deepseek-flash");
    const narrow = resolveSearchV2Settings({ ...ZH_SETTINGS, budget: 4000, budgetByModel: { scarletkc: 300 } }, "nvidia-spark/scarletkc");
    const a = renderSearch("今天 上班", 8, cp, fx.state, wide).out;
    const b = renderSearch("今天 上班", 8, cp, fx.state, narrow).out;
    const excerptChars = (o: string): number => o.split("\n").filter((l) => l.startsWith("  ")).reduce((n, l) => n + l.length - 2, 0);
    assert.ok(excerptChars(b) <= 300 + 8 * 4, `narrow ${excerptChars(b)}`);
    assert.ok(excerptChars(a) >= excerptChars(b));
});

test("around: same lane, the target marked, reasoning never shown, bad refs explained", async () => {
    const { fx, s } = await fixtureCorpus();
    const ref = fx.factRef.get("d3")!;
    const session = { id: fx.sessionId, state: fx.state, metadata: {} } as never;
    const r = executeSearchAround({ around: `m${String(ref).padStart(5, "0")}`, query: "吉他" }, session, s, fx.source)!;
    assert.match(r.text, /前后（兔的私聊/);
    assert.match(r.text, /→ m\d{5} 兔：最近在学【吉他】/);
    assert.ok(r.text.length <= 1600);
    assert.ok(!r.text.includes("想要不要提一下"), "reasoning never shown");
    const bad = executeSearchAround({ around: "12345" }, session, s, fx.source)!;
    assert.equal(bad.outcome, "failure");
});

test("promise flip: swaps 你↔我 and 你们↔我们 only when on", async () => {
    assert.equal(flipPerson("我答应你们的"), "你答应我们的");
    const { fx, s, cp } = await fixtureCorpus();
    const off = renderSearch("我答应你 看电影", 5, cp, fx.state, s).out;
    const on = renderSearch("我答应你 看电影", 5, cp, fx.state, { ...s, promiseFlip: true }).out;
    assert.match(off, /答应/);
    assert.match(on, /答应/);
});

test("dispatch: no stamp → null (old path); foreign session → null; around ignored while the lane is off", async () => {
    const { fx } = await fixtureCorpus();
    const meta: Record<string, unknown> = {};
    const session = { id: fx.sessionId, state: fx.state, metadata: meta } as never;
    assert.equal(await maybeSearchV2({ query: "火锅" }, session, undefined, () => {}, fx.source), null);
    assert.equal(await maybeSearchV2({ query: "火锅", around: "m00010" }, session, undefined, () => {}, fx.source), null, "around without the base switch → old path");
    storeEffectiveSearchV2(session, resolveSearchV2Settings(ZH_SETTINGS, "deepseek-flash"));
    assert.ok(effectiveSearchV2(session));
    const v2 = await maybeSearchV2({ query: "火锅" }, session, undefined, () => {}, fx.source);
    assert.match(v2!.text, /找到/);
    assert.equal(await maybeSearchV2({ query: "火锅", conversation_id: "other-session" }, session, undefined, () => {}, fx.source), null);
    const around = await maybeSearchV2({ query: "", around: "m00010" }, session, { around: true }, () => {}, fx.source);
    assert.match(around!.text, /m00010/);
    clearSearchCorpora();
    const unavailable = await maybeSearchV2({ query: "火锅" }, session, undefined, () => {}, { page: () => null, byRefRange: () => null });
    assert.equal(unavailable, null, "no unified store → old path");
    storeEffectiveSearchV2(session, undefined);
    assert.ok(!(SEARCH_V2_META_KEY in meta), "switching off removes the stamp");
});

test("stamp: off writes nothing (no new metadata key)", () => {
    const meta: Record<string, unknown> = { lastModel: "deepseek-flash" };
    storeEffectiveSearchV2({ metadata: meta } as never, undefined);
    assert.deepEqual(Object.keys(meta), ["lastModel"]);
});

test("manifest helper: around is added to search_context only, on every wire", () => {
    const a = withSearchAroundParam(BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE);
    const o = withSearchAroundParam(BILI_ACP_TOOLS_OPENAI_NO_RANGE);
    const r = withSearchAroundParam(BILI_ACP_TOOLS_RESPONSES_NO_RANGE);
    const sa = a.find((t) => t.name === "search_context")!;
    assert.ok((sa.input_schema.properties as Record<string, unknown>).around);
    const so = o.find((t) => t.function.name === "search_context")!;
    assert.ok((so.function.parameters.properties as Record<string, unknown>).around);
    const sr = r.find((t) => t.name === "search_context")!;
    assert.ok((sr.parameters.properties as Record<string, unknown>).around);
    // nothing else changes
    for (let i = 0; i < a.length; i++) if (a[i]!.name !== "search_context") assert.equal(a[i], BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE[i]);
    assert.ok(!(BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE.find((t) => t.name === "search_context")!.input_schema.properties as Record<string, unknown>).around, "the original arrays are untouched");
});
