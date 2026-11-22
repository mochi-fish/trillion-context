// fish-ledger P0 (F8, side usage): one provider-usage row per settled report,
// filed under the same capture (and request id) as the egress row of the
// send it bills; the proxy's own side calls get lane "side" rows read from
// their response text. Hermetic: tmp roots, fake upstream, fictional fixtures.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetFishLedgerForTest, stopFishLedger } from "../src/fish-ledger.ts";
import { usageFromResponseText } from "../src/fish-ledger-usage.ts";
import { closeServers } from "./server-close-guard.ts";
import { anthropicSseReply, anthropicTurn, bringUpProxy, postAnthropic, type ProxyHarness, type UpstreamReply } from "./fish-ledger-harness.ts";

const HEADER = "x-bili-plugin-fish-request";
type Row = Record<string, unknown> & { ref: Record<string, unknown>; data: Record<string, unknown> };

function makeLedgerRoot(): { parent: string; root: string } {
    const parent = mkdtempSync(path.join(os.tmpdir(), "fishledger-us-"));
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

async function withLedgerProxy(tag: string, opts: { reply?: UpstreamReply; extra?: Record<string, unknown> }, fn: (h: ProxyHarness, root: string) => Promise<void>): Promise<void> {
    const { parent, root } = makeLedgerRoot();
    const saved = process.env.FISH_LEDGER_DIR;
    _resetFishLedgerForTest();
    process.env.FISH_LEDGER_DIR = root;
    let h: ProxyHarness | undefined;
    try {
        h = await bringUpProxy(tag, { reply: opts.reply, extra: opts.extra as never });
        await fn(h, root);
    } finally {
        if (h !== undefined) {
            h.store.cancelAll();
            await closeServers([h.proxy, h.upstream], `fish usage ${tag}`);
            rmSync(h.root, { recursive: true, force: true });
        }
        stopFishLedger("test");
        _resetFishLedgerForTest();
        if (saved === undefined) delete process.env.FISH_LEDGER_DIR;
        else process.env.FISH_LEDGER_DIR = saved;
        rmSync(parent, { recursive: true, force: true });
    }
}

test("usage row: totals, cache split, output; same capture and rid as the egress row it bills", async () => {
    const reply: UpstreamReply = () => anthropicSseReply({ input: 40, cacheRead: 900, cacheWrite: 60, output: 7 });
    await withLedgerProxy("main", { reply, extra: { compress: { injectTool: true, injectNudge: false } } }, async (h, root) => {
        const rid = "fq-77-abc-1";
        const r = await postAnthropic(h, "session-fictional-u", anthropicTurn("fictional question for usage", { stream: true }), { [HEADER]: rid });
        assert.equal(r.status, 200, r.text.slice(0, 300));
        const untagged = await postAnthropic(h, "session-fictional-u", anthropicTurn("fictional follow-up", { stream: true }));
        assert.equal(untagged.status, 200);
        const all = rows(root);
        const eg = all.filter((x) => x.kind === "request-manifest");
        const us = all.filter((x) => x.kind === "usage");
        assert.equal(eg.length, 2);
        assert.equal(us.length, 2, "one usage row per settled report");
        assert.equal(us[0].ref.layer, "provider");
        assert.equal(us[0].ref.captureId, eg[0].ref.captureId, "usage ↔ egress share the capture id");
        assert.equal(us[0].ref.round, eg[0].ref.round);
        assert.equal(us[0].ref.fishReq, rid);
        assert.equal(us[1].ref.fishReq, null);
        assert.equal(us[1].ref.captureId, eg[1].ref.captureId);
        const d = us[0].data;
        assert.equal(d.lane, "loop", "settled by the compress loop (tool injection on)");
        assert.equal(d.total, 1000, "anthropic total = input + cache read + cache write");
        assert.equal(d.cached, 900);
        assert.equal(d.creation, 60);
        assert.equal(d.uncached, 40);
        assert.equal(d.output, 7);
        assert.equal(d.hitPct, 0.9);
        assert.equal(d.protocol, "anthropic");
        assert.equal(d.upstreamHost, new URL(h.upstreamUrl).host);
        assert.equal(us[0].author, "provider");
        assert.equal(us[0].relayer, "proxy");
        assert.equal(us[0].status, "settled");
        assert.ok(us.every((x) => x.hash === null), "usage rows carry no content hash");
    });
});

test("side usage: the preflight summary call gets its own lane-side usage row (no rid)", async () => {
    let streaming = 0;
    const reply: UpstreamReply = (hit) => {
        let parsed: { stream?: boolean } = {};
        try { parsed = JSON.parse(hit.raw.toString("utf8")) as { stream?: boolean }; } catch { parsed = {}; }
        if (parsed.stream === false) {
            return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "msg_s", type: "message", role: "assistant", model: "model-test", content: [{ type: "text", text: "FICTIONAL SUMMARY: the earlier segment discussed placeholder topics; decisions recorded; nothing else." }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 } }) };
        }
        streaming++;
        if (streaming === 1) return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" } }) };
        const sse =
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000, cache_read_input_tokens: 0 } } })}\n\n` +
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
        return { status: 200, headers: { "content-type": "text/event-stream" }, body: sse };
    };
    await withLedgerProxy("side", { reply, extra: { modelContextLimit: 400_000, compress: { injectTool: true, injectNudge: true } } }, async (h, root) => {
        const rid = "fq-77-abc-2";
        const messages: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 12; i++) messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Fictional line ${i}. ` + `PAD_${i}_text_`.repeat(250) });
        const res = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "session-fictional-s", [HEADER]: rid },
            body: JSON.stringify({ model: "model-test", max_tokens: 1024, stream: true, messages }),
        });
        assert.equal(res.status, 200);
        await res.text();
        const us = rows(root).filter((x) => x.kind === "usage");
        const side = us.filter((x) => x.data.lane === "side");
        assert.equal(side.length, 1, JSON.stringify(us.map((x) => x.data)));
        assert.equal(side[0].data.total, 500);
        assert.equal(side[0].data.output, 50);
        assert.equal(side[0].ref.fishReq, null);
        const turn = us.filter((x) => x.data.lane !== "side");
        assert.equal(turn.length, 1, "the rescued turn settles once");
        assert.equal(turn[0].data.total, 5000);
        assert.equal(turn[0].data.output, 3);
        assert.equal(turn[0].ref.fishReq, rid);
    });
});

test("usageFromResponseText: JSON and SSE, every wire", () => {
    assert.deepEqual(usageFromResponseText("anthropic", JSON.stringify({ usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 2 } })), { total: 95, cached: 80, creation: 5, output: 2 });
    const sse = [
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 100 } } })}`,
        `data: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 0, output_tokens: 9 } })}`,
        "data: [DONE]",
    ].join("\n\n");
    assert.deepEqual(usageFromResponseText("anthropic", sse), { total: 112, cached: 100, creation: null, output: 9 });
    assert.deepEqual(usageFromResponseText("openai", JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 60 } } })), { total: 100, cached: 60, creation: null, output: 4 });
    assert.deepEqual(usageFromResponseText("responses", `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: 3, input_tokens_details: { cached_tokens: 10 } } } })}\n\n`), { total: 30, cached: 10, creation: null, output: 3 });
    assert.deepEqual(usageFromResponseText("google", JSON.stringify({ usageMetadata: { promptTokenCount: 50, cachedContentTokenCount: 20, candidatesTokenCount: 5 } })), { total: 50, cached: 20, creation: null, output: 5 });
    assert.equal(usageFromResponseText("anthropic", "no usage here"), undefined);
    assert.equal(usageFromResponseText("anthropic", "{not json"), undefined);
});

test("plugin lane (x-bili-plugin: dsh): the settled stream files a lane-main usage row under the rid", async () => {
    const reply: UpstreamReply = () => anthropicSseReply({ input: 30, cacheRead: 3000, cacheWrite: 0, output: 11 });
    await withLedgerProxy("plugin", { reply }, async (h, root) => {
        const rid = "fq-77-abc-3";
        const res = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "session-fictional-p", [HEADER]: rid },
            body: JSON.stringify(anthropicTurn("fictional plugin question", { stream: true })),
        });
        assert.equal(res.status, 200);
        await res.text();
        for (const hit of h.hits) assert.ok(!hit.headerKeys.includes(HEADER));
        const all = rows(root);
        const eg = all.filter((x) => x.kind === "request-manifest");
        const us = all.filter((x) => x.kind === "usage");
        assert.equal(eg.length, 1);
        assert.equal(eg[0].ref.fishReq, rid);
        assert.equal(us.length, 1, JSON.stringify(all.map((x) => x.kind)));
        assert.equal(us[0].data.lane, "main");
        assert.equal(us[0].ref.fishReq, rid);
        assert.equal(us[0].ref.captureId, eg[0].ref.captureId);
        assert.equal(us[0].data.total, 3030);
        assert.equal(us[0].data.output, 11);
    });
});
