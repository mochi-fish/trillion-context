// fish-ledger P0 (F6/F7/F7b/F7c): egress rows.
//
// The invariant: every body the (fake) model upstream received has exactly one
// egress row whose hash is HMAC-SHA256(ledger key, those exact bytes) and whose
// size is their byte length — first sends, the proxy's own same-request
// re-sends (role-compat hop, image-count shed, overflow refold, degenerate
// continuation) and its own side calls (preflight summary) alike. The host's
// request id rides the rows of its forward and never reaches the upstream.
//
// Hermetic: tmp roots, fake upstream on 127.0.0.1, fictional fixtures.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetFishLedgerForTest, fishLedgerHealth, stopFishLedger } from "../src/fish-ledger.ts";
import { setCaptureFishReq, withCacheCapture } from "../src/cache-ledger.ts";
import { makeContinuationRefetch } from "../src/degenerate-retry.ts";
import type { Session } from "../src/session.ts";
import { closeServers } from "./server-close-guard.ts";
import { anthropicJsonReply, anthropicTurn, bringUpProxy, openaiJsonReply, postAnthropic, type ProxyHarness, type UpstreamReply } from "./fish-ledger-harness.ts";

const HEADER = "x-bili-plugin-fish-request";
const SALT_HEX = "a1".repeat(32);
const KEY = Buffer.from(SALT_HEX, "hex");
const hmac = (b: Buffer): string => "hmac:" + createHmac("sha256", KEY).update(b).digest("hex");

type Row = Record<string, unknown> & { ref: Record<string, unknown>; data: Record<string, unknown> };

function makeLedgerRoot(): { parent: string; root: string } {
    const parent = mkdtempSync(path.join(os.tmpdir(), "fishledger-eg-"));
    const root = path.join(parent, "ledger");
    mkdirSync(path.join(root, "proxy"), { recursive: true });
    writeFileSync(path.join(root, "meta.json"), JSON.stringify({ schema: 1, epoch: 1, createdAt: "2026-11-20T03:00:00.000Z", tzOffsetMin: 540, by: "test", owner: { qqPrivate: "hfedcba9876543210" } }));
    writeFileSync(path.join(root, "salt"), SALT_HEX + "\n");
    writeFileSync(path.join(root, "proxy", "enabled"), "{}");
    return { parent, root };
}

function proxyRows(root: string): Row[] {
    const dir = path.join(root, "proxy");
    const out: Row[] = [];
    for (const f of readdirSync(dir).filter((n) => /^ledger-.*\.jsonl$/.test(n)).sort()) {
        for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) if (line !== "") out.push(JSON.parse(line) as Row);
    }
    return out;
}
const egressRows = (root: string): Row[] => proxyRows(root).filter((r) => r.kind === "request-manifest" && r.ref.layer === "egress");

/** Run `fn` against an in-process proxy whose ledger writes to a fresh root. */
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
            await closeServers([h.proxy, h.upstream], `fish egress ${tag}`);
            rmSync(h.root, { recursive: true, force: true });
        }
        stopFishLedger("test");
        _resetFishLedgerForTest();
        if (saved === undefined) delete process.env.FISH_LEDGER_DIR;
        else process.env.FISH_LEDGER_DIR = saved;
        rmSync(parent, { recursive: true, force: true });
    }
}

/** Every upstream body ↔ exactly one egress row with its HMAC and length. */
function assertEgressCoversUpstream(h: ProxyHarness, rows: Row[]): void {
    const want = h.hits.map((x) => `${hmac(x.raw)}|${x.raw.byteLength}`).sort();
    const got = rows.map((r) => `${String(r.hash)}|${(r.size as { bytes: number }).bytes}`).sort();
    assert.deepEqual(got, want, "egress rows must match the bytes the upstream received, one for one");
}

test("main lane: hash = HMAC(key, bytes the fake upstream received); the rid is filed, never forwarded", async () => {
    await withLedgerProxy("main", {}, async (h, root) => {
        const rid = "fq-1a2b-xyz-42";
        const a = await postAnthropic(h, "session-fictional-a", anthropicTurn("fictional question alpha"), { [HEADER]: rid });
        assert.equal(a.status, 200, a.text.slice(0, 300));
        const b = await postAnthropic(h, "session-fictional-a", anthropicTurn("fictional question beta"));
        assert.equal(b.status, 200);
        const c = await postAnthropic(h, "session-fictional-a", anthropicTurn("fictional question gamma"), { [HEADER]: "fq-bad value" });
        assert.equal(c.status, 200);
        for (const hit of h.hits) assert.ok(!hit.headerKeys.includes(HEADER), "the rid leaked to the upstream");
        const rows = egressRows(root);
        assert.equal(rows.length, 3);
        assertEgressCoversUpstream(h, rows);
        for (let i = 0; i < 3; i++) {
            assert.equal(rows[i].hash, hmac(h.hits[i].raw), `row ${i} hash`);
            assert.deepEqual(rows[i].size, { bytes: h.hits[i].raw.byteLength });
            assert.equal(rows[i].data.lane, "main");
            assert.equal(rows[i].data.reason, null);
            assert.equal(rows[i].data.send, 1);
            assert.equal(rows[i].data.model, "model-test");
            assert.equal(rows[i].data.upstreamHost, new URL(h.upstreamUrl).host);
            assert.equal(rows[i].ref.sid, "session-fictional-a");
            assert.equal(typeof rows[i].ref.captureId, "string");
            assert.equal(rows[i].status, "noted");
        }
        assert.equal(rows[0].ref.fishReq, rid);
        assert.equal(rows[1].ref.fishReq, null, "untagged request → no rid");
        assert.equal(rows[2].ref.fishReq, null, "malformed rid → recorded as absent");
        assert.equal(rows[1].data.prevHash, rows[0].hash, "prevHash links the session's previous egress");
        const health = fishLedgerHealth();
        assert.equal(health.fishReqSeen, 1);
        assert.equal(health.fishReqBad, 1);
        assert.equal(health.egress, 3);
        // nothing of the request content or the absolute root in the ledger
        const text = readdirSync(path.join(root, "proxy")).filter((n) => n.startsWith("ledger-")).map((n) => readFileSync(path.join(root, "proxy", n), "utf8")).join("");
        for (const leak of ["fictional question", root]) assert.ok(!text.includes(leak), `ledger leaked ${leak}`);
    });
});

test("resend lane: the role-compat hop's second body is filed under the same rid (send 2)", async () => {
    const reply: UpstreamReply = (hit, i) => {
        if (i === 0) return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { message: "Invalid role: assistant", type: "invalid_request_error" } }) };
        return openaiJsonReply(120, 5);
    };
    await withLedgerProxy("role", { reply, extra: { compat: { roles: {} } } }, async (h, root) => {
        const rid = "fq-1a2b-xyz-43";
        const res = await fetch(`${h.origin}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "session-fictional-r", [HEADER]: rid },
            body: JSON.stringify({ model: "model-test", max_tokens: 1024, messages: [{ role: "user", content: "fictional first ask" }, { role: "assistant", content: "fictional reply" }, { role: "user", content: "fictional ask" }] }),
        });
        assert.equal(res.status, 200, (await res.text()).slice(0, 300));
        assert.equal(h.hits.length, 2, "one first send + one role-compat hop");
        const rows = egressRows(root);
        assertEgressCoversUpstream(h, rows);
        assert.deepEqual(rows.map((r) => [r.data.lane, r.data.reason, r.data.send, r.ref.fishReq]), [["main", null, 1, rid], ["resend", "role-compat", 2, rid]]);
        assert.equal(rows[1].hash, hmac(h.hits[1].raw), "the resend row hashes the SECOND body the upstream received");
        assert.notEqual(rows[0].hash, rows[1].hash);
        assert.equal(rows[0].ref.captureId, rows[1].ref.captureId, "same forward, same capture");
    });
});

test("resend lane: an image-count overflow re-send is filed with reason image-shed", async () => {
    const reply: UpstreamReply = (hit, i) => {
        if (i === 0) return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { message: "too many images in request: 5 > 2", type: "BadRequestError" } }) };
        return openaiJsonReply(10, 1);
    };
    await withLedgerProxy("img", { reply, extra: { compress: { injectTool: true, injectNudge: true } } }, async (h, root) => {
        const rid = "fq-1a2b-xyz-44";
        const messages = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: [{ type: "text", text: `fictional picture ${i}` }, { type: "image_url", image_url: { url: `data:image/png;base64,AAAA${String(i).padStart(8, "0")}` } }] }));
        const res = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "session-fictional-i", [HEADER]: rid },
            body: JSON.stringify({ model: "model-test", max_tokens: 1024, stream: false, messages }),
        });
        const r = { status: res.status, text: await res.text() };
        assert.equal(r.status, 200, r.text.slice(0, 300));
        assert.equal(h.hits.length, 2, "one first send + one shed re-send");
        const rows = egressRows(root);
        assertEgressCoversUpstream(h, rows);
        assert.deepEqual(rows.map((x) => [x.data.lane, x.data.reason, x.data.send, x.ref.fishReq]), [["main", null, 1, rid], ["resend", "image-shed", 2, rid]]);
    });
});

const SUMMARY_TEXT = "FICTIONAL SUMMARY: the earlier segment discussed placeholder topics; decisions recorded; nothing else.";

test("resend + side lanes: an overflow refold (preflight summary side call, then the refolded re-send)", async () => {
    let streaming = 0;
    const reply: UpstreamReply = (hit) => {
        let parsed: { stream?: boolean } = {};
        try { parsed = JSON.parse(hit.raw.toString("utf8")) as { stream?: boolean }; } catch { parsed = {}; }
        if (parsed.stream === false) {
            return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "msg_s", type: "message", role: "assistant", model: "model-test", content: [{ type: "text", text: SUMMARY_TEXT }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 } }) };
        }
        streaming++;
        if (streaming === 1) return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" } }) };
        const sse =
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
        return { status: 200, headers: { "content-type": "text/event-stream" }, body: sse };
    };
    const window = 400_000;
    await withLedgerProxy("refold", { reply, extra: { modelContextLimit: window, compress: { injectTool: true, injectNudge: true } } }, async (h, root) => {
        const rid = "fq-1a2b-xyz-45";
        const messages: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 12; i++) messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Fictional line ${i}. ` + `FILLER_${i}_text_`.repeat(250) });
        const res = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "session-fictional-f", [HEADER]: rid },
            body: JSON.stringify({ model: "model-test", max_tokens: 1024, stream: true, messages }),
        });
        assert.equal(res.status, 200);
        await res.text();
        assert.ok(h.hits.length >= 3, `expected first send + summary + re-send, upstream saw ${h.hits.length}`);
        const rows = egressRows(root);
        assertEgressCoversUpstream(h, rows);
        const lanes = rows.map((r) => `${String(r.data.lane)}:${String(r.data.reason)}`);
        assert.ok(lanes.includes("main:null"), lanes.join(","));
        assert.ok(lanes.includes("side:preflight-summary"), lanes.join(","));
        assert.ok(lanes.includes("resend:refold"), lanes.join(","));
        for (const r of rows) {
            if (r.data.lane === "side") assert.equal(r.ref.fishReq, null, "side calls never carry the rid");
            else assert.equal(r.ref.fishReq, rid);
        }
        const refold = rows.find((r) => r.data.reason === "refold") as Row;
        const main = rows.find((r) => r.data.lane === "main") as Row;
        assert.equal(refold.ref.captureId, main.ref.captureId);
        assert.ok((refold.data.send as number) > (main.data.send as number), "send counts up within the forward");
    });
});

test("resend lane: the degenerate continuation re-send is filed under the capture's rid", async () => {
    const { parent, root } = makeLedgerRoot();
    const saved = process.env.FISH_LEDGER_DIR;
    _resetFishLedgerForTest();
    process.env.FISH_LEDGER_DIR = root;
    const hits: Buffer[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            hits.push(Buffer.concat(chunks));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "fine" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        });
    });
    try {
        const { startFishLedger } = await import("../src/fish-ledger.ts");
        startFishLedger({ version: "0.1.213", commit: "test" });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/chat/completions`;
        const session = { id: "session-fictional-d", metadata: {}, stats: {} } as unknown as Session;
        const rid = "fq-1a2b-xyz-46";
        await withCacheCapture(session, async () => {
            setCaptureFishReq(rid);
            const refetch = makeContinuationRefetch({
                protocol: "openai",
                body: JSON.stringify({ model: "model-test", stream: true, messages: [{ role: "user", content: "fictional ask" }] }),
                upstreamUrl: url,
                reqHeaders: { "content-type": "application/json" },
                signal: new AbortController().signal,
                log: () => {},
                label: "session-fictional-d",
            } as never);
            const stream = await refetch();
            assert.ok(stream, "the continuation re-send went out");
            await new Response(stream).text();
        });
        const rows = egressRows(root);
        assert.equal(rows.length, 1);
        assert.equal(hits.length, 1);
        assert.equal(rows[0].hash, hmac(hits[0]));
        assert.deepEqual([rows[0].data.lane, rows[0].data.reason, rows[0].data.send, rows[0].ref.fishReq], ["resend", "degenerate-retry", 1, rid]);
    } finally {
        upstream.close();
        upstream.closeAllConnections?.();
        stopFishLedger("test");
        _resetFishLedgerForTest();
        if (saved === undefined) delete process.env.FISH_LEDGER_DIR;
        else process.env.FISH_LEDGER_DIR = saved;
        rmSync(parent, { recursive: true, force: true });
    }
});

test("no ledger configured: a tagged turn goes through and not one ledger byte is written", async () => {
    const saved = { dir: process.env.FISH_LEDGER_DIR, lane: process.env.BILI_LAUNCHER_LANE };
    delete process.env.FISH_LEDGER_DIR;
    process.env.BILI_LAUNCHER_LANE = "dsh"; // even on the DSH lane: the default root does not exist in the tmp home
    _resetFishLedgerForTest();
    let h: ProxyHarness | undefined;
    try {
        h = await bringUpProxy("noledger");
        const r = await postAnthropic(h, "session-fictional-n", anthropicTurn("fictional question none"), { [HEADER]: "fq-1a2b-xyz-47" });
        assert.equal(r.status, 200);
        assert.equal(fishLedgerHealth().state, "no-root");
        const found: string[] = [];
        const walk = (d: string): void => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (/fish-ledger|^ledger-\d|^writer\.lock$|^heartbeat\.json$/.test(e.name)) found.push(path.relative(h!.root, p));
                if (e.isDirectory()) walk(p);
            }
        };
        walk(h.root);
        assert.deepEqual(found, [], "ledger artifacts appeared without a configured root");
        assert.ok(!existsSync(path.join(h.root, ".dsh-fish-ledger")));
    } finally {
        if (h !== undefined) {
            h.store.cancelAll();
            await closeServers([h.proxy, h.upstream], "fish noledger");
            rmSync(h.root, { recursive: true, force: true });
        }
        _resetFishLedgerForTest();
        if (saved.dir === undefined) delete process.env.FISH_LEDGER_DIR; else process.env.FISH_LEDGER_DIR = saved.dir;
        if (saved.lane === undefined) delete process.env.BILI_LAUNCHER_LANE; else process.env.BILI_LAUNCHER_LANE = saved.lane;
    }
});

test("a failing ledger disk never touches the forward (ENOSPC injected): same bytes upstream, error counted", async () => {
    const realWrite = nodeFs.writeSync;
    const g = globalThis as Record<PropertyKey, unknown>;
    let armed = false;
    const fakeFs = new Proxy(nodeFs, {
        get(target, prop, recv) {
            if (prop === "writeSync") {
                return (fd: number, buf: NodeJS.ArrayBufferView, ...rest: unknown[]) => {
                    if (armed) throw Object.assign(new Error("no space (fictional)"), { code: "ENOSPC" });
                    return (realWrite as (...a: unknown[]) => number)(fd, buf, ...rest);
                };
            }
            return Reflect.get(target, prop, recv);
        },
    });
    process.env.FISH_LEDGER_TEST = "1";
    g[Symbol.for("fish-ledger/test")] = { fs: fakeFs };
    try {
        await withLedgerProxy("enospc", {}, async (h) => {
            // the writer opens after the listener announced itself — arm only once it is on
            for (let i = 0; i < 100 && fishLedgerHealth().state !== "on"; i++) await new Promise((r) => setTimeout(r, 20));
            assert.equal(fishLedgerHealth().state, "on");
            armed = true;
            const r = await postAnthropic(h, "session-fictional-e", anthropicTurn("fictional question disk"), { [HEADER]: "fq-1a2b-xyz-48" });
            assert.equal(r.status, 200);
            assert.equal(h.hits.length, 1);
            assert.ok(!h.hits[0].headerKeys.includes(HEADER));
            const health = fishLedgerHealth();
            assert.ok((health.errors.ENOSPC ?? 0) >= 1, JSON.stringify(health));
            assert.ok(health.buffered >= 1, `the row waits in the buffer for the back-off to pass: ${JSON.stringify(health)}`);
            armed = false;
        });
    } finally {
        delete g[Symbol.for("fish-ledger/test")];
        delete process.env.FISH_LEDGER_TEST;
    }
});
