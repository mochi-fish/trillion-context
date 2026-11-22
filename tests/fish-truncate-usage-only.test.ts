// fork（养成向）：compress.requireUsageSampleForTruncate —— 紧急截断只认落了账的真用量。
//
// 背景（水位线上线复核 B2 / B5，11-16）：她的会话设了 256k 上限以后，一份请求被掐断、
// 用量没落账，下一份就按本地估计判大小（#4383 的 cycle-stale 那条路，source "estimate"），
// 估计值常是真用量的 1.5–1.9 倍：一次掐断就够把估计值推过 95%，内核当场剪掉几条最长的
// 旧消息、锁住，直到她下一次压成功。催压对估计值有「先等一轮」，截断没有。
//
// 这份测试守住：
//   1. 配置：三级都能写、按会话也能写；设置页往返收得下布尔、写坏了整块拒；没写时内核的
//      truncate 块里没有这个键（和上游逐字节一样）。
//   2. 判大小 + 内核（不起代理）：真用量落账 → 掐断没落账 → 下一份按估计值判：开关开着
//      不剪新的、不锁；开关不开照旧剪（R2-abort2 的样子）；真用量回来、过了 95% 照样剪。
//   3. 真起一份代理：掐断没落账、下一份按估计值判——不开开关时上游收到被截过的那条，
//      开着时上游收到原文、会话 metadata 记数（日志那一行的写法在第 1 组核）；真用量过线那一轮照剪。
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-fish-truncate-usage-"));
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");
delete process.env.BILI_CONFIG_FILE;

const { defaultConfig, createCore, createInitialState } = await import("acp-kernel");
const { startServer, effectiveTokenCount } = await import("../src/server.ts");
const { parseCompressSettings } = await import("../src/config.ts");
const { resolveSessionCompressOverride, applySessionCompressOverride, applyCompressSettings, mergeCompress } = await import("../src/compress-settings.ts");
const { noteOutboundContextEstimates, settleUsageReport } = await import("../src/cache-ledger.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { peekSession, usageAnchorCycleStale } = await import("../src/session.ts");
const { setLogCapture } = await import("../src/logger.ts");
const { TRUNCATE_HOLD_METADATA_KEY, noteTruncateHeld, truncateHeldThisTurn, truncateHeldLine } = await import("../src/truncate-hold.ts");
type ProxyOptions = import("../src/config.ts").ProxyOptions;
type CoreMessage = import("acp-kernel").CoreMessage;
type Session = import("../src/session.ts").Session;

const HER = "session-e795aff7-0000-4000-8000-0000000000aa";
const HELPER = "session-e795aff7-0000-4000-8000-0000000000bb";
const MARK = "[truncated for context space]";
const HER_OFF = "session-e795aff7-0000-4000-8000-0000000000c0";
const HER_ON = "session-e795aff7-0000-4000-8000-0000000000c1";
type Trunc = { threshold: number; terminalEscapeAfter?: number; requireUsageSample?: boolean };
const truncOf = (c: unknown) => (c as { truncate: Trunc }).truncate;

// ---------- 1. 配置 ----------

test("三级：没写时内核的 truncate 块里没有这个键；写了 true / false 照写", () => {
    const base = defaultConfig(256_000);
    const none = applyCompressSettings(base, 256_000, mergeCompress({}, undefined, undefined));
    assert.equal("requireUsageSample" in truncOf(none), false, "没写 = 上游的 truncate 块");
    assert.deepEqual(truncOf(none), truncOf(base));
    assert.equal(truncOf(applyCompressSettings(base, 256_000, mergeCompress({ requireUsageSampleForTruncate: true }, undefined, undefined))).requireUsageSample, true);
    assert.equal(truncOf(applyCompressSettings(base, 256_000, mergeCompress({ requireUsageSampleForTruncate: true }, { requireUsageSampleForTruncate: false }, undefined))).requireUsageSample, false, "深的一级赢");
    // 和 emergencyThresholdPercent 一起写：两样各管各的
    const both = truncOf(applyCompressSettings(base, 256_000, mergeCompress({ requireUsageSampleForTruncate: true, emergencyThresholdPercent: "90%" }, undefined, undefined)));
    assert.equal(both.threshold, 0.9);
    assert.equal(both.requireUsageSample, true);
});

test("按会话：resolve 认这个键、写坏只打 warn；apply 只在值不同时换一个新对象", () => {
    const g = { sessions: { [HER]: { modelContextLimit: 256_000, noGhostwrite: true, requireUsageSampleForTruncate: true } } };
    assert.deepEqual(resolveSessionCompressOverride(g, [HER])?.override, { modelContextLimit: 256_000, noGhostwrite: true, requireUsageSampleForTruncate: true });
    assert.equal(resolveSessionCompressOverride(g, [HELPER]), undefined, "帮手不跟着");
    const lines: string[] = [];
    setLogCapture((_l: string, m: string) => lines.push(m));
    try {
        assert.equal(resolveSessionCompressOverride({ sessions: { x: { requireUsageSampleForTruncate: "yes" } } } as never, ["x"]), undefined);
    } finally { setLogCapture(null); }
    assert.ok(lines.some((l) => l.includes("requireUsageSampleForTruncate must be a boolean")));
    const base = defaultConfig(256_000);
    assert.equal(applySessionCompressOverride(base, { requireUsageSampleForTruncate: undefined }, 1_048_576), base, "没写 → 同一个对象");
    const onCfg = applySessionCompressOverride(base, { requireUsageSampleForTruncate: true }, 1_048_576);
    assert.notEqual(onCfg, base);
    assert.equal(truncOf(onCfg).requireUsageSample, true);
    assert.equal(truncOf(onCfg).threshold, base.truncate.threshold, "线不动");
    assert.equal(truncOf(base).requireUsageSample, undefined, "不改原对象");
    assert.equal(applySessionCompressOverride(onCfg, { requireUsageSampleForTruncate: true }, 1_048_576), onCfg, "值相同 → 同一个对象");
    assert.equal(truncOf(applySessionCompressOverride(onCfg, { requireUsageSampleForTruncate: false }, 1_048_576)).requireUsageSample, false, "按会话明写 false 也认");
});

test("设置页往返：布尔收下、写坏整块拒；按会话的块收这个键", () => {
    assert.equal(parseCompressSettings({ requireUsageSampleForTruncate: true })?.requireUsageSampleForTruncate, true);
    assert.equal(parseCompressSettings({ requireUsageSampleForTruncate: "true" }), undefined);
    assert.deepEqual(parseCompressSettings({ sessions: { [HER]: { requireUsageSampleForTruncate: true } } })?.sessions, { [HER]: { requireUsageSampleForTruncate: true } });
    assert.equal(parseCompressSettings({ sessions: { [HER]: { requireUsageSampleForTruncate: 1 } } }), undefined);
});

test("truncateHeldThisTurn / noteTruncateHeld：只在开着、估计值、到了线时算一次", () => {
    const off = defaultConfig(100_000);
    const on = { ...off, truncate: { ...off.truncate, requireUsageSample: true } };
    assert.equal(truncateHeldThisTurn(off, 130_000, "estimate"), false, "开关不开");
    assert.equal(truncateHeldThisTurn(on, 130_000, "usage"), false, "真用量");
    assert.equal(truncateHeldThisTurn(on, 130_000, undefined), false, "没给来源");
    assert.equal(truncateHeldThisTurn(on, 90_000, "estimate"), false, "没到线");
    assert.equal(truncateHeldThisTurn(on, 95_000, "estimate"), true);
    const s: { metadata?: Record<string, unknown> } = {};
    assert.equal(noteTruncateHeld(s, 130_000, 100_000), 1);
    assert.equal(noteTruncateHeld(s, 120_000, 100_000), 2);
    assert.equal((s.metadata![TRUNCATE_HOLD_METADATA_KEY] as { held: number; lastTokens: number }).lastTokens, 120_000);
    assert.match(truncateHeldLine("sid", 130_000, 100_000, 2), /\[truncate-hold\].*130000\/100000 \(130%\).*held 2x/);
});

// ---------- 2. 判大小 + 内核：掐断没落账、下一份按估计值判 ----------

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return { id: `ftu-${seq}`, metadata: {}, stats: {}, state: createInitialState() } as unknown as Session;
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
// 判大小用的原样历史要比估计值大：effectiveTokenCount 取 min(上一次发出时的估计, 原样上界)
const rawLarge = (): CoreMessage[] => [{ id: "r", role: "user", contentType: "text", text: "z".repeat(4_000_000) }];

function sizeAndTurn(cfgOn: boolean, session: Session) {
    const base = defaultConfig(256_000);
    const cfg = applySessionCompressOverride(base, cfgOn ? { requireUsageSampleForTruncate: true } : undefined, 1_048_576);
    const sizing = effectiveTokenCount(session, rawLarge());
    const core = createCore();
    const turn = core.processTurn({ messages: history(), state: session.state, config: cfg, tokenCount: sizing.tokens, tokenCountSource: sizing.source, renderTags: "none" });
    session.state = turn.state;
    return { sizing, turn, cfg };
}

test("掐断没落账 → 下一份按估计值（305,312 = 119%）判：开关不开照旧剪、锁住（R2-abort2 的样子）", () => {
    const s = makeSession();
    settleUsageReport(s, { total: 186_477, reportedCached: 184_000 });                                // 上一份：真用量落账（73%）
    noteOutboundContextEstimates(s, { upperBound: 305_312, scaledText: 200_000, imageTokens: 0, calibrated: false }); // 这一份发出去了、被掐断，用量没落账
    const { sizing, turn } = sizeAndTurn(false, s);
    assert.deepEqual(sizing, { tokens: 305_312, source: "estimate" }, "下一份按估计值判");
    assert.ok(turn.messages.find((m) => m.id === "u-big")!.text!.includes(MARK), "不开开关：按估计值截断");
    assert.ok((turn.state.emergencyTruncateLatch?.length ?? 0) > 0, "锁住");
});

test("同样的掐断，开关开着：不剪新的、不锁；真用量回来、过了 95% 照样剪", () => {
    const s = makeSession();
    settleUsageReport(s, { total: 186_477, reportedCached: 184_000 });
    noteOutboundContextEstimates(s, { upperBound: 305_312, scaledText: 200_000, imageTokens: 0, calibrated: false });
    const r1 = sizeAndTurn(true, s);
    assert.equal(r1.sizing.source, "estimate");
    assert.equal(r1.turn.messages.find((m) => m.id === "u-big")!.text, BIG, "估计值不剪");
    assert.equal(r1.turn.state.emergencyTruncateLatch, undefined, "没有锁");
    assert.equal(truncateHeldThisTurn(r1.cfg, r1.sizing.tokens, r1.sizing.source), true, "宿主认得出这一次是「因为估计值没剪」");
    // 下一份：真用量落账、在线下（75%）：不剪、也不算 hold
    settleUsageReport(s, { total: 192_000, reportedCached: 190_000 });
    const r2 = sizeAndTurn(true, s);
    assert.deepEqual(r2.sizing, { tokens: 192_000, source: "usage" });
    assert.equal(r2.turn.messages.find((m) => m.id === "u-big")!.text, BIG);
    assert.equal(truncateHeldThisTurn(r2.cfg, r2.sizing.tokens, r2.sizing.source), false);
    // 再下一份：真用量 250,000（98%）：照样剪
    settleUsageReport(s, { total: 250_000, reportedCached: 240_000 });
    const r3 = sizeAndTurn(true, s);
    assert.deepEqual(r3.sizing, { tokens: 250_000, source: "usage" });
    assert.ok(r3.turn.messages.find((m) => m.id === "u-big")!.text!.includes(MARK), "真用量过线照剪");
});

// ---------- 3. 真起一份代理 ----------

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
type Mode = { kind: "ok"; input: number } | { kind: "abort" };

async function startHarness(sid: string, sessionEntry: Record<string, unknown>) {
    let mode: Mode = { kind: "ok", input: 20_000 };
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            const m = mode;
            res.writeHead(200, { "content-type": "text/event-stream" });
            if (m.kind === "abort") {
                // 发了开头、没有用量，就断：代理这一轮没有用量落账
                res.write(sse("message_start", { type: "message_start", message: { id: "msg_cut", role: "assistant" } }));
                res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
                res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半句" } }));
                setTimeout(() => res.destroy(), 20);
                return;
            }
            res.write(sse("message_start", { type: "message_start", message: { id: "msg_ok", role: "assistant", usage: { input_tokens: m.input } } }));
            res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
            res.write(sse("message_stop", { type: "message_stop" }));
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-flash": { context: 1_048_576 } } } },
        modelContextLimit: 1_048_576,
        kernelConfig: defaultConfig(1_048_576),
        compress: { injectTool: true, injectNudge: true, sessions: { [sid]: sessionEntry } },
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
    return {
        proxyPort,
        upstreamPort,
        bodies,
        setMode: (m: Mode) => { mode = m; },
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

// 她的历史：最前面一条很长的话（会被截的那一条），之后一问一答；每一轮把整份历史重发（DSH 那样）
const LONG = "这是她很久以前和兔说的一段很长的话，留着当截断的靶子。 ".repeat(2_400); // 约 7 万字：上界远过 40k 的 95%
function wire(turn: number): Array<{ role: string; content: string }> {
    const out: Array<{ role: string; content: string }> = [{ role: "user", content: LONG }, { role: "assistant", content: "嗯，我记着" }];
    for (let k = 1; k <= turn; k += 1) {
        out.push({ role: "user", content: `第 ${k} 问` });
        if (k < turn) out.push({ role: "assistant", content: `第 ${k} 答` });
    }
    return out;
}
async function sendTurn(h: { proxyPort: number; upstreamPort: number }, sid: string, turn: number): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid },
        body: JSON.stringify({ model: "deepseek-flash", max_tokens: 64_000, stream: true, messages: wire(turn) }),
    });
    try { for await (const _chunk of resp.body!) { /* drain */ } } catch { /* 掐断的那一轮客户端这边会报错 */ }
}
const longClipped = (body: string): boolean => {
    const j = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
    const first = JSON.stringify(j.messages[0]?.content ?? "");
    return first.includes(MARK);
};

// 判的是哪一种读数：第 3 份之前锚点是不是「过期」（上一份发出去了、用量没落账：#4383 的
// cycle-stale），过期就按估计值判。日志在测试里不开（log: false），所以用这个和会话里的计数核。
// 每个场景用自己的会话 id：同一个进程里会话留在内存里，混用会把上一个场景的锁带过来。
async function runAbortScenario(sid: string, entry: Record<string, unknown>) {
    const h = await startHarness(sid, entry);
    try {
        h.setMode({ kind: "ok", input: 20_000 }); await sendTurn(h, sid, 1);   // 真用量 20,000（50%）落账
        h.setMode({ kind: "abort" }); await sendTurn(h, sid, 2);              // 掐断：没有用量
        const staleBefore3 = usageAnchorCycleStale(peekSession(sid)!.stats);
        const nBefore3 = h.bodies.length;
        h.setMode({ kind: "ok", input: 39_000 }); await sendTurn(h, sid, 3);   // 这一份按估计值判；它自己回来的真用量是 39,000（97.5%）
        const body3 = h.bodies[nBefore3]!;
        const latch3 = peekSession(sid)?.state.emergencyTruncateLatch?.length ?? 0;
        const held3 = (peekSession(sid)?.metadata[TRUNCATE_HOLD_METADATA_KEY] as { held?: number } | undefined)?.held ?? 0;
        const staleBefore4 = usageAnchorCycleStale(peekSession(sid)!.stats);
        const lastBefore4 = peekSession(sid)!.stats.lastInputTokens;
        const nBefore4 = h.bodies.length;
        h.setMode({ kind: "ok", input: 30_000 }); await sendTurn(h, sid, 4);   // 这一份按 39,000 的真用量判
        const body4 = h.bodies[nBefore4]!;
        const held4 = (peekSession(sid)?.metadata[TRUNCATE_HOLD_METADATA_KEY] as { held?: number } | undefined)?.held ?? 0;
        return { staleBefore3, clipped3: longClipped(body3), latch3, held3, staleBefore4, lastBefore4, clipped4: longClipped(body4), held4, upstreamCalls: h.bodies.length };
    } finally {
        await h.close();
    }
}

test("真起代理：掐断没落账、下一份按估计值判——不开开关照旧截断（对照）", async () => {
    const r = await runAbortScenario(HER_OFF, { modelContextLimit: 40_000, noGhostwrite: true });
    assert.equal(r.staleBefore3, true, `掐断以后锚点过期：第 3 份按估计值判（${JSON.stringify(r)}）`);
    assert.equal(r.clipped3, true, `上游收到的第一条被截过（${JSON.stringify(r)}）`);
    assert.ok(r.latch3 > 0, "锁住");
    assert.equal(r.held3, 0, "开关不开：不记数");
    assert.equal(r.upstreamCalls, 4, "掐断那一份没有重发");
});

test("真起代理：同样的掐断，开关开着——这一份上游收到原文、会话里记一次数；下一份真用量过线照样截", async () => {
    const r = await runAbortScenario(HER_ON, { modelContextLimit: 40_000, noGhostwrite: true, requireUsageSampleForTruncate: true });
    assert.equal(r.staleBefore3, true, `掐断以后锚点过期：第 3 份按估计值判（${JSON.stringify(r)}）`);
    assert.equal(r.clipped3, false, `估计值不截（${JSON.stringify(r)}）`);
    assert.equal(r.latch3, 0, "没有锁");
    assert.equal(r.held3, 1, "记了一次（开着、估计值、到了线）");
    assert.equal(r.staleBefore4, false, "第 3 份的真用量落账了：第 4 份按真用量判");
    assert.equal(r.lastBefore4, 39_000);
    assert.equal(r.clipped4, true, `真用量 97.5% 照样截（${JSON.stringify(r)}）`);
    assert.equal(r.held4, 1, "真用量那一份不算 hold");
    assert.equal(r.upstreamCalls, 4);
});
