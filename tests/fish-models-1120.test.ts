// fork（多模型，fork-1120）：M5 按「能用的输入」判窗、M6 账本带本地估计、M7 Anthropic
// 签名思考的前缀绑定兜底、M8 OpenAI 线认 vLLM 的 `reasoning`、R4 切模型后头几份只催不截。
//
// 五样都默认关：没写 compress.modelWindows、会话条目没写 limitMode / anthropicThinkingBinding /
// openaiReasoningAliases / truncateHoldAfterSwitch、没写顶层 fishLedger 时，外发字节、账本行、
// 会话里的键都和上游一样（逐字节的比对在 sessionless/fork-1120 的 E0-wire 脚本里，这里核
// 「关着时不多一个键」）。
//
// 这份测试守住：
//   1. 配置：按会话的四个新键、modelWindows、fishLedger 的清洗；设置页往返收得下、写坏整块拒。
//   2. M5 公式：四个模型照 models.md 2.3 算（scarletkc 262,144 → 190,054）；表里的 window
//      封住宿主报大了的窗口；没有原生窗口退回 window；按「/」后面那段认、有歧义不认。
//      真起代理：input 模式判窗是 judgeBase、会话里多 modelWindow；没写时和原来一样。
//   3. R4：步进逻辑；内核 holdFreshCuts 按住新剪、锁照旧重放、催压照样算；真起代理：换模型后
//      头两份 effectiveConfig.truncate.holdFreshCuts 是 true，第三份没有；没写时一个键都不多。
//   4. M7：认得出那条 400（签名坏了的那种不认）；去思考不会弄空消息；真起代理：开着时去掉
//      思考重发一次、上游收下；关着时 400 原样回去、只打一次上游。
//   5. M8：内核 openaiToCore 认 alias、coreToOpenai 用原来的字段名写回；不传选项和上游一样。
//      真起代理（假的 OpenAI 兼容端点，回 `reasoning` 字段）：开着时外发保留 `reasoning`；
//      关着时上游的行为（`reasoning` 不认，外发里没有）照旧。
//   6. 图片墙：vLLM 的原句「At most N image(s) may be provided in one prompt.」——#4124 的
//      正则原来认不出，合并那一轮（local/fish-1120）改成认「image(s)」；「images」写法照旧认得出；
//      真起代理时代理学到墙、记进 imageCountCaps。
//   7. M6：recordEstimate 开着时 usage provider 行多一个 data.est；关着时没有这个键。
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-fish-models-1120-"));
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");
delete process.env.BILI_CONFIG_FILE;

const { defaultConfig, createCore, createInitialState } = await import("acp-kernel");
const { openaiToCore, coreToOpenai } = await import("acp-kernel/wire");
const { startServer, effectiveTokenCount } = await import("../src/server.ts");
const { parseCompressSettings, sanitizeSessionCompressOverride, sanitizeModelWindowEntry, parseFishLedgerSettings } = await import("../src/config.ts");
const { applySessionCompressOverride, resolveSessionCompressOverride } = await import("../src/compress-settings.ts");
const { computeInputJudgeBase, resolveModelWindowEntry, stepSwitchTruncateHold, isThinkingBindingError, stripAnthropicThinking, openaiReasoningAliasesOf, anthropicStripRetryOn } = await import("../src/model-windows.ts");
const { inspectContextOverflow } = await import("../src/util.ts");
const { settleUsageReport, noteOutboundContextEstimates } = await import("../src/cache-ledger.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { peekSession } = await import("../src/session.ts");
const { _resetFishLedgerForTest, stopFishLedger, setFishLedgerRecordEstimate, fishLedgerRecordEstimateOn } = await import("../src/fish-ledger.ts");
const { closeServers } = await import("./server-close-guard.ts");
const { anthropicSseReply, anthropicTurn, bringUpProxy, postAnthropic } = await import("./fish-ledger-harness.ts");
type ProxyOptions = import("../src/config.ts").ProxyOptions;
type CoreMessage = import("acp-kernel").CoreMessage;
type Session = import("../src/session.ts").Session;
type UpstreamReply = import("./fish-ledger-harness.ts").UpstreamReply;

const HER = "session-e795aff7-0000-4000-8000-0000000011a0";
const HELPER = "session-e795aff7-0000-4000-8000-0000000011b0";
const MARK = "[truncated for context space]";
const BINDING_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header." } });
const TAMPERED_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block" } });

// ---------- 1. 配置 ----------

test("配置：按会话的四个新键照收，写坏的只丢那一个；没写时不出现", () => {
    const ok = sanitizeSessionCompressOverride({ limitMode: "input", anthropicThinkingBinding: "strip_retry", openaiReasoningAliases: true, truncateHoldAfterSwitch: 2 });
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.value, { limitMode: "input", anthropicThinkingBinding: "strip_retry", openaiReasoningAliases: true, truncateHoldAfterSwitch: 2 });
    const bad = sanitizeSessionCompressOverride({ modelContextLimit: 256_000, limitMode: "tokens", anthropicThinkingBinding: "drop_block", openaiReasoningAliases: "yes", truncateHoldAfterSwitch: 9 });
    assert.equal(bad.problems.length, 4);
    assert.deepEqual(bad.value, { modelContextLimit: 256_000 }, "写坏的键不生效，好的照用");
    const plain = sanitizeSessionCompressOverride({ modelContextLimit: 256_000 });
    for (const k of ["limitMode", "anthropicThinkingBinding", "openaiReasoningAliases", "truncateHoldAfterSwitch"]) assert.equal(k in (plain.value ?? {}), false);
    // apply：只把 M7 / M8 两个落到 Config 上，而且只在写了时
    const base = defaultConfig(256_000);
    assert.equal(applySessionCompressOverride(base, { modelContextLimit: 256_000 }, 1_048_576), base, "没写新键、值没变：同一个对象");
    const on = applySessionCompressOverride(base, { anthropicThinkingBinding: "strip_retry", openaiReasoningAliases: true }, 1_048_576);
    assert.equal(anthropicStripRetryOn(on), true);
    assert.deepEqual(openaiReasoningAliasesOf(on), ["reasoning", "reasoning_text"]);
    assert.equal(anthropicStripRetryOn(base), false);
    assert.equal(openaiReasoningAliasesOf(base), undefined);
    assert.equal("anthropicThinkingBinding" in base, false);
});

test("配置：modelWindows 的行清洗、设置页往返收得下、写坏整块拒；fishLedger 只认布尔", () => {
    assert.deepEqual(sanitizeModelWindowEntry({ window: 262_144, safety: 0.85, quality: null }).value, { window: 262_144, safety: 0.85 });
    assert.equal(sanitizeModelWindowEntry({ safety: 1.5 }).problems.length, 1);
    assert.equal(sanitizeModelWindowEntry({ window: 12.5 }).problems.length, 1);
    assert.equal(sanitizeModelWindowEntry({ efforts: ["low"] }).problems.length, 1, "表里别的字段（efforts 这类）不收");
    const round = parseCompressSettings({ modelWindows: { "nvidia-spark/scarletkc": { window: 262_144, safety: 0.85 } }, sessions: { [HER]: { limitMode: "input", truncateHoldAfterSwitch: 2 } } });
    assert.ok(round);
    assert.deepEqual(round!.modelWindows, { "nvidia-spark/scarletkc": { window: 262_144, safety: 0.85 } });
    assert.deepEqual(round!.sessions, { [HER]: { limitMode: "input", truncateHoldAfterSwitch: 2 } });
    assert.equal(parseCompressSettings({ modelWindows: { x: { safety: 2 } } }), undefined, "写坏整块拒");
    assert.equal(parseCompressSettings({ modelWindows: [] }), undefined);
    assert.deepEqual(parseFishLedgerSettings({ recordEstimate: true }), { fishLedger: { recordEstimate: true } });
    assert.deepEqual(parseFishLedgerSettings({ recordEstimate: "1" }), {});
    assert.deepEqual(parseFishLedgerSettings(undefined), {});
});

// ---------- 2. M5 ----------

test("M5 公式：四个模型照 models.md 2.3 算", () => {
    const T = 256_000;
    const flash = computeInputJudgeBase({ target: T, hostNative: 1_048_576, maxOutput: 256_000 })!;
    assert.equal(flash.headroomBound, 635_289);
    assert.equal(flash.judgeBase, 256_000);
    const opus = computeInputJudgeBase({ target: T, hostNative: 1_000_000, maxOutput: 128_000 })!;
    assert.equal(opus.headroomBound, 722_000);
    assert.equal(opus.judgeBase, 256_000);
    const gemini = computeInputJudgeBase({ target: T, hostNative: 1_048_576, maxOutput: 32_768 })!;
    assert.equal(gemini.headroomBound, 858_521);
    assert.equal(gemini.judgeBase, 256_000);
    const qwen = computeInputJudgeBase({ target: T, hostNative: 262_144, maxOutput: 32_768, entry: { window: 262_144, safety: 0.85 } })!;
    assert.equal(qwen.judgeBase, 190_054, "scarletkc 原生 262,144 → 190,054");
    // 宿主没补全条目、报 pi-ai 缺省的 1,000,000 / 128,000：表里的 window 封住
    const qwenWrongHost = computeInputJudgeBase({ target: T, hostNative: 1_000_000, maxOutput: 128_000, entry: { window: 262_144 } })!;
    assert.equal(qwenWrongHost.native, 262_144);
    assert.equal(qwenWrongHost.reserve, 65_536, "预留封顶 0.25 × 262,144");
    assert.equal(qwenWrongHost.judgeBase, 222_822 - 65_536);
    // quality、provenReserve
    assert.equal(computeInputJudgeBase({ target: T, hostNative: 262_144, maxOutput: 32_768, entry: { quality: 160_000 } })!.judgeBase, 160_000);
    assert.equal(computeInputJudgeBase({ target: T, hostNative: 262_144, maxOutput: 0, provenReserve: 100_000 })!.judgeBase, 162_144);
    // 原生窗口拿不到 → undefined（调用方退回 window）
    assert.equal(computeInputJudgeBase({ target: T, hostNative: undefined, maxOutput: 1 }), undefined);
});

test("M5 表：先整串认，再认「/」后面那段；两行都对得上就都不认", () => {
    const compress = { modelWindows: { "nvidia-spark/scarletkc": { window: 262_144 }, "deepseek-account/deepseek-flash": { safety: 0.9 }, "a/dup": { safety: 0.9 }, "b/dup": { safety: 0.8 }, "exact-only": { safety: 0.95 } } };
    assert.equal(resolveModelWindowEntry(compress, "scarletkc")?.key, "nvidia-spark/scarletkc");
    assert.equal(resolveModelWindowEntry(compress, "deepseek-flash")?.entry.safety, 0.9);
    assert.equal(resolveModelWindowEntry(compress, "exact-only")?.entry.safety, 0.95);
    assert.equal(resolveModelWindowEntry(compress, "dup"), undefined, "有歧义不认");
    assert.equal(resolveModelWindowEntry(compress, "gemini-4-argon"), undefined);
    assert.equal(resolveModelWindowEntry({}, "scarletkc"), undefined);
    assert.equal(resolveModelWindowEntry(undefined, "scarletkc"), undefined);
});

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startPluginHarness(globalCompress: Record<string, unknown>, models: Record<string, unknown> = { "deepseek-flash": { context: 1_048_576 } }) {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: "msg_m", role: "assistant", usage: { input_tokens: 55 } } }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
            res.write(anthropicSse("message_stop", { type: "message_stop" }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, ...globalCompress },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    assert.ok(proxyPort < 18780 || proxyPort > 18799);
    return {
        proxyPort,
        upstreamPort,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

async function sendPluginTurn(h: { proxyPort: number; upstreamPort: number }, conversationId: string, o: { model?: string; maxTokens?: number; contextWindow?: number } = {}): Promise<void> {
    const model = o.model ?? "deepseek-flash";
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-bili-plugin": "dsh",
        "x-bili-plugin-conversation": conversationId,
        "x-bili-plugin-model": model,
    };
    if (o.contextWindow !== undefined) headers["x-bili-plugin-context-window"] = String(o.contextWindow);
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, max_tokens: o.maxTokens ?? 1024, stream: true, messages: [{ role: "user", content: `hello from ${conversationId}` }] }),
    });
    assert.equal(resp.status, 200);
    for await (const _chunk of resp.body!) { /* drain */ }
}

function configOf(conversationId: string): Record<string, unknown> {
    const s = peekSession(conversationId);
    assert.ok(s, `会话 ${conversationId} 已建`);
    return (s!.metadata.effectiveConfig ?? {}) as Record<string, unknown>;
}

test("M5 真起代理：input 模式判窗是 judgeBase（scarletkc 形状 → 190,054），帮手和没写的会话照旧", async () => {
    const h = await startPluginHarness({
        modelWindows: { "nvidia-spark/scarletkc": { window: 262_144, safety: 0.85 } },
        sessions: { [HER]: { modelContextLimit: 256_000, limitMode: "input" }, [HELPER]: { modelContextLimit: 256_000 } },
    }, { scarletkc: { context: 262_144, output: 32_768 } });
    try {
        await sendPluginTurn(h, HER, { model: "scarletkc", maxTokens: 32_768, contextWindow: 262_144 });
        await sendPluginTurn(h, HELPER, { model: "scarletkc", maxTokens: 32_768, contextWindow: 262_144 });
        const her = peekSession(HER)!;
        assert.equal(configOf(HER).modelContextLimit, 190_054, "她：判窗 = judgeBase");
        assert.equal((her.metadata.modelWindow as { judgeBase: number }).judgeBase, 190_054);
        assert.equal((her.metadata.modelWindow as { row: string }).row, "nvidia-spark/scarletkc");
        assert.equal(her.metadata.effectiveContextLimit, 256_000, "显示用的窗口照旧是没扣预留的那个");
        // 帮手（window 模式）：256,000 − min(32,768, 0.25 × 256,000) = 223,232
        assert.equal(configOf(HELPER).modelContextLimit, 223_232, "帮手：window 的算法，和今天一样");
        assert.equal("modelWindow" in peekSession(HELPER)!.metadata, false, "window 模式不写 modelWindow");
    } finally {
        await h.close();
    }
});

test("M5 真起代理：Claude 这种「输出另算」的路线，input 模式也按公式（256,000），window 模式不扣（和今天一样）", async () => {
    const h = await startPluginHarness({
        sessions: { [HER]: { modelContextLimit: 256_000, limitMode: "input" }, [HELPER]: { modelContextLimit: 256_000 } },
    }, { "claude-opus-5-5": { context: 1_000_000, output: 128_000 } });
    try {
        await sendPluginTurn(h, HER, { model: "claude-opus-5-5", maxTokens: 128_000, contextWindow: 1_000_000 });
        await sendPluginTurn(h, HELPER, { model: "claude-opus-5-5", maxTokens: 128_000, contextWindow: 1_000_000 });
        assert.equal(configOf(HER).modelContextLimit, 256_000);
        assert.equal(configOf(HELPER).modelContextLimit, 256_000);
    } finally {
        await h.close();
    }
});

// ---------- 3. R4 ----------

test("R4 步进：换模型那一份起按住 N 份；没换不按；N=0 不按", () => {
    const base = { prevOrigin: "o", curOrigin: "o", windowChanged: false, now: 1 };
    let r = stepSwitchTruncateHold({ ...base, holdN: 2, prev: undefined, prevModel: "gemini-4-argon", curModel: "deepseek-flash" });
    assert.equal(r.hold, true); assert.equal(r.started, true); assert.equal(r.state?.left, 1);
    r = stepSwitchTruncateHold({ ...base, holdN: 2, prev: r.state, prevModel: "deepseek-flash", curModel: "deepseek-flash" });
    assert.equal(r.hold, true); assert.equal(r.started, false); assert.equal(r.state, undefined);
    r = stepSwitchTruncateHold({ ...base, holdN: 2, prev: r.state, prevModel: "deepseek-flash", curModel: "deepseek-flash" });
    assert.equal(r.hold, false);
    assert.equal(stepSwitchTruncateHold({ ...base, holdN: 2, prev: undefined, prevModel: undefined, curModel: "x" }).hold, false, "第一份请求（不知道上一份）不算换");
    assert.equal(stepSwitchTruncateHold({ ...base, holdN: 2, prev: undefined, prevModel: "x", curModel: "x", prevOrigin: "a", curOrigin: "b" }).hold, true, "换路线也算");
    assert.equal(stepSwitchTruncateHold({ ...base, holdN: 2, prev: undefined, prevModel: "x", curModel: "x", windowChanged: true }).state?.reason, "window");
    assert.equal(stepSwitchTruncateHold({ ...base, holdN: 0, prev: undefined, prevModel: "a", curModel: "b" }).hold, false);
});

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return { id: `fm-${seq}`, metadata: {}, stats: {}, state: createInitialState() } as unknown as Session;
}
const BIG = "她和兔的一段长话，long words here ".repeat(3_000);
function history(): CoreMessage[] {
    const t = (id: string, role: "user" | "assistant", text: string): CoreMessage => ({ id, role, contentType: "text", text });
    return [
        t("u0", "user", "早 " + "x".repeat(900)), t("a0", "assistant", "早呀"),
        t("u-big", "user", BIG), t("a1", "assistant", "嗯"),
        t("u2", "user", "q2 " + "y".repeat(900)), t("a2", "assistant", "a2"),
        t("u3", "user", "q3"), t("a3", "assistant", "a3"), t("u4", "user", "q4"),
    ];
}
const rawLarge = (): CoreMessage[] => [{ id: "r", role: "user", contentType: "text", text: "z".repeat(4_000_000) }];

function turnWith(hold: boolean, session: Session) {
    const base = applySessionCompressOverride(defaultConfig(256_000), { requireUsageSampleForTruncate: true }, 1_048_576);
    const cfg = hold ? { ...base, truncate: { ...base.truncate, holdFreshCuts: true } } : base;
    const sizing = effectiveTokenCount(session, rawLarge());
    const turn = createCore().processTurn({ messages: history(), state: session.state, config: cfg, tokenCount: sizing.tokens, tokenCountSource: sizing.source, renderTags: "none" });
    session.state = turn.state;
    return { sizing, turn };
}

test("R4 内核：切回 Flash 那种过期真用量（646,189 / 256,000 = 252%）——不按住照剪、锁住（M4 的 R1）；按住不剪、不锁，催压照样算", () => {
    const off = makeSession();
    settleUsageReport(off, { total: 646_189, reportedCached: 0 });
    const r0 = turnWith(false, off);
    assert.deepEqual(r0.sizing, { tokens: 646_189, source: "usage" }, "只认真用量也挡不住（它就是真用量）");
    assert.ok(r0.turn.messages.find((m) => m.id === "u-big")!.text!.includes(MARK), "不按住：剪");
    assert.ok((r0.turn.state.emergencyTruncateLatch?.length ?? 0) > 0, "锁住");

    const on = makeSession();
    settleUsageReport(on, { total: 646_189, reportedCached: 0 });
    const r1 = turnWith(true, on);
    assert.equal(r1.turn.messages.find((m) => m.id === "u-big")!.text, BIG, "按住：不剪");
    assert.equal(r1.turn.state.emergencyTruncateLatch, undefined, "不锁");
    assert.ok(r1.turn.nudge !== undefined, "催压照样算");
    // 已经锁住的照样重放（按住只挡新剪）
    const r2 = turnWith(true, off);
    assert.ok(r2.turn.messages.find((m) => m.id === "u-big")!.text!.includes(MARK), "旧锁照样重放");
});

test("R4 真起代理：换模型后头两份 effectiveConfig.truncate.holdFreshCuts 是 true，第三份没有；没写时一个键都不多", async () => {
    const HER = "session-e795aff7-0000-4000-8000-0000000011c0";
    const HELPER = "session-e795aff7-0000-4000-8000-0000000011c1";
    const h = await startPluginHarness({ sessions: { [HER]: { modelContextLimit: 256_000, truncateHoldAfterSwitch: 2 } } }, { "deepseek-flash": { context: 1_048_576 }, "gemini-4-argon": { context: 1_048_576 } });
    try {
        const held = (sid: string) => (configOf(sid).truncate as { holdFreshCuts?: boolean }).holdFreshCuts;
        await sendPluginTurn(h, HER, { model: "gemini-4-argon" });
        assert.equal(held(HER), undefined, "第一份：没有可比的上一份");
        await sendPluginTurn(h, HER, { model: "deepseek-flash" });
        assert.equal(held(HER), true, "换模型这一份按住");
        assert.equal((peekSession(HER)!.metadata.truncateHoldAfterSwitch as { left: number }).left, 1);
        await sendPluginTurn(h, HER, { model: "deepseek-flash" });
        assert.equal(held(HER), true, "下一份照按");
        assert.equal("truncateHoldAfterSwitch" in peekSession(HER)!.metadata, false, "按完了键就删");
        await sendPluginTurn(h, HER, { model: "deepseek-flash" });
        assert.equal(held(HER), undefined, "第三份不按");
        // 没写这个键的会话：换模型也一个键都不多
        await sendPluginTurn(h, HELPER, { model: "gemini-4-argon" });
        await sendPluginTurn(h, HELPER, { model: "deepseek-flash" });
        assert.equal(held(HELPER), undefined);
        assert.equal("truncateHoldAfterSwitch" in peekSession(HELPER)!.metadata, false);
    } finally {
        await h.close();
    }
});

test("F6 / F7 真起代理：R4 关着、不在 input 模式时，留下的 truncateHoldAfterSwitch / modelWindow 下一份就删", async () => {
    const SID = "session-e795aff7-0000-4000-8000-0000000011d0";
    const h = await startPluginHarness({ sessions: { [SID]: { modelContextLimit: 256_000 } } });
    try {
        await sendPluginTurn(h, SID);
        const md = peekSession(SID)!.metadata;
        assert.equal("truncateHoldAfterSwitch" in md, false);
        assert.equal("modelWindow" in md, false);
        // 开过再关留下来的（r4-stale 那种）：left 还有 1，modelWindow 是过时的
        md.truncateHoldAfterSwitch = { left: 1, reason: "model", from: "gemini-4-argon@x", at: 1 };
        md.modelWindow = { limitMode: "input", judgeBase: 190_054, native: 262_144, safety: 0.85, quality: null, reserve: 32_768, target: 256_000, row: null };
        await sendPluginTurn(h, SID);
        const after = peekSession(SID)!.metadata;
        assert.equal("truncateHoldAfterSwitch" in after, false, "R4 关着：旧的按住状态删掉");
        assert.equal("modelWindow" in after, false, "window 模式：旧的 modelWindow 删掉");
        assert.equal((configOf(SID).truncate as { holdFreshCuts?: boolean }).holdFreshCuts, undefined, "这一份不按住");
    } finally {
        await h.close();
    }
});

test("F8 真起代理：设置页保存（PUT /__bili/config）和 reload 一样换 recordEstimate，当场生效", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-fish-models-f8-"));
    const cfgFile = path.join(root, "billion-context.json");
    writeFileSync(cfgFile, '{"providers":{}}\n', "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = cfgFile;
    setFishLedgerRecordEstimate(false);
    const h = await startPluginHarness({});
    const put = async (file: string): Promise<number> => {
        const r = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ file }) });
        await r.text();
        return r.status;
    };
    try {
        assert.equal(await put(JSON.stringify({ providers: {}, fishLedger: { recordEstimate: true } })), 200);
        assert.equal(fishLedgerRecordEstimateOn(), true, "保存以后当场是开着的（不用等下一份请求、不用 reload）");
        assert.equal(await put(JSON.stringify({ providers: {} })), 200);
        assert.equal(fishLedgerRecordEstimateOn(), false, "删掉以后当场关");
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        setFishLedgerRecordEstimate(false);
        await h.close();
        rmSync(root, { recursive: true, force: true });
    }
});

// ---------- 4. M7 ----------

test("M7：认得出前缀绑定那条 400；签名坏了的（没有后半句）不认；去思考不弄空消息", () => {
    assert.equal(isThinkingBindingError(400, BINDING_400), true);
    assert.equal(isThinkingBindingError(400, TAMPERED_400), false);
    assert.equal(isThinkingBindingError(500, BINDING_400), false);
    const body = JSON.stringify({ model: "claude-opus-5-5", thinking: { type: "adaptive" }, messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "redacted_thinking", data: "d" }, { type: "text", text: "a1" }] },
        { role: "user", content: "q2" },
    ] });
    const s = stripAnthropicThinking(body)!;
    assert.equal(s.stripped, 2);
    const parsed = JSON.parse(s.body);
    assert.deepEqual(parsed.messages[1].content, [{ type: "text", text: "a1" }]);
    assert.deepEqual(parsed.thinking, { type: "adaptive" }, "不在工具循环里：顶层 thinking 参数不动");
    assert.equal(s.thinkingOff, false);
    const onlyThinking = JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] }] });
    assert.equal(stripAnthropicThinking(onlyThinking), null, "最后一条只有思考：不改");
    assert.equal(stripAnthropicThinking(JSON.stringify({ messages: [{ role: "user", content: "x" }] })), null, "没有可去的");
    // RC-6：中间只有思考的那条整条去掉，不再整份放弃
    const midOnly = stripAnthropicThinking(JSON.stringify({ thinking: { type: "adaptive" }, messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] },
        { role: "user", content: "q2" },
    ] }))!;
    assert.equal(midOnly.dropped, 1);
    assert.deepEqual(JSON.parse(midOnly.body).messages.map((m: { role: string }) => m.role), ["user", "user"]);
    // RC-6：工具循环的最后一轮去掉了思考 → 顶层 thinking 一起去掉
    const loop = stripAnthropicThinking(JSON.stringify({ thinking: { type: "enabled", budget_tokens: 2048 }, messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "tool_use", id: "tu1", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "r" }] },
    ] }))!;
    assert.equal(loop.thinkingOff, true);
    assert.equal("thinking" in JSON.parse(loop.body), false);
    assert.deepEqual(JSON.parse(loop.body).messages[1].content, [{ type: "tool_use", id: "tu1", name: "read", input: {} }]);
    // 关着的 thinking：不碰
    const off = stripAnthropicThinking(JSON.stringify({ thinking: { type: "disabled" }, messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "tool_use", id: "tu1", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "r" }] },
    ] }))!;
    assert.equal(off.thinkingOff, false);
    assert.deepEqual(JSON.parse(off.body).thinking, { type: "disabled" });
});

/** The public Anthropic rule the fake endpoint now enforces (RC-6): with
 *  thinking on, the tool loop's last assistant turn must start with thinking. */
function finalTurnViolation(raw: string): boolean {
    let b: { thinking?: { type?: string }; messages?: Array<{ role: string; content: unknown }> };
    try { b = JSON.parse(raw); } catch { return false; }
    if (!b.thinking || b.thinking.type === "disabled" || !Array.isArray(b.messages) || b.messages.length === 0) return false;
    const last = b.messages[b.messages.length - 1]!;
    const loop = last.role === "user" && Array.isArray(last.content) && last.content.some((x: { type?: string }) => x?.type === "tool_result");
    if (!loop) return false;
    const a = [...b.messages].reverse().find((m) => m.role === "assistant");
    const first = a && Array.isArray(a.content) ? (a.content[0] as { type?: string } | undefined) : undefined;
    return !(first && (first.type === "thinking" || first.type === "redacted_thinking"));
}
const FINAL_TURN_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`. When `thinking` is enabled, a final `assistant` message must start with a thinking block." } });

function bindingReply(): UpstreamReply {
    return (hit) => {
        const raw = hit.raw.toString("utf8");
        if (raw.includes("\"thinking\",\"thinking\"") || raw.includes("\"type\":\"thinking\"")) {
            return { status: 400, headers: { "content-type": "application/json" }, body: BINDING_400 };
        }
        if (finalTurnViolation(raw)) return { status: 400, headers: { "content-type": "application/json" }, body: FINAL_TURN_400 };
        return anthropicSseReply({ input: 900, output: 5 });
    };
}

function thinkingTurn(): Record<string, unknown> {
    return {
        model: "model-test",
        max_tokens: 256,
        stream: true,
        thinking: { type: "adaptive" },
        system: "You are a test assistant.",
        messages: [
            { role: "user", content: [{ type: "text", text: "first fictional line" }] },
            { role: "assistant", content: [{ type: "thinking", thinking: "fictional thought", signature: "c2lnLWZpY3Rpb25hbA==" }, { type: "text", text: "ok" }] },
            { role: "user", content: [{ type: "text", text: "second fictional line" }] },
        ],
    };
}

test("M7 真起代理：开着——去掉思考重发一次、上游收下；关着——400 原样回去、只打一次上游", async () => {
    for (const on of [true, false]) {
        const sid = on ? "session-fictional-m7-on" : "session-fictional-m7-off";
        const h = await bringUpProxy(`m7-${on}`, { reply: bindingReply(), extra: { compress: { injectTool: false, injectNudge: false, ...(on ? { sessions: { [sid]: { anthropicThinkingBinding: "strip_retry" } } } : {}) } } as never });
        try {
            const r = await postAnthropic(h, sid, thinkingTurn(), { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid });
            if (on) {
                assert.equal(r.status, 200, r.text.slice(0, 300));
                assert.equal(h.hits.length, 2, "原请求 + 去思考重发一次");
                assert.ok(h.hits[0].raw.toString("utf8").includes("\"type\":\"thinking\""));
                assert.equal(h.hits[1].raw.toString("utf8").includes("\"type\":\"thinking\""), false, "重发的那份没有思考块");
                const m = peekSession(sid)?.metadata.thinkingStrip as { retries: number; accepted: number } | undefined;
                assert.deepEqual({ retries: m?.retries, accepted: m?.accepted }, { retries: 1, accepted: 1 });
            } else {
                assert.equal(r.status, 400);
                assert.match(r.text, /bound to a different conversation/);
                assert.equal(h.hits.length, 1, "关着：不重发");
                assert.equal("thinkingStrip" in (peekSession(sid)?.metadata ?? {}), false);
            }
        } finally {
            h.store.cancelAll();
            await closeServers([h.proxy, h.upstream], `m7 ${on}`);
            rmSync(h.root, { recursive: true, force: true });
        }
    }
});

test("M7 真起代理（RC-6）：工具循环里去掉思考时这一份不思考，假端点照最后一轮的规则也收下", async () => {
    const sid = "session-fictional-m7-loop";
    const h = await bringUpProxy("m7-loop", { reply: bindingReply(), extra: { compress: { injectTool: false, injectNudge: false, sessions: { [sid]: { anthropicThinkingBinding: "strip_retry" } } } } as never });
    try {
        const turn = thinkingTurn();
        turn.messages = [
            { role: "user", content: [{ type: "text", text: "first fictional line" }] },
            { role: "assistant", content: [{ type: "thinking", thinking: "fictional thought", signature: "c2lnLWZpY3Rpb25hbA==" }, { type: "tool_use", id: "toolu_fictional1", name: "read", input: { path: "a.txt" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fictional1", content: "fictional file text" }] },
        ];
        const r = await postAnthropic(h, sid, turn, { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid });
        assert.equal(r.status, 200, r.text.slice(0, 300));
        assert.equal(h.hits.length, 2, "原请求 + 去思考重发一次");
        const resent = JSON.parse(h.hits[1].raw.toString("utf8"));
        assert.equal("thinking" in resent, false, "重发的那份顶层不带 thinking");
        assert.equal(finalTurnViolation(h.hits[1].raw.toString("utf8")), false);
        // 假端点确实查这条：不去顶层 thinking 的那种去法会被它拒
        const naive = JSON.parse(h.hits[0].raw.toString("utf8"));
        for (const m of naive.messages) if (m.role === "assistant" && Array.isArray(m.content)) m.content = m.content.filter((b: { type?: string }) => b.type !== "thinking");
        assert.equal(finalTurnViolation(JSON.stringify(naive)), true);
    } finally {
        h.store.cancelAll();
        await closeServers([h.proxy, h.upstream], "m7 loop");
        rmSync(h.root, { recursive: true, force: true });
    }
});

// ---------- 5. M8 ----------

test("M8 内核：传了 aliases 才认 `reasoning`，写回时用原来的字段名；不传和上游一样", () => {
    const body = { messages: [
        { role: "user" as const, content: "q" },
        { role: "assistant" as const, content: "a", reasoning: "vllm thought" } as Record<string, unknown>,
        { role: "user" as const, content: "q2" },
        { role: "assistant" as const, content: "b", reasoning_content: "ds thought" },
        { role: "user" as const, content: "q3" },
    ] } as unknown as Parameters<typeof openaiToCore>[0];
    const plain = openaiToCore(body);
    assert.equal(plain.msgs.filter((m) => m.contentType === "reasoning").length, 1, "上游：只认 reasoning_content");
    const out0 = coreToOpenai(plain.msgs) as Array<Record<string, unknown>>;
    assert.equal(out0.some((m) => "reasoning" in m), false, "上游：vLLM 的 reasoning 在外发里丢了");
    const aliased = openaiToCore(body, { reasoningAliases: ["reasoning", "reasoning_text"] });
    const rs = aliased.msgs.filter((m) => m.contentType === "reasoning");
    assert.equal(rs.length, 2);
    assert.equal(rs[0].reasoningField, "reasoning");
    assert.equal(rs[1].reasoningField, undefined, "本来就是 reasoning_content 的不记");
    const out = coreToOpenai(aliased.msgs) as Array<Record<string, unknown>>;
    const asst = out.filter((m) => m.role === "assistant");
    assert.equal(asst[0].reasoning, "vllm thought");
    assert.equal("reasoning_content" in asst[0], false, "不改名");
    assert.equal(asst[1].reasoning_content, "ds thought");
    // 同一段思考：id 和走 reasoning_content 时一样（不进身份）
    const viaCanonical = openaiToCore({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a", reasoning_content: "vllm thought" }] } as never);
    assert.equal(rs[0].id, viaCanonical.msgs.find((m) => m.contentType === "reasoning")!.id);
});

function openaiReply(): UpstreamReply {
    return (hit) => {
        const raw = hit.raw.toString("utf8");
        let parsed: { messages?: Array<{ content?: unknown }> } = {};
        try { parsed = JSON.parse(raw); } catch { /* */ }
        // vLLM 的图片墙（--limit-mm-per-prompt image=2）
        const imgs = (raw.match(/"image_url"/g) ?? []).length;
        if (imgs > 2) return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ object: "error", message: "At most 2 image(s) may be provided in one prompt.", type: "BadRequestError", param: null, code: 400 }) };
        void parsed;
        const body = JSON.stringify({ id: "c1", object: "chat.completion", model: "scarletkc", choices: [{ index: 0, message: { role: "assistant", content: "ok", reasoning: "vllm side thought" }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 4, total_tokens: 124 } });
        return { status: 200, headers: { "content-type": "application/json" }, body };
    };
}

async function postOpenai(h: { origin: string; upstreamUrl: string }, sid: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const res = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sid, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid },
        body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
}

function vllmTurn(images = 0): Record<string, unknown> {
    const img = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } };
    return {
        model: "model-test",
        max_tokens: 256,
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: images > 0 ? [{ type: "text", text: "first fictional line" }, ...Array.from({ length: images }, () => img)] : "first fictional line" },
            { role: "assistant", content: "ok", reasoning: "fictional vllm reasoning about the first line" },
            { role: "user", content: "second fictional line" },
        ],
    };
}

test("M8 真起代理（假的 vLLM 端点）：开着时外发保留 `reasoning`；关着时和上游一样（外发里没有）", async () => {
    for (const on of [true, false]) {
        const sid = on ? "session-fictional-m8-on" : "session-fictional-m8-off";
        const h = await bringUpProxy(`m8-${on}`, { reply: openaiReply(), extra: { compress: { injectTool: false, injectNudge: false, ...(on ? { sessions: { [sid]: { openaiReasoningAliases: true } } } : {}) } } as never });
        try {
            const r = await postOpenai(h, sid, vllmTurn());
            assert.equal(r.status, 200, r.text.slice(0, 300));
            assert.equal(h.hits.length, 1);
            const sent = JSON.parse(h.hits[0].raw.toString("utf8")) as { messages: Array<Record<string, unknown>> };
            const asst = sent.messages.find((m) => m.role === "assistant")!;
            if (on) {
                assert.equal(asst.reasoning, "fictional vllm reasoning about the first line", "开着：原字段名、原文");
                assert.equal("reasoning_content" in asst, false);
            } else {
                assert.equal("reasoning" in asst, false, "关着：上游今天的行为（vLLM 的 reasoning 不认、外发里没了）");
            }
        } finally {
            h.store.cancelAll();
            await closeServers([h.proxy, h.upstream], `m8 ${on}`);
            rmSync(h.root, { recursive: true, force: true });
        }
    }
});

// ---------- 6. 图片墙 ----------

test("图片墙：vLLM 原句「At most N image(s)」认得出（合并那一轮补的）；「images」写法照旧认得出", () => {
    const vllm = inspectContextOverflow(400, JSON.stringify({ object: "error", message: "At most 128 image(s) may be provided in one prompt.", type: "BadRequestError", code: 400 }));
    assert.equal(vllm.imageCountCap, 128, "image(s) 的写法认得出");
    const single = inspectContextOverflow(400, "At most 1 image may be provided in one prompt.");
    assert.equal(single.imageCountCap, 1);
    const plural = inspectContextOverflow(400, "At most 128 images may be provided in one prompt.");
    assert.equal(plural.imageCountCap, 128);
});

test("图片墙 真起代理（假的 vLLM 端点）：3 张图撞「At most 2 image(s)」，代理学到墙（2）、少带图重发一次，上游收下", async () => {
    const sid = "session-fictional-imgwall";
    const h = await bringUpProxy("imgwall", { reply: openaiReply(), extra: { compress: { injectTool: false, injectNudge: false } } as never });
    try {
        const r = await postOpenai(h, sid, vllmTurn(3));
        assert.equal(r.status, 200, r.text.slice(0, 300));
        const caps = (peekSession(sid)?.stats as { imageCountCaps?: Record<string, number> } | undefined)?.imageCountCaps;
        assert.ok(caps && Object.values(caps).includes(2), "学到了墙：2");
        assert.equal(h.hits.length, 2, "撞墙一次、重发一次");
        const imgsOf = (i: number): number => (h.hits[i]!.raw.toString("utf8").match(/"type":"image_url"/g) ?? []).length;
        assert.equal(imgsOf(0), 3);
        assert.ok(imgsOf(1) <= 2, "重发的那份不超过墙");
    } finally {
        h.store.cancelAll();
        await closeServers([h.proxy, h.upstream], "imgwall");
        rmSync(h.root, { recursive: true, force: true });
    }
});

// ---------- 7. M6 ----------

type Row = Record<string, unknown> & { ref: Record<string, unknown>; data: Record<string, unknown> };
function makeLedgerRoot(): { parent: string; root: string } {
    const parent = mkdtempSync(path.join(tmpdir(), "fishledger-m6-"));
    const root = path.join(parent, "ledger");
    mkdirSync(path.join(root, "proxy"), { recursive: true });
    writeFileSync(path.join(root, "meta.json"), JSON.stringify({ schema: 1, epoch: 1, createdAt: "2026-11-20T03:00:00.000Z", tzOffsetMin: 540, by: "test", owner: { qqPrivate: "h00112233445566ff" } }));
    writeFileSync(path.join(root, "salt"), "5c".repeat(32) + "\n");
    writeFileSync(path.join(root, "proxy", "enabled"), "{}");
    return { parent, root };
}
function rows(root: string): Row[] {
    const dir = path.join(root, "proxy");
    const out: Row[] = [];
    for (const f of readdirSync(dir).filter((n) => /^ledger-.*\.jsonl$/.test(n)).sort()) {
        for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) if (line !== "") out.push(JSON.parse(line) as Row);
    }
    return out;
}

test("M6 真起代理：recordEstimate 开着时 usage provider 行多一个 data.est（只有数）；关着时没有这个键", async () => {
    for (const on of [true, false]) {
        const { parent, root } = makeLedgerRoot();
        const saved = process.env.FISH_LEDGER_DIR;
        _resetFishLedgerForTest();
        process.env.FISH_LEDGER_DIR = root;
        const h = await bringUpProxy(`m6-${on}`, { reply: () => anthropicSseReply({ input: 40, cacheRead: 900, cacheWrite: 60, output: 7 }), extra: { compress: { injectTool: true, injectNudge: false }, ...(on ? { fishLedger: { recordEstimate: true } } : {}) } as never });
        try {
            for (let i = 0; i < 2; i++) {
                const r = await postAnthropic(h, "session-fictional-m6", anthropicTurn(`fictional question ${i}`, { stream: true }));
                assert.equal(r.status, 200, r.text.slice(0, 300));
            }
            const us = rows(root).filter((x) => x.kind === "usage");
            assert.equal(us.length, 2);
            if (on) {
                for (const u of us) {
                    const est = u.data.est as Record<string, unknown>;
                    assert.ok(est && typeof est === "object", "有 est");
                    assert.deepEqual(Object.keys(est).sort(), ["imageTokens", "images", "k", "text", "textSide"]);
                    for (const v of Object.values(est)) assert.ok(v === null || typeof v === "number", "只有数");
                }
                assert.equal(typeof (us[1].data.est as { text: unknown }).text, "number", "第二份：配对的本地文字估计在");
            } else {
                assert.ok(us.every((u) => !("est" in u.data)), "关着：没有 est 这个键");
            }
        } finally {
            h.store.cancelAll();
            await closeServers([h.proxy, h.upstream], `m6 ${on}`);
            rmSync(h.root, { recursive: true, force: true });
            stopFishLedger("test");
            _resetFishLedgerForTest();
            setFishLedgerRecordEstimate(false);
            if (saved === undefined) delete process.env.FISH_LEDGER_DIR;
            else process.env.FISH_LEDGER_DIR = saved;
            rmSync(parent, { recursive: true, force: true });
        }
    }
});

test("M6 不起代理：recordEstimate 关着时 noteOutboundContextEstimates 不留东西；resolveSessionCompressOverride 认新键", () => {
    setFishLedgerRecordEstimate(false);
    const s = makeSession();
    noteOutboundContextEstimates(s, { upperBound: 10, scaledText: 5, imageTokens: 3, calibrated: false });
    assert.equal(s.stats.contextEstimateTokens, 8);
    const r = resolveSessionCompressOverride({ sessions: { [HER]: { limitMode: "input" } } }, [HER]);
    assert.equal(r?.override.limitMode, "input");
});
