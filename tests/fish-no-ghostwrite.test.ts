// fork（养成向）：「不代写」开关（compress.noGhostwrite / compress.sessions.<id>.noGhostwrite）。
//
// 陪伴会话里摘要就是她以后的记忆，作者必须是她。上游代理越线时会替模型写摘要：
// preflight 代写（模型摘要 / 外部摘要服务 / 确定性摘要 / 分层合并）、
// externalSummary 模式替她的 compress 补写、autoFold 增长折叠。开关开着时这些路
// 一律不走，只催她自己压；每次本来要代写的地方记一个数。默认关 = 和上游一样。
//
// 这份测试守住：
//   1. 配置：三级合并和按会话覆盖都能写；不写时解出来的 Config 里根本没有这个键。
//   2. 外露面：开关开着时 externalSummary 模式、autoFold 都算关，催压不再被压住。
//   3. preflight：开关开着时不发任何摘要请求（外部链、主模型都不打），记 preflight 计数；
//      对照组（不开）照旧代写。
//   4. 她自己的 compress 在 externalSummary 模式下：开关开着时只收她自己写的摘要，
//      没写摘要就拒；外部服务一次都不打；记 externalSummary 计数。
//   5. 真起代理：同一个上游、同一个上限，开了开关的会话越线时只转发、不代写，
//      请求里带着催压；没开的会话照旧代写；放不进模型真实窗口时 413，也不代写。
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

process.env.NODE_ENV = "test";

const { createCore, defaultConfig, defaultPrompts } = await import("acp-kernel");
type Config = import("acp-kernel").Config;
type CoreMessage = import("acp-kernel").CoreMessage;
const { applyConfiguredCompression } = await import("../src/external-summary-compress.ts");
const { SummaryCredentialStore } = await import("../src/external-summary-credentials.ts");
const { preflightCompress } = await import("../src/preflight.ts");
const { createSession, peekSession } = await import("../src/session.ts");
const { _setSummaryRetryDelayForTest } = await import("../src/external-summary-http.ts");
const { autoFoldEngaged, autoFoldWanted, externalSummaryEnabled, growthFoldingArmed } = await import("../src/external-summary-surface.ts");
const { noGhostwriteCounts, noGhostwriteOn, noteGhostwriteBlocked, NO_GHOSTWRITE_METADATA_KEY, NO_GHOSTWRITE_MIN_OUTPUT } = await import("../src/no-ghostwrite.ts");
const { parseCompressSettings } = await import("../src/config.ts");
const { applySessionCompressOverride, resolveRequestConfig } = await import("../src/compress-settings.ts");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { rmrf } = await import("./tmp-rm.ts");
type RewriteCtx = import("../src/stream.ts").RewriteCtx;
type ProxyOptions = import("../src/config.ts").ProxyOptions;

afterEach(() => { _setSummaryRetryDelayForTest(null); });

const HER_SUMMARY = "她自己写的摘要：2026-11-15 下午和兔聊了天，记下了要紧的几件事，原话还在，细节用 decompress 取。".repeat(3);
const SERVICE_SUMMARY = "SERVICE-WROTE-THIS summary text that must never be committed while no-ghostwrite is on. ".repeat(3);
const RAW = "Historical source src/example.ts:27 E_TEST; do not deploy; still add tests. ".repeat(90);

// ---------- 1. 配置 ----------

test("配置：不写时解出来的 Config 没有 noGhostwrite 这个键；三级都能写；按会话覆盖两头都赢", () => {
    const base = defaultConfig(200_000);
    const plain = resolveRequestConfig(base, {}, undefined, "m", 200_000, { nudgeGrowthTokens: 50_000 });
    assert.equal("noGhostwrite" in plain, false, "没配：键都不出现（和上游逐字段一样）");
    assert.equal(noGhostwriteOn(plain), false);
    const routes = { "http://up": { models: { m: { context: 200_000, compress: { noGhostwrite: true } } } } };
    const modelLevel = resolveRequestConfig(base, routes, "http://up", "m", 200_000, { noGhostwrite: false });
    assert.equal(noGhostwriteOn(modelLevel), true, "模型一级 true 赢过全局 false");
    const sessionOff = applySessionCompressOverride(modelLevel, { noGhostwrite: false }, 200_000);
    assert.equal(noGhostwriteOn(sessionOff), false, "按会话 false 赢过模型一级 true");
    const sessionOn = applySessionCompressOverride(plain, { noGhostwrite: true }, 200_000);
    assert.equal(noGhostwriteOn(sessionOn), true, "按会话 true");
    assert.equal(sessionOn.modelContextLimit, plain.modelContextLimit, "只开开关不动上限");
    assert.equal(parseCompressSettings({ noGhostwrite: true })?.noGhostwrite, true);
    assert.equal(parseCompressSettings({ noGhostwrite: "yes" }), undefined, "不是布尔就整块拒");
    assert.deepEqual(parseCompressSettings({ sessions: { s1: { noGhostwrite: true, modelContextLimit: 256_000 } } })?.sessions, { s1: { noGhostwrite: true, modelContextLimit: 256_000 } });
    assert.equal(parseCompressSettings({ sessions: { s1: { noGhostwrite: 1 } } }), undefined);
    assert.equal(noGhostwriteOn({ noGhostwrite: "true" }), false, "只认真正的 true");
});

test("计数：从零开始累加，记最后一次的时间和路；坏数据当零", () => {
    const s = { metadata: {} as Record<string, unknown> };
    assert.deepEqual(noGhostwriteCounts(s), { preflight: 0, externalSummary: 0, autoFold: 0, outputClamped: 0 });
    noteGhostwriteBlocked(s, "preflight", new Date("2026-11-15T12:00:00Z"));
    noteGhostwriteBlocked(s, "preflight", new Date("2026-11-15T12:01:00Z"));
    const c = noteGhostwriteBlocked(s, "autoFold", new Date("2026-11-15T12:02:00Z"));
    assert.deepEqual(c, { preflight: 2, externalSummary: 0, autoFold: 1, outputClamped: 0, lastAt: "2026-11-15T12:02:00.000Z", lastPath: "autoFold" });
    assert.deepEqual(noGhostwriteCounts(s), c, "存在 metadata 里，读回来一样");
    s.metadata[NO_GHOSTWRITE_METADATA_KEY] = { preflight: "x", autoFold: -3 };
    assert.deepEqual(noGhostwriteCounts(s), { preflight: 0, externalSummary: 0, autoFold: 0, outputClamped: 0 });
});

// ---------- 2. 外露面 ----------

test("外露面：开关开着时 externalSummary 模式和 autoFold 都算关（催压不再被 autoFold 压住）", () => {
    const ext = { enabled: true, autoFold: true, targets: [] };
    const on = { ...defaultConfig(200_000), externalSummary: ext, noGhostwrite: true };
    const off = { ...defaultConfig(200_000), externalSummary: ext };
    const session = { metadata: {} };
    assert.equal(externalSummaryEnabled(off), true);
    assert.equal(externalSummaryEnabled(on), false);
    assert.equal(autoFoldEngaged(off, session), true);
    assert.equal(autoFoldEngaged(on, session), false, "开关开着：不算 engaged → prepare 照常注入催压");
    assert.equal(autoFoldWanted(on, session), true, "运维想要的还在（server.ts 拿它数被拦下的增长折叠）");
    assert.equal(growthFoldingArmed(off), true);
    assert.equal(growthFoldingArmed(on), false);
});

// ---------- 3 / 4. preflight 和 externalSummary 模式下她自己的 compress ----------

function context(externalSummary?: unknown, noGhostwrite?: boolean): RewriteCtx {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { externalSummary?: unknown; noGhostwrite?: boolean };
    if (externalSummary !== undefined) config.externalSummary = externalSummary;
    if (noGhostwrite !== undefined) config.noGhostwrite = noGhostwrite;
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const session = createSession(`no-ghostwrite-${Math.random()}`);
    const messages: CoreMessage[] = [
        { id: "history", role: "assistant", contentType: "text", text: RAW },
        { id: "current-task", role: "user", contentType: "text", text: "Current task: keep chatting." },
    ];
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} };
}

function args(ctx: RewriteCtx, summary?: string): Record<string, unknown> {
    return { content: [{ startId: ctx.session.state.messageRefs.byRaw.history, endId: ctx.session.state.messageRefs.byRaw.history, ...(summary !== undefined ? { summary } : {}) }] };
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
async function fixture(run: (base: string, externalSummary: Record<string, unknown>) => Promise<void>, handler: Handler): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "bili-no-ghostwrite-"));
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = join(root, "config.json");
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => handler(req, res));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const externalSummary = { enabled: true, targets: [{ name: "primary", protocol: "responses", url: `${base}/primary`, model: "summary-primary", credentialRef: "secret:primary" }] };
    new SummaryCredentialStore().set("primary", "test-primary-key");
    try { await run(base, externalSummary); }
    finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmrf(root);
    }
}
function serviceSuccess(res: http.ServerResponse): void {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output_text: SERVICE_SUMMARY }));
}

test("preflight：开关开着时外部链和主模型都不打，记 preflight 计数；对照组照旧代写", async () => {
    const paths: string[] = [];
    await fixture(async (base, externalSummary) => {
        for (const withChain of [true, false]) {
            const ctx = context(withChain ? externalSummary : undefined, true);
            ctx.config.modelContextLimit = 1000;
            ctx.session.stats.lastInputTokens = 10000;
            const logs: string[] = [];
            const result = await preflightCompress({ core: ctx.core, config: ctx.config, session: ctx.session,
                prompts: defaultPrompts, protocol: "responses", url: `${base}/main-must-not-summarize`, headers: {},
                model: "main-model", log: (_l, m) => { logs.push(m); } }, ctx.messages);
            assert.equal(result.compressedRanges, 0);
            assert.equal(result.ghostwriteBlocked, true);
            assert.equal(result.fitsWindow, false, "越线了：交回调用方决定转发还是拒");
            assert.equal(ctx.session.state.blocks.length, 0, "一块都没折");
            assert.equal(noGhostwriteCounts(ctx.session).preflight, 1);
            assert.ok(logs.some((l) => l.includes("[no-ghostwrite]")), logs.join("\n"));
        }
        assert.deepEqual(paths, [], "开关开着：一个摘要请求都没发");
        // 对照组：同样的状态，不开开关 → 外部链被打、折出一块（上游原样的代写）
        const ctx = context(externalSummary);
        ctx.config.modelContextLimit = 1000;
        ctx.session.stats.lastInputTokens = 10000;
        const result = await preflightCompress({ core: ctx.core, config: ctx.config, session: ctx.session,
            prompts: defaultPrompts, protocol: "responses", url: `${base}/main-must-not-summarize`, headers: {},
            model: "main-model", log: () => {} }, ctx.messages);
        assert.ok(result.compressedRanges > 0, JSON.stringify(result));
        assert.ok(paths.length > 0 && paths.every((p) => p === "/primary"));
        assert.equal(result.ghostwriteBlocked, undefined);
        assert.deepEqual(noGhostwriteCounts(ctx.session), { preflight: 0, externalSummary: 0, autoFold: 0, outputClamped: 0 }, "没开开关：不记数");
    }, (req, res) => { paths.push(req.url ?? ""); serviceSuccess(res); });
});

test("preflight：开关开着、但载荷按自己的估计放得下（#4288 那条出口）——本来也不会代写，不记数", async () => {
    const paths: string[] = [];
    await fixture(async (base, externalSummary) => {
        const ctx = context(externalSummary, true);
        ctx.config.modelContextLimit = 100_000;
        ctx.session.stats.lastInputTokens = 200_000; // 上一个模型 / 路线量的旧计费，比窗口大
        ctx.session.stats.lastInputTokensSource = "usage";
        const result = await preflightCompress({ core: ctx.core, config: ctx.config, session: ctx.session,
            prompts: defaultPrompts, protocol: "responses", url: `${base}/main-must-not-summarize`, headers: {},
            model: "main-model", log: () => {} }, ctx.messages);
        assert.equal(result.compressedRanges, 0);
        assert.equal(result.ghostwriteBlocked, undefined, "走的是放得下的出口，不是被开关拦下");
        assert.deepEqual(noGhostwriteCounts(ctx.session), { preflight: 0, externalSummary: 0, autoFold: 0, outputClamped: 0 });
        assert.deepEqual(paths, []);
    }, (req, res) => { paths.push(req.url ?? ""); serviceSuccess(res); });
});

test("externalSummary 模式下她的 compress：开关开着只收她自己写的摘要，没写就拒，外部服务一次都不打", async () => {
    let calls = 0;
    await fixture(async (_base, externalSummary) => {
        const ctx = context(externalSummary, true);
        const result = await applyConfiguredCompression(args(ctx, HER_SUMMARY), ctx);
        assert.equal(result.outcome, "applied", result.text);
        assert.equal(ctx.session.state.blocks[0].summary, HER_SUMMARY, "存下来的是她写的那份");
        assert.equal(noGhostwriteCounts(ctx.session).externalSummary, 1);
        const bare = context(externalSummary, true);
        const refused = await applyConfiguredCompression(args(bare), bare);
        assert.notEqual(refused.outcome, "applied", "没写摘要：不替她补");
        assert.equal(bare.session.state.blocks.length, 0);
        assert.equal(calls, 0, "外部摘要服务一次都没打");
        // 对照：不开开关，外部服务照旧把它的摘要写进去（上游行为）
        const off = context(externalSummary);
        const applied = await applyConfiguredCompression(args(off, HER_SUMMARY), off);
        assert.equal(applied.outcome, "applied", applied.text);
        assert.equal(off.session.state.blocks[0].summary, SERVICE_SUMMARY);
        assert.equal(calls, 1);
    }, (_req, res) => { calls++; serviceSuccess(res); });
});

// ---------- 5. 真起代理 ----------

const HER = "session-nogw-her";
const HELPER = "session-nogw-helper";
// 413 那一条用新的会话：上一条测试留下的会话带着上游回的 usage（换了端口就降成
// 「不作数」），会走 #2313「先转发一次拿证据」那条路——那也不代写，但测不到 413。
const HER_FRESH = "session-nogw-her-fresh";

type Seen = { kind: "main" | "summary"; body: string };

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startHarness(globalCompress: Record<string, unknown>, routeContext: number) {
    const seen: Seen[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let body: { messages?: unknown[]; tools?: unknown[]; stream?: boolean } = {};
            try { body = JSON.parse(raw); } catch { /* */ }
            const isSummary = Array.isArray(body.messages) && body.messages.length === 1 && !body.tools;
            seen.push({ kind: isSummary ? "summary" : "main", body: raw });
            const text = isSummary ? "PROXY-GHOSTWRITTEN summary: " + "x".repeat(400) : "ok";
            if (body.stream !== true) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_g", type: "message", role: "assistant", model: "deepseek-flash", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: "msg_g", role: "assistant", usage: { input_tokens: 100 } } }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
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
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-flash": { context: routeContext } } } },
        modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, ...globalCompress },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        seen,
        async send(conversationId: string): Promise<number> {
            return (await this.sendFull(conversationId)).status;
        },
        async sendBody(conversationId: string, body: unknown): Promise<{ status: number; text: string }> {
            const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId },
                body: JSON.stringify(body),
            });
            return { status: resp.status, text: await resp.text() };
        },
        async sendFull(conversationId: string): Promise<{ status: number; text: string }> {
            const messages: unknown[] = [];
            for (let i = 0; i < 14; i++) {
                messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `第 ${i} 段：` + `闲聊内容 ${i} `.repeat(220) });
            }
            messages.push({ role: "user", content: "现在接着聊。" });
            const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId },
                body: JSON.stringify({ model: "deepseek-flash", max_tokens: 1024, stream: true, messages }),
            });
            const text = await resp.text();
            return { status: resp.status, text };
        },
        async close() {
            proxy.close(); proxy.closeIdleConnections?.(); await once(proxy, "close");
            upstream.close(); upstream.closeIdleConnections?.(); await once(upstream, "close");
        },
    };
}

test("真起代理：同一个上限下，开了开关的会话越线只转发（带催压）、不代写；没开的会话照旧代写", async () => {
    const h = await startHarness({ modelContextLimit: 4000, sessions: { [HER]: { noGhostwrite: true } } }, 1_048_576);
    try {
        assert.equal(await h.send(HER), 200);
        const herSeen = h.seen.splice(0);
        assert.deepEqual(herSeen.map((s) => s.kind), ["main"], "她：只有一条正式请求，没有任何代写摘要请求");
        assert.match(herSeen[0]!.body, /compress/i, "越线的那一轮带着催压");
        const her = peekSession(HER);
        assert.ok(her);
        assert.ok(noGhostwriteCounts(her).preflight >= 1, JSON.stringify(her!.metadata[NO_GHOSTWRITE_METADATA_KEY]));
        assert.equal(her!.state.blocks.filter((b) => b.active).length, 0, "她的会话一块都没被代理折");

        assert.equal(await h.send(HELPER), 200);
        const helperSeen = h.seen.splice(0);
        assert.ok(helperSeen.some((s) => s.kind === "summary"), `帮手（没开开关）：代理照旧代写（${helperSeen.map((s) => s.kind).join(",")}）`);
        const helper = peekSession(HELPER);
        assert.deepEqual(noGhostwriteCounts(helper), { preflight: 0, externalSummary: 0, autoFold: 0, outputClamped: 0 }, "没开开关不记数");
    } finally {
        await h.close();
    }
});

test("真起代理：开了开关、请求连模型真实窗口都放不下时 413，也不代写", async () => {
    const h = await startHarness({ sessions: { [HER_FRESH]: { noGhostwrite: true, modelContextLimit: 3000 } } }, 5000);
    try {
        const { status, text } = await h.sendFull(HER_FRESH);
        // 预检拖得久时代理会先回 200 占住连接，错误改走流里的 error 事件（#568），
        // 所以认「413，或者 200 + 流里那条同样的错误」。
        assert.ok(status === 413 || status === 200, String(status));
        assert.match(text, /no-ghostwrite is on for this session/, text.slice(0, 400));
        assert.match(text, /preflight_compress_failed|"retryable":false/);
        assert.deepEqual(h.seen.map((s) => s.kind), [], "上游一次都没打（没代写，也没硬发）");
        assert.ok(noGhostwriteCounts(peekSession(HER_FRESH)).preflight >= 1);
    } finally {
        await h.close();
    }
});

// ---------- 审查后（M1）：只开不代写、不设上限时没有「零宽的转发带」 ----------
//
// 没设按会话上限时，触发线（预留输出后的窗口 = 真实窗口 − max_tokens）和「载荷 +
// 输出预算放得进真实窗口」那条线重合：原来越线第一次就 413、之后每轮都 413。现在
// 载荷本身放得进、只是加上这次的输出预算放不进时，把这次请求的输出预算收小再转发。

// 固定种子的伪随机十六进制词（分词器压不小），三段各约 4.8 万字，合起来约 3.9 万 token。
function noiseWords(seed: number, chars: number): string {
    let x = seed >>> 0;
    const out: string[] = [];
    let n = 0;
    while (n < chars) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        const w = x.toString(16);
        out.push(w);
        n += w.length + 1;
    }
    return out.join(" ");
}
function bigHistory(): unknown[] {
    return [
        { role: "user", content: "开始" },
        { role: "assistant", content: [{ type: "text", text: "我去读一下。" }, { type: "tool_use", id: "toolu_r1", name: "read", input: { path: "notes.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_r1", content: "TOOL-OUTPUT\n" + noiseWords(1, 48_000) }] },
        { role: "assistant", content: "HER-OWN-WORDS " + noiseWords(2, 48_000) },
        { role: "user", content: "CAT-WORDS " + noiseWords(3, 48_000) },
        { role: "assistant", content: "好。" },
        { role: "user", content: "现在接着聊。" },
    ];
}
const BIG_TOOLS = [
    { name: "read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "compress", description: "compress", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
    { name: "decompress", description: "decompress", input_schema: { type: "object", properties: { blockId: { type: "string" } } } },
    { name: "acp_status", description: "status", input_schema: { type: "object", properties: {} } },
];

test("真起代理（审查 M1）：只开不代写、不设上限，载荷放得进真实窗口但加上输出预算放不进——收小这次的输出预算再转发，不再 413；计数 outputClamped", async () => {
    // 真实窗口 50,000、max_tokens 12,500：预留以后 37,500；载荷约 3.9 万，越过 37,500。
    const ZB = "session-nogw-zero-band";
    const h = await startHarness({ sessions: { [ZB]: { noGhostwrite: true } } }, 50_000);
    try {
        const { status, text } = await h.sendBody(ZB, { model: "deepseek-flash", max_tokens: 12_500, stream: true, tools: BIG_TOOLS, messages: bigHistory() });
        assert.equal(status, 200, text.slice(0, 300));
        assert.doesNotMatch(text, /no-ghostwrite is on for this session/);
        const seen = h.seen.splice(0);
        assert.deepEqual(seen.map((s) => s.kind), ["main"], "上游只收到这一条正式请求，没有代写摘要请求");
        const sent = JSON.parse(seen[0]!.body) as { max_tokens: number };
        assert.ok(sent.max_tokens < 12_500, `输出预算收小了（${sent.max_tokens}）`);
        assert.ok(sent.max_tokens >= NO_GHOSTWRITE_MIN_OUTPUT, `收小以后不低于 ${NO_GHOSTWRITE_MIN_OUTPUT}（够她调一次 compress）：${sent.max_tokens}`);
        const s = peekSession(ZB)!;
        assert.equal(s.metadata.effectiveContextLimit, 50_000);
        assert.equal(s.metadata.reservedContextLimit, 37_500);
        const c = noGhostwriteCounts(s);
        assert.equal(c.outputClamped, 1, JSON.stringify(c));
        assert.ok(c.preflight >= 1, "越线那一轮照样记成「本来要代写」");
        assert.equal(s.state.blocks.filter((b) => b.active).length, 0, "一块都没替她折");
        assert.equal(s.stats.lastOutputClamp?.capped, sent.max_tokens);
    } finally {
        await h.close();
    }
});

test("真起代理（审查 M1，对照）：同一份历史，真实窗口小到连 4096 的输出都放不下时照旧 413，上游一次都不打", async () => {
    const ZB2 = "session-nogw-zero-band-tight";
    const h = await startHarness({ sessions: { [ZB2]: { noGhostwrite: true } } }, 39_500);
    try {
        const { status, text } = await h.sendBody(ZB2, { model: "deepseek-flash", max_tokens: 12_500, stream: true, tools: BIG_TOOLS, messages: bigHistory() });
        assert.ok(status === 413 || status === 200, String(status));
        assert.match(text, /no-ghostwrite is on for this session/, text.slice(0, 400));
        assert.deepEqual(h.seen.map((s) => s.kind), [], "上游一次都没打");
        assert.equal(noGhostwriteCounts(peekSession(ZB2)).outputClamped, 0);
    } finally {
        await h.close();
    }
});

// ---------- autoFold（照 tests/external-summary-autofold.test.ts 第一条搭） ----------

function autofoldConversation(pairs: number): unknown[] {
    const filler = "0123456789abcdef".repeat(280);
    const messages: unknown[] = [];
    for (let i = 0; i < pairs; i++) {
        messages.push({ role: "user", content: [{ type: "text", text: `doc chunk ${i}: ${filler}` }] });
        messages.push({ role: "assistant", content: [{ type: "text", text: `ack ${i}` }] });
    }
    messages.push({ role: "user", content: [{ type: "text", text: "final question" }] });
    return messages;
}

test("autoFold：开关开着时外部链一次都不打、历史不折、催压照常进请求，记 autoFold 计数", async () => {
    const mainBodies: string[] = [];
    const main = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            mainBodies.push(raw);
            // 和上游那份测试一样「老实」计费：大请求记 42000，第二轮落进 ≈86% 的压力档
            const billed = raw.length > 100_000 ? 42_000 : 1_000;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":${billed}}}}\n\n`);
            res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`);
            res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
            res.end();
        });
    });
    main.listen(0, "127.0.0.1"); await once(main, "listening");
    let sumCalls = 0;
    const sum = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            sumCalls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: "SUMMARY written by the external chain." }, finish_reason: "stop" }] }));
        });
    });
    sum.listen(0, "127.0.0.1"); await once(sum, "listening");
    const mainUrl = `http://127.0.0.1:${(main.address() as import("node:net").AddressInfo).port}`;
    const sumUrl = `http://127.0.0.1:${(sum.address() as import("node:net").AddressInfo).port}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    process.env.E2E_SUM_KEY = "k";
    const server = await startServer({
        port: 0, host: "127.0.0.1", upstream: mainUrl,
        routes: { [mainUrl]: { models: { "test-model": { context: 50_000 } } } },
        modelContextLimit: 50_000,
        kernelConfig: defaultConfig(50_000, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: {
            injectTool: true, injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"], autoFold: true, autoFoldTargetTokens: 8192 },
            noGhostwrite: true,
        },
        namedProviders: { sum: { baseUrl: sumUrl, api: "openai", apiKeyEnv: "E2E_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
        for (let turn = 0; turn < 2; turn++) {
            const res = await fetch(`http://127.0.0.1:${port}/bili/${mainUrl}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-api-key": "k", "anthropic-version": "2023-06-01", "x-acp-session": "autofold-nogw" },
                body: JSON.stringify({ model: "test-model", max_tokens: 1024, stream: true, messages: autofoldConversation(36) }),
            });
            await res.text();
            assert.equal(res.status, 200);
        }
        assert.equal(sumCalls, 0, "外部摘要链一次都没打");
        const forwarded = JSON.parse(mainBodies.at(-1)!) as { messages: unknown[] };
        assert.ok(forwarded.messages.length >= 45, `历史没被折（${forwarded.messages.length} 条）`);
        assert.ok(mainBodies.at(-1)!.includes("Context breakdown:"), "催压照常进了请求（autoFold 不再把它压住）");
        const s = peekSession("autofold-nogw");
        assert.ok(s, "会话已建");
        assert.ok(noGhostwriteCounts(s).autoFold >= 1, JSON.stringify(s!.metadata[NO_GHOSTWRITE_METADATA_KEY]));
        assert.equal(noGhostwriteCounts(s).preflight, 0, "没越过窗口：preflight 那一路不该记数");
    } finally {
        server.close(); server.closeIdleConnections?.(); await once(server, "close");
        main.close(); main.closeIdleConnections?.(); sum.close(); sum.closeIdleConnections?.();
    }
});
