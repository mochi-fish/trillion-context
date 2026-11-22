// fork (multi-model, M8 / R4): kernel-side pins.
//  - openaiToCore({ reasoningAliases }) reads vLLM's `reasoning` field as
//    reasoning_content; coreToOpenai writes it back under the host's own
//    field name. Without the option the parse is byte-identical upstream.
//  - truncate.holdFreshCuts holds fresh emergency cuts (same hold as the
//    requireUsageSample estimate hold) and leaves the default untouched.
import { test } from "node:test";
import assert from "node:assert/strict";

import { coreToOpenai, openaiToCore, type OpenAIRequestBody } from "../src/wire/openai.js";
import { createCore, createInitialState, defaultConfig } from "../src/index.js";
import type { CoreMessage } from "../src/index.js";

const body = {
  messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: "a", reasoning: "vllm thought" },
    { role: "user", content: "q2" },
    { role: "assistant", content: null, reasoning_text: "gateway thought", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "r" },
    { role: "assistant", content: "b", reasoning: "" },
    { role: "user", content: "q3" },
  ],
} as unknown as OpenAIRequestBody;

test("openaiToCore without options ignores alias fields (upstream behavior)", () => {
  const plain = openaiToCore(body);
  assert.equal(plain.msgs.filter((m) => m.contentType === "reasoning").length, 0);
  assert.ok(plain.msgs.every((m) => m.reasoningField === undefined));
  assert.deepStrictEqual(openaiToCore(body, {}), plain, "an empty options object is the same parse");
  assert.deepStrictEqual(openaiToCore(body, { reasoningAliases: [] }), plain);
});

test("openaiToCore with aliases reads them and coreToOpenai keeps each field name", () => {
  const flat = openaiToCore(body, { reasoningAliases: ["reasoning", "reasoning_text"] });
  const rs = flat.msgs.filter((m) => m.contentType === "reasoning");
  assert.deepStrictEqual(rs.map((m) => [m.text, m.reasoningField]), [["vllm thought", "reasoning"], ["gateway thought", "reasoning_text"]]);
  const out = coreToOpenai(flat.msgs) as unknown as Array<Record<string, unknown>>;
  const asst = out.filter((m) => m.role === "assistant");
  assert.equal(asst[0]!.reasoning, "vllm thought");
  assert.equal(asst[1]!.reasoning_text, "gateway thought");
  assert.ok(Array.isArray(asst[1]!.tool_calls));
  assert.equal(asst[2]!.reasoning, "", "a blank alias field is echoed blank under its own name");
  for (const m of asst) assert.equal("reasoning_content" in m, false, "never renamed");
});

test("an alias never overrides a present reasoning_content", () => {
  const both = { messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a", reasoning_content: "canonical", reasoning: "alias" }] } as unknown as OpenAIRequestBody;
  const flat = openaiToCore(both, { reasoningAliases: ["reasoning"] });
  const r = flat.msgs.find((m) => m.contentType === "reasoning")!;
  assert.equal(r.text, "canonical");
  assert.equal(r.reasoningField, undefined);
});

const BIG = "long words here ".repeat(6_000);
function history(): CoreMessage[] {
  const t = (id: string, role: "user" | "assistant", text: string): CoreMessage => ({ id, role, contentType: "text", text });
  return [
    t("u0", "user", "x".repeat(900)), t("a0", "assistant", "ok"),
    t("u-big", "user", BIG), t("a1", "assistant", "ok"),
    t("u2", "user", "y".repeat(900)), t("a2", "assistant", "a2"),
    t("u3", "user", "q3"), t("a3", "assistant", "a3"), t("u4", "user", "q4"),
  ];
}

test("truncate.holdFreshCuts holds fresh emergency cuts on a usage-grade reading; default still cuts", () => {
  const base = defaultConfig(256_000);
  const run = (hold: boolean) => {
    const cfg = hold ? { ...base, truncate: { ...base.truncate, holdFreshCuts: true } } : base;
    return createCore().processTurn({ messages: history(), state: createInitialState(), config: cfg, tokenCount: 646_189, tokenCountSource: "usage", renderTags: "none" });
  };
  const cut = run(false);
  assert.ok(cut.messages.find((m) => m.id === "u-big")!.text!.includes("[truncated for context space]"));
  const held = run(true);
  assert.equal(held.messages.find((m) => m.id === "u-big")!.text, BIG);
  assert.equal(held.state.emergencyTruncateLatch, undefined);
  assert.equal("holdFreshCuts" in base.truncate, false, "not in the default config");
});
