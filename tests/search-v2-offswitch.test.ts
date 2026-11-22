// fork search v2 (11-20): with the new switches unset nothing changes —
// the plugin manifest is byte-identical (engine alone never touches it; only
// search.around adds the one optional param), sessions get no new metadata
// key, the proxy-lane search_context result is the old one, and engine
// "cjk" without a unified store falls back to the old path. Also pins that
// a pack's `around` param description cannot add the param by itself.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { applyAcpToolOverrides, defaultConfig, type ToolPrompts } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, withSearchAroundParam } from "../src/compress-tool.ts";
import { SEARCH_V2_META_KEY } from "../src/search-v2.ts";
import type { CompressSettings, ProxyOptions } from "../src/config.ts";

process.env.BILI_PERSIST = "0";

type GlobalCompress = CompressSettings & { injectTool?: boolean; injectNudge?: boolean };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function sse(res: http.ServerResponse, id: string, block: Record<string, unknown>, delta: Record<string, unknown>, stop: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("message_start", { message: { id, type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 500 } } }));
    res.write(sseBlock("content_block_start", { index: 0, content_block: block }));
    res.write(sseBlock("content_block_delta", { index: 0, delta }));
    res.write(sseBlock("content_block_stop", { index: 0 }));
    res.write(sseBlock("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 5 } }));
    res.write(sseBlock("message_stop", {}));
    res.end();
}

async function startProxy(compress: GlobalCompress, captured: string[]): Promise<{ proxyPort: number; upstreamPort: number; closeAll: () => Promise<void> }> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            const n = captured.length;
            if (n === 1) {
                sse(res, "msg_c", { type: "tool_use", id: "tu_compress", name: "compress", input: {} }, { type: "input_json_delta", partial_json: JSON.stringify({ content: [
                    { startId: "m00001", endId: "m00007", summary: "早先：兔说下次去老码头吃火锅，还说那家的毛肚很好，要早点去排队，不然要等一个小时以上，记得提前订位子。", topic: "火锅" },
                    { startId: "m00008", endId: "m00014", summary: "后来：聊了吉他和小星星，兔说手指按弦按得很疼，打算每天练半个小时，周末去琴行换一套软一点的琴弦试试。", topic: "吉他" },
                ] }) }, "tool_use");
            } else if (n === 2) {
                sse(res, "msg_s", { type: "tool_use", id: "tu_search_context", name: "search_context", input: {} }, { type: "input_json_delta", partial_json: JSON.stringify({ query: "火锅", limit: 2 }) }, "tool_use");
            } else {
                sse(res, "msg_d", { type: "text", text: "" }, { type: "text_delta", text: "好" }, "end_turn");
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectNudge: false, minCompressRangeChars: 1000, ...compress },
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
    await listen(proxy as unknown as http.Server);
    const proxyPort = ((proxy as unknown as http.Server).address() as { port: number }).port;
    assert.ok(proxyPort < 18780 || proxyPort > 18799);
    return { proxyPort, upstreamPort, closeAll: async () => { await close(proxy as unknown as http.Server); await close(upstream); } };
}

async function manifestText(compress: GlobalCompress): Promise<string> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const h = await startProxy({ injectTool: true, ...compress }, []);
    try {
        const res = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/manifest`);
        assert.equal(res.status, 200);
        return await res.text();
    } finally {
        await h.closeAll();
    }
}

function searchTools(doc: { tools: Record<string, unknown[]> }): Array<Record<string, any>> {
    const out: Array<Record<string, any>> = [];
    for (const list of Object.values(doc.tools)) for (const t of list as Array<Record<string, any>>) if (t?.name === "search_context" || t?.function?.name === "search_context") out.push(t);
    return out;
}

const propsOf = (t: Record<string, any>): Record<string, any> => (t.input_schema ?? t.parameters ?? t.function?.parameters).properties;

test("manifest: byte-identical whether search is unset, planAware-only, or engine-only; around adds one param, nothing else", async () => {
    const base = await manifestText({});
    assert.equal(await manifestText({ search: { planAware: true } }), base);
    assert.equal(await manifestText({ search: { engine: "cjk" } }), base, "the engine never touches the manifest");
    assert.equal(await manifestText({ search: { engine: "substring" } }), base);
    const baseDoc = JSON.parse(base) as { tools: Record<string, unknown[]> };
    assert.ok(searchTools(baseDoc).length >= 3);
    for (const t of searchTools(baseDoc)) assert.ok(!("around" in propsOf(t)));
    const withAround = JSON.parse(await manifestText({ search: { around: true } })) as { tools: Record<string, unknown[]> };
    const st = searchTools(withAround);
    assert.equal(st.length, searchTools(baseDoc).length);
    for (const t of st) {
        assert.equal(propsOf(t).around?.type, "string");
        delete propsOf(t).around;
    }
    assert.equal(JSON.stringify(withAround), JSON.stringify(baseDoc), "removing around gives back the off manifest");
});

test("pack: an `around` param description never adds the param by itself", () => {
    const pack = JSON.parse(fs.readFileSync(new URL("./fixtures/fish-pack-030/fish.json", import.meta.url), "utf8")) as { version: string; toolPrompts: ToolPrompts };
    assert.equal(pack.version, "0.3.0");
    const off = applyAcpToolOverrides(BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, pack.toolPrompts).find((t) => t.name === "search_context")!;
    assert.ok(!("around" in (off.input_schema.properties as Record<string, unknown>)));
    assert.equal(off.description, pack.toolPrompts.search_context!.description);
    const on = applyAcpToolOverrides(withSearchAroundParam(BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE), pack.toolPrompts).find((t) => t.name === "search_context")!;
    assert.equal((on.input_schema.properties as Record<string, { description?: string }>).around!.description, pack.toolPrompts.search_context!.paramDescriptions!.around);
    const text = JSON.stringify(pack.toolPrompts.search_context);
    assert.ok(!/他/.test(text.replace(/吉他|其他/g, "")), "the pack text says 兔, never 他");
    assert.ok(!/<\/?[A-Za-z]/.test(text));
});

function searchResultText(body: string): string {
    return toolResultText(body, "tu_search_context");
}

function toolResultText(body: string, id: string): string {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    for (const m of parsed.messages ?? []) {
        if (!Array.isArray(m.content)) continue;
        for (const c of m.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
            if (c.type === "tool_result" && c.tool_use_id === id) {
                if (typeof c.content === "string") return c.content;
                if (Array.isArray(c.content)) return (c.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("");
            }
        }
    }
    return "";
}

async function proxyRun(sid: string, search: GlobalCompress["search"]): Promise<{ result: string; metaKeys: string[] }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: string[] = [];
    const { proxyPort, upstreamPort, closeAll } = await startProxy({ injectTool: true, ccr: { enabled: true }, ...(search ? { search } : {}) }, captured);
    try {
        const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Historical detail ${i}. ${"y".repeat(2000)}` }));
        msgs.push({ role: "user", content: "现在接着聊。" });
        const res = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sid, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1000, stream: true, system: "SYS", messages: msgs }),
        });
        const body = await res.text();
        assert.ok(res.ok, `HTTP ${res.status}: ${body.slice(0, 200)}`);
        assert.equal(captured.length, 3);
        assert.ok(captured[1]!.includes("老码头"), `the fold reached the re-request: ${toolResultText(captured[1]!, "tu_compress").slice(0, 400)}`);
        return { result: searchResultText(captured[2]!), metaKeys: Object.keys(getSession(sid).metadata).sort() };
    } finally {
        await closeAll();
    }
}

test("proxy lane: unset / substring give the same result and the same metadata keys; cjk without a unified store falls back", async () => {
    const off = await proxyRun("sv2-off", undefined);
    assert.ok(off.result.length > 0);
    assert.ok(!off.metaKeys.includes(SEARCH_V2_META_KEY));
    const sub = await proxyRun("sv2-sub", { engine: "substring" });
    assert.equal(sub.result, off.result);
    assert.deepEqual(sub.metaKeys, off.metaKeys);
    const cjk = await proxyRun("sv2-cjk", { engine: "cjk" });
    assert.ok(cjk.metaKeys.includes(SEARCH_V2_META_KEY), "engine cjk stamps the session");
    assert.equal(cjk.result, off.result, "no unified store → the old path answers");
});
