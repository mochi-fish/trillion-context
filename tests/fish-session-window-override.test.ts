// fork（养成向）：compress.sessions —— 按会话设上限。
//
// 背景：modelContextLimit 原来只能写在全局 / 提供方 / 模型三级。她的主会话和
// 她的帮手会话走同一个上游、同一个模型，三级都分不开：给她设 256k，帮手也
// 跟着变成 256k。这里加的是第四级、优先级最高、只认会话身份的覆盖；没写这个
// 键的时候，所有会话和原来逐项相同。
//
// 这份测试守住：
//   1. 解析：按会话 id 认、也认插件会话头；只认自有键（__proto__ 不算）；
//      写坏的值不生效、只打 warn；"N%" 按模型真实窗口算。
//   2. 设置页往返：parseCompressSettings 收得下合法的 sessions，写坏了整块拒。
//   3. 真起一份代理：同一个模型的两条会话，只有点了名的那条变成 256000，
//      另一条（相当于帮手）还是模型窗口；没配 sessions 时两条都和原来一样。
//   4. 配置文件改了、会话快照过期时（effectiveConfig 的回退路），覆盖照样在。
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-fish-session-window-"));
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");
delete process.env.BILI_CONFIG_FILE;

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { parseCompressSettings } = await import("../src/config.ts");
const { resolveSessionCompressOverride, applySessionCompressOverride, resolveRequestConfig } = await import("../src/compress-settings.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { createSession, effectiveConfig, peekSession, storeEffectiveConfig } = await import("../src/session.ts");
const { setLogCapture } = await import("../src/logger.ts");
type ProxyOptions = import("../src/config.ts").ProxyOptions;

const HER = "session-e795aff7-0000-4000-8000-000000000001";
const HELPER = "session-e795aff7-0000-4000-8000-000000000002";

test("resolveSessionCompressOverride: 按会话 id 认，同一个字段第一个对上的键赢", () => {
    const g = { sessions: { [HER]: { modelContextLimit: 256_000 }, other: { modelContextLimit: 100_000 } } };
    assert.deepEqual(resolveSessionCompressOverride(g, [HER, "other"]), { key: HER, keys: [HER], override: { modelContextLimit: 256_000 } });
    assert.deepEqual(resolveSessionCompressOverride(g, ["nope", "other"]), { key: "other", keys: ["other"], override: { modelContextLimit: 100_000 } }, "第二个身份（插件会话头）也认");
    assert.deepEqual(resolveSessionCompressOverride(g, [HER, HER]), { key: HER, keys: [HER], override: { modelContextLimit: 256_000 } }, "会话 id 和插件头相同只算一次");
    assert.equal(resolveSessionCompressOverride(g, [HELPER, undefined]), undefined, "没点名的会话（帮手）不受影响");
    assert.equal(resolveSessionCompressOverride(undefined, [HER]), undefined, "没写 compress 块");
    assert.equal(resolveSessionCompressOverride({}, [HER]), undefined, "没写 sessions 键");
    assert.equal(resolveSessionCompressOverride({ sessions: [] as unknown as Record<string, never> }, [HER]), undefined, "sessions 不是对象就当没写");
});

test("resolveSessionCompressOverride（审查 S3）：派生出来的链（<sid>|aud:… / |sub:…）单写自己的上限，也照样继承她条目里的不代写等开关——按字段合并，不是整条赢", () => {
    const AUD = `${HER}|aud:qq-group-1`;
    const g = { sessions: { [HER]: { modelContextLimit: 256_000, noGhostwrite: true, foldHostFileImages: true, epochMajorityGuard: true }, [AUD]: { modelContextLimit: 60_000 } } };
    const r = resolveSessionCompressOverride(g, [AUD, HER]);
    assert.deepEqual(r, { key: AUD, keys: [AUD, HER], override: { modelContextLimit: 60_000, noGhostwrite: true, foldHostFileImages: true, epochMajorityGuard: true } });
    // 受众链自己写了 false：它自己的值赢（明写的关掉照样认）
    const g2 = { sessions: { [HER]: { noGhostwrite: true }, [AUD]: { noGhostwrite: false } } };
    assert.deepEqual(resolveSessionCompressOverride(g2, [AUD, HER])?.override, { noGhostwrite: false });
    // 没写条目的受众链：整个继承她的
    assert.deepEqual(resolveSessionCompressOverride(g, [`${HER}|aud:qq-group-2`, HER])?.override, g.sessions[HER]);
    // 只认插件头、而头换成了受众链自己的键时（P2 那样传头）就继承不到——这时受众链必须有自己的条目
    assert.equal(resolveSessionCompressOverride(g, [`${HER}|aud:qq-group-2`, `${HER}|aud:qq-group-2`]), undefined);
    // 一条写坏、一条好：好的那条照样合进来
    const g3 = { sessions: { [AUD]: { noGhostwrite: "yes" as unknown as boolean }, [HER]: { noGhostwrite: true } } };
    assert.deepEqual(resolveSessionCompressOverride(g3, [AUD, HER]), { key: HER, keys: [HER], override: { noGhostwrite: true } });
});

test("resolveSessionCompressOverride: 只认自有键，原型上的名字不算", () => {
    const g = { sessions: { [HER]: { modelContextLimit: 256_000 } } };
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        assert.equal(resolveSessionCompressOverride(g, [id]), undefined, id);
    }
});

test("resolveSessionCompressOverride: 写坏的值不生效，只打 warn；N% 和数字字符串照收", () => {
    const lines: string[] = [];
    setLogCapture((_level: string, msg: string) => lines.push(msg));
    try {
        assert.equal(resolveSessionCompressOverride({ sessions: { a: { modelContextLimit: -5 } } }, ["a"]), undefined);
        assert.equal(resolveSessionCompressOverride({ sessions: { b: { modelContextLimit: "lots" } } }, ["b"]), undefined);
        assert.equal(resolveSessionCompressOverride({ sessions: { c: "256000" as unknown as never } }, ["c"]), undefined);
        assert.deepEqual(resolveSessionCompressOverride({ sessions: { d: { modelContextLimit: 256_000, noSuchKey: 1 } as never } }, ["d"]), { key: "d", keys: ["d"], override: { modelContextLimit: 256_000 } }, "未知键只报不拒，合法的那项照用");
        assert.deepEqual(resolveSessionCompressOverride({ sessions: { e: { modelContextLimit: " 25% " } } }, ["e"]), { key: "e", keys: ["e"], override: { modelContextLimit: "25%" } });
        assert.deepEqual(resolveSessionCompressOverride({ sessions: { f: { modelContextLimit: "256000" } } }, ["f"]), { key: "f", keys: ["f"], override: { modelContextLimit: 256_000 } });
    } finally {
        setLogCapture(null);
    }
    const warns = lines.filter((l) => l.includes("compress.sessions["));
    assert.ok(warns.length >= 4, `每个写坏的条目都有一行 warn（实得 ${warns.length}）`);
});

test("applySessionCompressOverride: 绝对数直接用，N% 按模型真实窗口算，没写就原样返回同一个对象", () => {
    const base = resolveRequestConfig(defaultConfig(200_000), {}, undefined, "m", 1_048_576, undefined);
    assert.equal(applySessionCompressOverride(base, { modelContextLimit: 256_000 }, 1_048_576).modelContextLimit, 256_000);
    assert.equal(applySessionCompressOverride(base, { modelContextLimit: "25%" }, 1_048_576).modelContextLimit, 262_144);
    assert.equal(applySessionCompressOverride(base, undefined, 1_048_576), base, "没覆盖 → 同一个对象");
    assert.equal(applySessionCompressOverride(base, {}, 1_048_576), base, "覆盖里没写上限 → 同一个对象");
});

test("parseCompressSettings: 设置页往返收得下 sessions，写坏了整块拒（和别的字段一样）", () => {
    const ok = parseCompressSettings({ sessions: { [HER]: { modelContextLimit: 256_000 }, x: { modelContextLimit: "30%" } } });
    assert.deepEqual(ok?.sessions, { [HER]: { modelContextLimit: 256_000 }, x: { modelContextLimit: "30%" } });
    assert.equal(parseCompressSettings({ sessions: { [HER]: { modelContextLimit: 0 } } }), undefined);
    assert.equal(parseCompressSettings({ sessions: { [HER]: { nudgeGrowthTokens: 1 } } }), undefined, "按会话的块只收列出的键");
    assert.equal(parseCompressSettings({ sessions: "x" }), undefined);
    assert.equal(parseCompressSettings({ sessions: { " ": { modelContextLimit: 1000 } } }), undefined, "空白键");
    assert.equal(parseCompressSettings({ nudgeGrowthTokens: 1 })?.sessions, undefined, "没写 sessions 时解析结果里也没有");
});

// ---------- 真起一份代理 ----------

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startHarness(globalCompress: Record<string, unknown>) {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: "msg_w", role: "assistant", usage: { input_tokens: 55 } } }));
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-flash": { context: 1_048_576 } } } },
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

async function sendTurn(h: { proxyPort: number; upstreamPort: number }, conversationId: string): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "dsh",
            "x-bili-plugin-conversation": conversationId,
        },
        body: JSON.stringify({ model: "deepseek-flash", max_tokens: 1024, stream: true, messages: [{ role: "user", content: `hello from ${conversationId}` }] }),
    });
    assert.equal(resp.status, 200);
    for await (const _chunk of resp.body!) { /* drain */ }
}

function windowOf(conversationId: string): { effective: unknown; config: unknown } {
    const s = peekSession(conversationId);
    assert.ok(s, `会话 ${conversationId} 已建`);
    return {
        effective: s!.metadata.effectiveContextLimit,
        config: (s!.metadata.effectiveConfig as { modelContextLimit?: unknown } | undefined)?.modelContextLimit,
    };
}

test("真起代理：同一个模型，只有点了名的会话变成 256000，另一条（帮手）还是模型窗口", async () => {
    const h = await startHarness({ sessions: { [HER]: { modelContextLimit: 256_000 } } });
    try {
        await sendTurn(h, HER);
        await sendTurn(h, HELPER);
        const her = windowOf(HER);
        const helper = windowOf(HELPER);
        assert.equal(her.effective, 256_000, "她的会话：按会话的上限");
        // 存下来的 effectiveConfig（插件工具、面板读它）是扣过输出预留的判定窗口：256000 − max_tokens 1024
        assert.equal(her.config, 256_000 - 1024, "effectiveConfig 跟着按会话的上限走");
        assert.equal(helper.effective, 1_048_576, "帮手：模型窗口，没跟着变");
    } finally {
        await h.close();
    }
});

test("真起代理：按会话的覆盖比模型一级的 modelContextLimit 还优先；没配 sessions 时和原来一样", async () => {
    const h = await startHarness({ modelContextLimit: 500_000, sessions: { [HER]: { modelContextLimit: "25%" } } });
    try {
        await sendTurn(h, HER);
        await sendTurn(h, HELPER);
        assert.equal(windowOf(HER).effective, 262_144, "25% × 1048576");
        assert.equal(windowOf(HELPER).effective, 500_000, "帮手照全局那一级");
    } finally {
        await h.close();
    }
    const plain = await startHarness({});
    try {
        await sendTurn(plain, HER);
        assert.equal(windowOf(HER).effective, 1_048_576, "没配 sessions：她的会话也是模型窗口（行为不变）");
    } finally {
        await plain.close();
    }
});

test("配置文件改过、会话快照过期：effectiveConfig 的回退路照样带上按会话的上限", () => {
    const dir = path.join(xdgRoot, "config", "billion-context");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "billion-context.json"), JSON.stringify({ compress: { nudgeGrowthTokens: 60_000, sessions: { [HER]: { modelContextLimit: 256_000 } } } }));
    const base = defaultConfig(1_048_576);
    const her = createSession(HER, { protocol: "anthropic" });
    const helper = createSession(HELPER, { protocol: "anthropic" });
    storeEffectiveConfig(her, base);
    storeEffectiveConfig(helper, base);
    // 快照之后配置又改了一次 → 快照过期，effectiveConfig 走「现读文件」那条路
    writeFileSync(path.join(dir, "billion-context.json"), JSON.stringify({ compress: { nudgeGrowthTokens: 70_000, sessions: { [HER]: { modelContextLimit: 256_000 } } } }));
    assert.equal(effectiveConfig(her, base).modelContextLimit, 256_000);
    assert.equal(effectiveConfig(helper, base).modelContextLimit, 1_048_576);
});
