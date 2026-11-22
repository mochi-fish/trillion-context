// Shared hermetic harness for the fish-ledger P0 tests: a fake model upstream
// that records the exact bytes and header names it receives, and an in-process
// proxy wired at it. Every root lives under os.tmpdir(); nothing here touches a
// real home directory or a real model endpoint.

import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _resetStoreForTest, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";

export interface UpstreamHit {
    url: string;
    headerKeys: string[];
    headers: http.IncomingHttpHeaders;
    raw: Buffer;
}

export type UpstreamReply = (hit: UpstreamHit, index: number) => { status?: number; headers?: Record<string, string>; body: string } | undefined;

/** Anthropic non-streaming answer with a usage block the proxy settles. */
export function anthropicJsonReply(usage: { input: number; cacheRead?: number; cacheWrite?: number; output: number }, text = "answer"): { status: number; headers: Record<string, string>; body: string } {
    return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            id: "msg_test", type: "message", role: "assistant", model: "model-test",
            content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
            usage: {
                input_tokens: usage.input,
                ...(usage.cacheRead !== undefined ? { cache_read_input_tokens: usage.cacheRead } : {}),
                ...(usage.cacheWrite !== undefined ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
                output_tokens: usage.output,
            },
        }),
    };
}

/** OpenAI chat-completions answer with a usage block. */
export function openaiJsonReply(prompt = 100, completion = 4): { status: number; headers: Record<string, string>; body: string } {
    return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            id: "chatcmpl-test", object: "chat.completion", created: 1, model: "model-test",
            choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
        }),
    };
}

function makeFakeUpstream(reply?: UpstreamReply): { server: http.Server; hits: UpstreamHit[] } {
    const hits: UpstreamHit[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const hit: UpstreamHit = {
                url: req.url ?? "",
                headerKeys: Object.keys(req.headers).map((k) => k.toLowerCase()),
                headers: req.headers,
                raw: Buffer.concat(chunks),
            };
            hits.push(hit);
            const custom = reply?.(hit, hits.length - 1);
            const out = custom ?? (hit.url.includes("/v1/messages") ? anthropicJsonReply({ input: 100, output: 4 }) : openaiJsonReply());
            res.writeHead(out.status ?? 200, out.headers ?? { "content-type": "application/json" });
            res.end(out.body);
        });
    });
    return { server, hits };
}

export interface ProxyHarness {
    root: string;
    store: SessionStore;
    upstream: http.Server;
    hits: UpstreamHit[];
    proxy: http.Server;
    origin: string;
    upstreamUrl: string;
}

/** Fresh tmp roots for every HOME/XDG lookup, a disabled session store, a fake
 *  upstream and an in-process proxy aimed at it. */
export async function bringUpProxy(tag: string, opts: { reply?: UpstreamReply; extra?: Partial<ProxyOptions> } = {}): Promise<ProxyHarness> {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), `fishledger-${tag}-`));
    for (const k of ["HOME", "USERPROFILE", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[k] = root;
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    const { server: upstream, hits } = makeFakeUpstream(opts.reply);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const uaddr = upstream.address();
    if (uaddr === null || typeof uaddr !== "object") throw new Error("upstream did not bind");
    const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "model-test": { context: 64_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        ...(opts.extra ?? {}),
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    if (paddr === null || typeof paddr !== "object") throw new Error("proxy did not bind");
    return { root, store, upstream, hits, proxy, origin: `http://127.0.0.1:${paddr.port}`, upstreamUrl };
}

/** A small anthropic /v1/messages turn through the proxy's /bili/ lane. */
export async function postAnthropic(h: ProxyHarness, sid: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    const res = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sid, "anthropic-version": "2023-06-01", ...extraHeaders },
        body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
}

export function anthropicTurn(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: "model-test",
        max_tokens: 256,
        system: "You are a test assistant.",
        tools: [{ name: "noop", description: "does nothing", input_schema: { type: "object", properties: {} } }],
        messages: [
            { role: "user", content: [{ type: "text", text: "first fictional line" }] },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
            { role: "user", content: [{ type: "text", text }] },
        ],
        ...extra,
    };
}

/** Anthropic streaming answer: message_start carries the input split,
 *  message_delta the output — the shape the proxy settles from SSE. */
export function anthropicSseReply(usage: { input: number; cacheRead?: number; cacheWrite?: number; output: number }, text = "ok"): { status: number; headers: Record<string, string>; body: string } {
    const start: Record<string, number> = { input_tokens: usage.input };
    if (usage.cacheRead !== undefined) start.cache_read_input_tokens = usage.cacheRead;
    if (usage.cacheWrite !== undefined) start.cache_creation_input_tokens = usage.cacheWrite;
    const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body:
            ev("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "model-test", content: [], usage: start } }) +
            ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
            ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
            ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
            ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output } }) +
            ev("message_stop", { type: "message_stop" }),
    };
}
