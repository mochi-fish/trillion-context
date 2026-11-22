// fish-ledger P0 (F2–F5b): the client half of the request-id channel.
//
//  - The proxy declares the capability in its manifest (capabilities.fishLedger)
//    and the TOOLS part of the manifest stays byte-identical to ea59cdb — the
//    tools are registered verbatim as the host's tools (fixtures captured from
//    ea59cdb with this same harness, three config variants).
//  - dsh-native reads the rid the host-side writer attached to the llm/stream
//    request object (process-wide WeakMap) and stamps the header only while the
//    proxy at the CURRENT base declared the capability in this register
//    generation: any re-assignment of the base (new origin, recovery onto the
//    same origin), toolsReady→false, or an undeclared manifest turns it off.
//  - A recovery retry that re-sends headers computed for the dead origin drops
//    the header unless the gate still holds for the new origin.

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

delete process.env.BILI_PROVIDER_REWRITES;
delete process.env.BILI_NATIVE_DSH;
delete process.env.BILLION_CONTEXT_PLUGIN;

import { apply, verifyAttachAndRecover, _resetRegisterForTest, _settleNativeForTest, _stateHeadersForTest, type PluginContext } from "../src/agent/dsh-native.ts";
import { __resetConversationRecallForTests } from "../src/agent/conversation-recall.ts";
import { installNativeFetchIntercept, _resetForTest as resetIntercept, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import { fishClientStats } from "../src/fish-request.ts";
import { VERSION } from "../src/version.ts";
import { closeServers } from "./server-close-guard.ts";
import { bringUpProxy } from "./fish-ledger-harness.ts";

const HEADER = "x-bili-plugin-fish-request";
const MODEL_URL = "https://api.anthropic.com/v1/messages";
const FIXTURES = join(import.meta.dirname, "fixtures", "fish-ledger");

// ------------------------------------------------------------------ manifest

/** The raw `"tools":{…}` slice of a manifest response, byte for byte. */
function rawTools(text: string): string {
    const i = text.indexOf('"tools":');
    const j = text.indexOf(',"headers":', i);
    assert.ok(i > 0 && j > i, "manifest shape");
    return text.slice(i, j);
}

const VARIANTS: Record<string, Record<string, unknown>> = {
    "default": {},
    "inject": { compress: { injectTool: true, injectNudge: true } },
    "lean-pack": { compress: { injectTool: true, injectNudge: true, promptPack: "lean" } },
};

for (const [name, extra] of Object.entries(VARIANTS)) {
    test(`manifest (${name}): tools byte-identical to ea59cdb; only capabilities.fishLedger is new`, async () => {
        const base = readFileSync(join(FIXTURES, `manifest-ea59cdb-${name}.json`), "utf8");
        const h = await bringUpProxy(`manifest-${name}`, { extra: extra as never });
        try {
            const text = await (await fetch(`${h.origin}/__bili/plugin/manifest`)).text();
            assert.equal(rawTools(text), rawTools(base), "manifest tools must not change by a single byte");
            const now = JSON.parse(text) as Record<string, unknown> & { capabilities: Record<string, unknown> };
            const then = JSON.parse(base) as Record<string, unknown> & { capabilities: Record<string, unknown> };
            assert.deepEqual(now.capabilities.fishLedger, { features: ["fish-request-header"], header: HEADER });
            delete now.capabilities.fishLedger;
            assert.deepEqual({ ...now, commit: null, version: null }, { ...then, commit: null, version: null }, "nothing else in the manifest moved");
        } finally {
            h.store.cancelAll();
            await closeServers([h.proxy, h.upstream], "fish manifest");
            rmSync(h.root, { recursive: true, force: true });
        }
    });
}

// ------------------------------------------------------------------ dsh-native gate

interface MockProxy { origin: string; server: Server; declare: { on: boolean }; manifestFetches: number }

async function startMockProxy(declareOn: boolean): Promise<MockProxy> {
    const declare = { on: declareOn };
    const mock: MockProxy = { origin: "", server: undefined as unknown as Server, declare, manifestFetches: 0 };
    mock.server = createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            mock.manifestFetches++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                version: VERSION,
                tools: { anthropic: [{ name: "compress", description: "Compress a range of messages", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } }] },
                capabilities: { fork: { protocolVersion: 2 }, ...(declare.on ? { fishLedger: { features: ["fish-request-header"], header: HEADER } } : {}) },
            }));
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    const a = mock.server.address();
    mock.origin = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
    return mock;
}

type Events = Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>;

function makeCtx(): { ctx: PluginContext; events: Events; registered: string[] } {
    const events: Events = new Map();
    const registered: string[] = [];
    const ctx = {
        inject: (deps: readonly string[], cb: (sub: unknown) => void) => { if (deps.includes("llm")) cb({}); },
        on: (name: string, listener: (payload: unknown, next: () => unknown) => unknown) => {
            const list = events.get(name) ?? [];
            list.push(listener);
            events.set(name, list);
        },
        emit: () => undefined,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        tools: { register: (tool: { name: string }) => void registered.push(tool.name) },
        commands: { register: () => undefined },
        agents: { currentInitiator: () => undefined },
    } as unknown as PluginContext;
    return { ctx, events, registered };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const ridMap = (): WeakMap<object, string> => {
    const g = globalThis as Record<PropertyKey, unknown>;
    const k = Symbol.for("fish-ledger/request-ids");
    if (!(g[k] instanceof WeakMap)) g[k] = new WeakMap();
    return g[k] as WeakMap<object, string>;
};

/** One llm/stream dispatch through the registered waterfall; returns what
 *  headersFor stamped for the adapter's fetch inside it. */
async function stampOnce(events: Events, options: Record<string, unknown>): Promise<Record<string, string>> {
    const headersFor = _stateHeadersForTest();
    assert.ok(headersFor);
    let stamped: Record<string, string> = {};
    const base = async function* (): AsyncIterable<number> {
        stamped = { ...(headersFor(MODEL_URL) ?? {}) };
        yield 1;
    };
    const listeners = events.get("llm/stream") ?? [];
    const composed = listeners.reduceRight<(payload: unknown, next: () => unknown) => unknown>(
        (acc, listener) => (payload, next) => listener(payload, () => acc(payload, next)),
        () => base(),
    );
    const it = (composed(options, () => base()) as AsyncIterable<number>)[Symbol.asyncIterator]();
    while (!(await it.next()).done) { /* drain */ }
    return stamped;
}

/** Stamp tagged dispatches until the gate opens (the first one may only
 *  trigger the lazy capability probe) — bounded; returns the stamped headers. */
async function stampUntilTagged(events: Events, rid: string): Promise<Record<string, string>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
        const h = await stampOnce(events, tagged(rid));
        if (h[HEADER] !== undefined || Date.now() > deadline) return h;
        await new Promise((r) => setTimeout(r, 20));
    }
}

function tagged(rid: string, sessionId: string | null = "session-fictional-c"): Record<string, unknown> {
    const options: Record<string, unknown> = { model: "model-test", messages: [] };
    if (sessionId !== null) options.sessionId = sessionId;
    ridMap().set(options, rid);
    return options;
}

async function withNative(declareOn: boolean, fn: (h: { mock: MockProxy; events: Events }) => Promise<void>): Promise<void> {
    __resetConversationRecallForTests();
    const home = mkdtempSync(join(tmpdir(), "fishledger-cap-"));
    const saved: Record<string, string | undefined> = {};
    for (const key of ["BILLION_CONTEXT_PROXY", "DSH_HOME"]) saved[key] = process.env[key];
    const mock = await startMockProxy(declareOn);
    process.env.BILLION_CONTEXT_PROXY = mock.origin;
    process.env.DSH_HOME = home;
    _resetRegisterForTest(mock.origin);
    const { ctx, events, registered } = makeCtx();
    try {
        await apply(ctx);
        await waitFor(() => registered.length === 1, "tool registration");
        await fn({ mock, events });
    } finally {
        await _settleNativeForTest();
        mock.server.close();
        mock.server.closeAllConnections?.();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    }
}

test("declared capability: the rid from the WeakMap rides the loopback header", async () => {
    await withNative(true, async ({ events }) => {
        const h = await stampUntilTagged(events, "fq-c-a-1");
        assert.equal(h[HEADER], "fq-c-a-1");
        assert.equal(h["x-bili-plugin-conversation"], "session-fictional-c");
        const before = { ...fishClientStats() };
        assert.equal((await stampOnce(events, tagged("fq-c-a-9")))[HEADER], "fq-c-a-9", "once learned, every tagged dispatch carries it");
        const after = fishClientStats();
        assert.equal(after.seen - before.seen, 1);
        assert.equal(after.tagged - before.tagged, 1);
        // an untagged dispatch, a malformed rid, and a dispatch with no sessionId stamp nothing
        assert.equal((await stampOnce(events, { sessionId: "session-fictional-c", messages: [] }))[HEADER], undefined);
        assert.equal((await stampOnce(events, tagged("not a rid")))[HEADER], undefined);
        assert.equal(fishClientStats().bad - before.bad, 1);
        assert.equal((await stampOnce(events, tagged("fq-c-a-2", null)))[HEADER], undefined, "no sessionId → the listener passes through untouched");
    });
});

test("undeclared capability (an older proxy build): no header, counted", async () => {
    await withNative(false, async ({ events }) => {
        const before = { ...fishClientStats() };
        const h = await stampOnce(events, tagged("fq-c-b-1"));
        assert.equal(h[HEADER], undefined);
        assert.equal(h["x-bili-plugin"], "dsh", "plugin stamping itself is unchanged");
        assert.equal(fishClientStats().noCapability - before.noCapability, 1);
    });
});

test("base change / same-origin recovery: the gate re-learns per register generation", async () => {
    await withNative(true, async ({ mock, events }) => {
        assert.equal((await stampUntilTagged(events, "fq-c-c-1"))[HEADER], "fq-c-c-1");
        // An older build now answers on the SAME origin; the recovery path
        // re-assigns register.base (verifyAttachAndRecover) — the old
        // declaration must not survive the re-assignment.
        mock.declare.on = false;
        const fetchesBefore = mock.manifestFetches;
        assert.equal(await verifyAttachAndRecover(mock.origin), mock.origin);
        assert.equal((await stampOnce(events, tagged("fq-c-c-2")))[HEADER], undefined, "a re-assigned base is unproven until its manifest says so");
        await waitFor(() => mock.manifestFetches > fetchesBefore, "capability probe");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal((await stampOnce(events, tagged("fq-c-c-3")))[HEADER], undefined, "the probe saw no declaration → still no header");
        // Back to a declaring build after another recovery → re-learned.
        mock.declare.on = true;
        const fetches2 = mock.manifestFetches;
        await verifyAttachAndRecover(mock.origin);
        assert.equal((await stampOnce(events, tagged("fq-c-c-4")))[HEADER], undefined);
        await waitFor(() => mock.manifestFetches > fetches2, "second probe");
        assert.equal((await stampUntilTagged(events, "fq-c-c-5"))[HEADER], "fq-c-c-5");
        // A different origin that never declared: nothing.
        const other = await startMockProxy(false);
        try {
            _resetRegisterForTest(other.origin, true);
            assert.equal((await stampOnce(events, tagged("fq-c-c-6")))[HEADER], undefined);
            await waitFor(() => other.manifestFetches > 0, "probe of the new base");
            await new Promise((r) => setTimeout(r, 50));
            assert.equal((await stampOnce(events, tagged("fq-c-c-7")))[HEADER], undefined, "new base did not declare");
        } finally {
            other.server.close();
            other.server.closeAllConnections?.();
        }
    });
});

test("toolsReady cleared: no header until a registration in the new generation", async () => {
    await withNative(true, async ({ mock, events }) => {
        assert.equal((await stampUntilTagged(events, "fq-c-d-1"))[HEADER], "fq-c-d-1");
        _resetRegisterForTest(mock.origin, false);
        assert.equal((await stampOnce(events, tagged("fq-c-d-2")))[HEADER], undefined, "tools not ready → headersFor stamps nothing at all");
    });
});

// ------------------------------------------------------------------ recovery retry

test("recovery retry: headers computed for the dead origin lose the rid unless the gate holds for the new one", async () => {
    const saved = globalThis.fetch;
    const dead = "http://127.0.0.1:40011";
    const fresh = "http://127.0.0.1:40012";
    for (const validForFresh of [false, true]) {
        const seen: Array<{ url: string; headers: Record<string, string> }> = [];
        resetIntercept();
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const headers: Record<string, string> = {};
            for (const [k, v] of new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))) headers[k] = v;
            seen.push({ url, headers });
            if (url.startsWith(`${dead}/bili/`)) throw new TypeError("fetch failed (fictional dead proxy)");
            return new Response("{}", { status: 200 });
        }) as typeof fetch;
        const state: NativeInterceptState = {
            origin: dead,
            ready: Promise.resolve(dead),
            headersFor: () => ({ "x-bili-plugin": "dsh", [HEADER]: "fq-c-e-1" }),
            respawn: async () => fresh,
            // the dead origin was register.base when the first send went out (the gate held there)
            fishHeaderValidFor: (o) => o === dead || (validForFresh && o === fresh),
        } as NativeInterceptState;
        const before = fishClientStats().stripped;
        try {
            assert.equal(installNativeFetchIntercept(state), true);
            const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", body: "{}" });
            assert.equal(res.status, 200);
        } finally {
            globalThis.fetch = saved;
            resetIntercept();
        }
        const first = seen.find((s) => s.url.startsWith(`${dead}/bili/`));
        const retry = seen.find((s) => s.url.startsWith(`${fresh}/bili/`));
        assert.ok(first && retry, JSON.stringify(seen.map((s) => s.url)));
        assert.equal(first.headers[HEADER], "fq-c-e-1", "the first send carried the rid");
        assert.equal(retry.headers["x-bili-plugin"], "dsh", "the rest of the reused headers ride as before");
        if (validForFresh) {
            assert.equal(retry.headers[HEADER], "fq-c-e-1");
            assert.equal(fishClientStats().stripped, before);
        } else {
            assert.equal(retry.headers[HEADER], undefined, "the rid must not ride to an unproven origin");
            assert.equal(fishClientStats().stripped, before + 1);
        }
    }
});

test("first send: the rid rides only to an origin the gate holds for (baked /bili/ URL, rewrite branch)", async () => {
    const saved = globalThis.fetch;
    const baked = "http://127.0.0.1:40021"; // origin baked into an already-routed URL (an older proxy, never declared)
    const base = "http://127.0.0.1:40022"; // register.base (declared)
    const run = async (url: string, origin: string): Promise<{ sends: Array<{ url: string; rid: string | null; plugin: string | null }>; asked: string[]; stripped: number }> => {
        const sends: Array<{ url: string; rid: string | null; plugin: string | null }> = [];
        const asked: string[] = [];
        resetIntercept();
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            sends.push({ url: u, rid: h.get(HEADER), plugin: h.get("x-bili-plugin") });
            return new Response("{}", { status: 200 });
        }) as typeof fetch;
        const state: NativeInterceptState = {
            origin,
            ready: Promise.resolve(origin),
            headersFor: () => ({ "x-bili-plugin": "dsh", [HEADER]: "fq-r-x-1" }),
            fishHeaderValidFor: (o) => { asked.push(o); return o === base; },
        } as NativeInterceptState;
        const before = fishClientStats().stripped;
        try {
            assert.equal(installNativeFetchIntercept(state), true);
            const res = await globalThis.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
            assert.equal(res.status, 200);
        } finally {
            globalThis.fetch = saved;
            resetIntercept();
        }
        return { sends, asked, stripped: fishClientStats().stripped - before };
    };
    // routed branch, baked origin != register.base: no rid on the first send, the gate was asked about THAT origin
    const a = await run(`${baked}/bili/${MODEL_URL}`, base);
    assert.equal(a.sends.length, 1, JSON.stringify(a.sends));
    assert.ok(a.sends[0].url.startsWith(`${baked}/bili/`));
    assert.equal(a.sends[0].rid, null, "the rid must not ride to an origin that never declared the capability");
    assert.equal(a.sends[0].plugin, "dsh", "the other plugin headers ride as before");
    assert.deepEqual(a.asked, [baked]);
    assert.equal(a.stripped, 1);
    // routed branch, baked origin == register.base: the rid rides
    const b = await run(`${base}/bili/${MODEL_URL}`, base);
    assert.equal(b.sends[0].rid, "fq-r-x-1");
    assert.equal(b.stripped, 0);
    // rewrite branch (a bare model URL): the rid rides only when the gate holds for the proxy origin it is rewritten to
    const c = await run("http://127.0.0.1:8199/v1/messages", base);
    assert.ok(c.sends[0].url.startsWith(`${base}/bili/`));
    assert.equal(c.sends[0].rid, "fq-r-x-1");
    const d = await run("http://127.0.0.1:8199/v1/messages", baked);
    assert.ok(d.sends[0].url.startsWith(`${baked}/bili/`));
    assert.equal(d.sends[0].rid, null);
    assert.equal(d.stripped, 1);
});
