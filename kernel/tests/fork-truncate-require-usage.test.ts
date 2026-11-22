// fork（养成向）：truncate.requireUsageSample —— 紧急截断只认落了账的真用量。
//
// 一份请求被掐断、用量没落账时，宿主下一份按本地估计判大小
// （processTurn({ tokenCountSource: "estimate" })），估计值常比真用量大得多。
// 开关开着时 emergency-truncate 对估计值不剪新的：已经锁住的照旧重放、
// terminalStreak 不清也不涨；真用量（"usage"）和不传来源的旧调用照旧剪。
// 开关不开（缺省）时和上游逐字节一样。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

const BIG = "alpha-beta ".repeat(4000); // ~44k chars：远超截断留下的头尾
const BIG2 = "gamma-delta ".repeat(4000);
const filler = (t: string) => `filler ${t} ` + "x".repeat(800);
const tiny = (t: string): CoreMessage[] => [
  { id: `raw-${t}`, role: "user", contentType: "text", text: "hi " + t + " " + filler(t) },
  { id: `raw-${t}-a`, role: "assistant", contentType: "text", text: "ok " + t },
];
function hist(withBig2 = false): CoreMessage[] {
  return [
    ...tiny("warm"),
    { id: "raw-big", role: "user", contentType: "text", text: BIG },
    ...(withBig2 ? [{ id: "raw-big2", role: "user" as const, contentType: "text" as const, text: BIG2 }] : []),
    ...tiny("tail1"),
    ...tiny("tail2"),
    ...tiny("tail3"),
  ];
}
const WINDOW = 100_000;
const on = (): Config => {
  const c = defaultConfig(WINDOW);
  return { ...c, truncate: { ...c.truncate, requireUsageSample: true } };
};
const textOf = (ms: CoreMessage[], id: string) => ms.find((m) => m.id === id)!.text!;
const MARK = "[truncated for context space]";

test("缺省配置里没有 requireUsageSample（defaultConfig 逐字节不变）", () => {
  assert.equal("requireUsageSample" in defaultConfig(WINDOW).truncate, false);
  assert.deepEqual(Object.keys(defaultConfig(WINDOW).truncate).sort(), ["terminalEscapeAfter", "threshold"]);
});

test("开关不开：估计值到了线照样剪（上游行为不变）", () => {
  const core = createCore(defaultConfig(WINDOW));
  const t = core.processTurn({ messages: hist(), state: createInitialState(), config: defaultConfig(WINDOW), tokenCount: 130_000, tokenCountSource: "estimate", renderTags: "none" });
  assert.ok(textOf(t.messages, "raw-big").includes(MARK), "估计值 130% 照旧截断");
  assert.ok(t.state.emergencyTruncateLatch?.length, "锁住");
});

test("开关开着：估计值（130%）不剪新的、不锁", () => {
  const core = createCore(on());
  const t = core.processTurn({ messages: hist(), state: createInitialState(), config: on(), tokenCount: 130_000, tokenCountSource: "estimate", renderTags: "none" });
  assert.equal(textOf(t.messages, "raw-big"), BIG, "原文一字不动");
  assert.equal(t.state.emergencyTruncateLatch, undefined, "没有锁");
  assert.equal(t.state.terminalStreak ?? 0, 0);
});

test("开关开着：真用量（96%）照样剪；不传来源的旧调用也照样剪", () => {
  for (const source of ["usage", undefined] as const) {
    const core = createCore(on());
    const t = core.processTurn({ messages: hist(), state: createInitialState(), config: on(), tokenCount: 96_000, ...(source ? { tokenCountSource: source } : {}), renderTags: "none" });
    assert.ok(textOf(t.messages, "raw-big").includes(MARK), `source=${source}: 截断`);
    assert.ok(t.state.emergencyTruncateLatch?.length, `source=${source}: 锁住`);
  }
});

test("开关开着：已经锁住的照旧原样重放，估计值那一轮不再剪别的", () => {
  const core = createCore(on());
  // 第 1 轮：真用量 96%，剪 raw-big、锁住（raw-big2 还没出现）
  const t1 = core.processTurn({ messages: hist(), state: createInitialState(), config: on(), tokenCount: 96_000, tokenCountSource: "usage", renderTags: "none" });
  const clipped = textOf(t1.messages, "raw-big");
  assert.ok(clipped.includes(MARK));
  // 第 2 轮：多了一条大消息，读数是估计值 130%：raw-big 照锁重放，raw-big2 不剪
  const t2 = core.processTurn({ messages: hist(true), state: t1.state, config: on(), tokenCount: 130_000, tokenCountSource: "estimate", renderTags: "none" });
  assert.equal(textOf(t2.messages, "raw-big"), clipped, "锁住的逐字节重放");
  assert.equal(textOf(t2.messages, "raw-big2"), BIG2, "估计值不剪新的");
  assert.deepEqual(t2.state.emergencyTruncateLatch, t1.state.emergencyTruncateLatch, "锁不变");
  // 第 3 轮：真用量回来、还在线上（扣掉已重放省下的那份以后仍过 95%）：照样剪 raw-big2
  const t3 = core.processTurn({ messages: hist(true), state: t2.state, config: on(), tokenCount: 115_000, tokenCountSource: "usage", renderTags: "none" });
  assert.equal(textOf(t3.messages, "raw-big"), clipped);
  assert.ok(textOf(t3.messages, "raw-big2").includes(MARK), "真用量回来就剪");
});

test("开关开着：估计值那一轮 terminalStreak 不清也不涨", () => {
  const core = createCore(on());
  const state = { ...createInitialState(), terminalStreak: 2 };
  const t = core.processTurn({ messages: hist(), state, config: on(), tokenCount: 130_000, tokenCountSource: "estimate", renderTags: "none" });
  assert.equal(t.state.terminalStreak, 2, "保持");
  assert.equal(t.terminalEscape, undefined, "估计值不算「卡住」");
  // 低于线时照旧清零（和上游一样）
  const t2 = core.processTurn({ messages: hist(), state, config: on(), tokenCount: 50_000, tokenCountSource: "estimate", renderTags: "none" });
  assert.equal(t2.state.terminalStreak, 0);
});

test("开关开着、估计值：出站和「低于线」那一轮逐字节一样（同一份历史、同一状态）", () => {
  const core = createCore(on());
  const a = core.processTurn({ messages: hist(), state: createInitialState(), config: on(), tokenCount: 130_000, tokenCountSource: "estimate", renderTags: "none" });
  const b = core.processTurn({ messages: hist(), state: createInitialState(), config: on(), tokenCount: 50_000, tokenCountSource: "usage", renderTags: "none" });
  assert.deepEqual(a.messages.map((m) => m.text), b.messages.map((m) => m.text));
});
