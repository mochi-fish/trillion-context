// fish-ledger P0 (F9/F10): the proxy's ledger writer.
//
//  - root rules (ledger review M3): no homedir default unless the launcher
//    marked the DSH lane; a copied profile (DSH_HOME elsewhere / DSH_FISH_HOME)
//    never resolves to the live root;
//  - nothing is written — not a byte — without a usable root + proxy/enabled;
//  - writer behaviour (off file, closes, torn tails) and the health block;
//  - contract with ledger-core.mjs when FISH_LEDGER_CORE points at it
//    (INTERFACES §3.11): pure functions agree output-for-output, and the same
//    operation script yields byte-identical files from both writers, which the
//    core's readRows/tailSeq read back cleanly.
//
// Every root is a fresh tmp dir; fixtures are fictional.

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    _resetFishLedgerForTest, _tickFishLedgerForTest, baseSid, egressHash, fishLedgerHealth, hmacHex, isoOf, localMonth, maskPath,
    noteEgress, noteUsage, openWriter, providerOf, proxyLedgerRoot, pseudoId, sessionRef, startFishLedger, stopFishLedger,
} from "../src/fish-ledger.ts";

const SALT_HEX = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join("");
const KEY = Buffer.from(SALT_HEX, "hex");

function tmp(tag: string): string {
    return mkdtempSync(path.join(os.tmpdir(), `fishledger-w-${tag}-`));
}

function makeRoot(parent: string, opts: { enabled?: boolean; meta?: unknown; salt?: string } = {}): string {
    const root = path.join(parent, "ledger");
    mkdirSync(root);
    writeFileSync(path.join(root, "meta.json"), JSON.stringify(opts.meta ?? { schema: 1, epoch: 1, createdAt: "2026-11-20T03:00:00.000Z", tzOffsetMin: 540, by: "test", owner: { qqPrivate: "h0123456789abcdef" } }));
    writeFileSync(path.join(root, "salt"), opts.salt ?? SALT_HEX + "\n");
    if (opts.enabled !== false) {
        mkdirSync(path.join(root, "proxy"));
        writeFileSync(path.join(root, "proxy", "enabled"), JSON.stringify({ schema: 1, by: "test" }));
    }
    return root;
}

/** Every file below `dir` with its size — a "nothing changed" fingerprint. */
function tree(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { out.push(`${path.relative(dir, p)}/`); walk(p); }
            else out.push(`${path.relative(dir, p)} ${statSync(p).size}`);
        }
    };
    if (existsSync(dir)) walk(dir);
    return out.sort();
}

function rows(file: string): Array<Record<string, unknown>> {
    return readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ------------------------------------------------------------------ root rules

test("proxyLedgerRoot: no homedir default without the DSH lane (M3)", () => {
    const home = tmp("root-rules");
    try {
        const abs = path.join(home, "elsewhere");
        assert.deepEqual(proxyLedgerRoot({ env: { FISH_LEDGER_DIR: abs }, home }), { root: path.resolve(abs), why: "env" });
        assert.deepEqual(proxyLedgerRoot({ env: { FISH_LEDGER_DIR: "relative/dir", BILI_LAUNCHER_LANE: "dsh" }, home }), { root: null, why: "env-relative" });
        assert.deepEqual(proxyLedgerRoot({ env: {}, home }), { root: null, why: "lane" });
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "pi" }, home }), { root: null, why: "lane" });
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "dsh", DSH_HOME: path.join(home, "copy", ".dsh") }, home }), { root: null, why: "dsh-home" });
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "dsh", DSH_FISH_HOME: path.join(home, "fish") }, home }), { root: null, why: "fish-home" });
        // DSH_HOME that names the default location (also via ~) still counts as the default.
        mkdirSync(path.join(home, ".dsh"));
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "dsh", DSH_HOME: "~/.dsh" }, home }), { root: path.join(home, ".dsh-fish-ledger"), why: "live" });
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "dsh" }, home }), { root: path.join(home, ".dsh-fish-ledger"), why: "live" });
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------ nothing written

test("no root configured: startFishLedger opens nothing and a tagged egress writes zero bytes", () => {
    const home = tmp("noroot");
    try {
        const before = tree(home);
        for (const env of [{}, { BILI_LAUNCHER_LANE: "pi" }, { FISH_LEDGER_DIR: "rel" }, { BILI_LAUNCHER_LANE: "dsh" /* root dir absent */ }, { BILI_LAUNCHER_LANE: "dsh", DSH_HOME: path.join(home, "x") }]) {
            _resetFishLedgerForTest();
            startFishLedger({ version: "0.1.213", commit: "test", env, home });
            noteEgress({ lane: "main", fishReq: "fq-a-b-1", sid: "session-fictional", body: "fictional body" });
            noteUsage({ lane: "main", total: 10, cached: 5, creation: 0, output: 1 });
            _tickFishLedgerForTest();
            const h = fishLedgerHealth();
            assert.equal(h.state, "no-root", JSON.stringify(env));
            assert.equal(h.egress, 0);
            assert.equal(h.usage, 0);
            assert.equal(h.root, null);
            stopFishLedger("test");
        }
        assert.deepEqual(tree(home), before, "a byte was written under the home without a configured root");
        assert.ok(!existsSync(path.join(home, ".dsh-fish-ledger")), "the default root must never be created");
    } finally {
        _resetFishLedgerForTest();
        rmSync(home, { recursive: true, force: true });
    }
});

test("root without proxy/enabled (or bad meta/salt): no lock, no heartbeat, no rows", () => {
    const parent = tmp("noenabled");
    try {
        const variants: Array<[string, Parameters<typeof makeRoot>[1], string, string]> = [
            ["not-enabled", { enabled: false }, "off", "not-enabled"],
            ["no-meta", { meta: { schema: 2 } }, "off", "no-meta"],
            ["no-salt", { salt: "short" }, "off", "no-salt"],
        ];
        for (const [name, o, state, reason] of variants) {
            const p = path.join(parent, name);
            mkdirSync(p);
            const root = makeRoot(p, o);
            const before = tree(root);
            _resetFishLedgerForTest();
            startFishLedger({ version: "0.1.213", commit: "test", env: { FISH_LEDGER_DIR: root }, home: parent });
            noteEgress({ lane: "main", body: "fictional body" });
            _tickFishLedgerForTest();
            const h = fishLedgerHealth();
            assert.equal(h.state, state, name);
            assert.equal(h.reason, reason, name);
            stopFishLedger("test");
            assert.deepEqual(tree(root), before, `${name}: the root changed`);
        }
    } finally {
        _resetFishLedgerForTest();
        rmSync(parent, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------ writer behaviour

test("enabled root: writer-start, egress/usage rows, heartbeat, off file, close", () => {
    const parent = tmp("on");
    try {
        const root = makeRoot(parent);
        _resetFishLedgerForTest();
        startFishLedger({ version: "0.1.213", commit: "abc1234", env: { FISH_LEDGER_DIR: root }, home: parent });
        const body = Buffer.from('{"model":"model-test","messages":[{"role":"user","content":"虚构的问题"}]}', "utf8");
        noteEgress({ lane: "main", fishReq: "fq-a-b-1", sid: "onebot-group-123456789", captureId: "cap-1", round: 1, send: 1, model: "model-test", msgs: 1, samePayload: false, upstreamHost: "api.anthropic.com", body });
        noteEgress({ lane: "resend", reason: "refold", fishReq: "fq-a-b-1", sid: "onebot-group-123456789", captureId: "cap-1", round: 1, send: 2, body: "second" });
        noteEgress({ lane: "side", reason: "nudge-decide", fishReq: "fq-a-b-1", body: "side" });
        noteEgress({ lane: "main", fishReq: "not a rid", body: "x" });
        noteUsage({ lane: "main", sid: "session-x", captureId: "cap-1", round: 1, fishReq: "fq-a-b-1", model: "model-test", protocol: "anthropic", upstreamHost: "api.anthropic.com", total: 1000, cached: 900, creation: 50, output: 7, fold: 3, seam: 1 });
        noteUsage({ lane: "side", total: 0, cached: null, creation: null, output: 0 }); // not recorded
        const h = fishLedgerHealth();
        assert.equal(h.state, "on");
        assert.equal(h.root, "<FISH_LEDGER_DIR>");
        assert.deepEqual([h.egress, h.resend, h.side, h.usage], [2, 1, 1, 1]);
        assert.deepEqual(h.capabilities, ["fish-request-header"]);
        const files = readdirSync(path.join(root, "proxy")).filter((f) => f.startsWith("ledger-"));
        assert.equal(files.length, 1);
        const r = rows(path.join(root, "proxy", files[0]));
        assert.equal(r[0].kind, "op");
        assert.equal((r[0].ref as Record<string, unknown>).action, "writer-start");
        const eg = r.filter((x) => x.kind === "request-manifest");
        assert.equal(eg.length, 4);
        assert.equal(eg[0].id, "g1-2");
        assert.equal(eg[0].hash, "hmac:" + hmacHex(KEY, body));
        assert.deepEqual(eg[0].size, { bytes: body.byteLength });
        const ref0 = eg[0].ref as Record<string, unknown>;
        assert.equal(ref0.layer, "egress");
        assert.equal(ref0.fishReq, "fq-a-b-1");
        assert.equal(ref0.sid, `onebot-group-${pseudoId(KEY, "qq:group", "123456789")}`, "onebot session ids are pseudonymized");
        assert.equal((eg[1].data as Record<string, unknown>).prevHash, eg[0].hash, "prevHash = same sid's previous egress");
        assert.equal((eg[1].data as Record<string, unknown>).lane, "resend");
        assert.equal((eg[2].ref as Record<string, unknown>).fishReq, null, "side calls never carry a request id");
        assert.equal((eg[3].ref as Record<string, unknown>).fishReq, null, "a malformed request id is recorded as absent");
        const us = r.filter((x) => x.kind === "usage");
        assert.equal(us.length, 1);
        assert.deepEqual(us[0].data, { lane: "main", model: "model-test", protocol: "anthropic", upstreamHost: "api.anthropic.com", provider: "anthropic", total: 1000, cached: 900, creation: 50, uncached: 50, output: 7, hitPct: 0.9, fold: 3, seam: 1 });
        const text = readFileSync(path.join(root, "proxy", files[0]), "utf8");
        for (const leak of ["123456789", "虚构的问题", parent]) assert.ok(!text.includes(leak), `ledger leaked ${leak}`);
        const hb = JSON.parse(readFileSync(path.join(root, "proxy", "heartbeat.json"), "utf8")) as Record<string, unknown>;
        assert.equal(hb.writer, "proxy");
        assert.equal((hb.writerStats as Record<string, unknown>).epoch, 1);
        assert.equal(hb.state, "on");
        assert.equal(hb.commit, "abc1234");
        assert.ok(existsSync(path.join(root, "proxy", "writer.lock")));
        stopFishLedger("test");
        const after = rows(path.join(root, "proxy", files[0]));
        assert.equal(after[after.length - 1].kind, "op");
        assert.equal((after[after.length - 1].ref as Record<string, unknown>).action, "writer-stop");
        assert.ok(!existsSync(path.join(root, "proxy", "writer.lock")), "close releases our lock");
    } finally {
        _resetFishLedgerForTest();
        rmSync(parent, { recursive: true, force: true });
    }
});

test("writer: off file stops writing after one op/off; a torn tail is isolated on reopen", () => {
    const parent = tmp("off");
    try {
        const root = makeRoot(parent);
        let t = Date.UTC(2026, 10, 20, 3, 0, 0);
        const now = (): number => t;
        const w = openWriter({ root, writer: "proxy", now, version: "t" });
        assert.equal(w.state().state, "on");
        assert.ok(w.append("usage", { ref: { layer: "provider" }, data: { total: 1 } }));
        writeFileSync(path.join(root, "off"), "");
        t += 61_000;
        w.tick();
        assert.equal(w.state().state, "off");
        assert.equal(w.state().reason, "off-file");
        assert.equal(w.append("usage", { ref: { layer: "provider" } }), null);
        w.close("test");
        const file = path.join(root, "proxy", "ledger-2026-11.jsonl");
        const r1 = rows(file);
        assert.deepEqual(r1.map((x) => (x.ref as Record<string, unknown>).action ?? x.kind), ["writer-start", "usage", "off"]);
        rmSync(path.join(root, "off"));
        appendFileSync(file, '{"schema":1,"half":"一半');
        const w2 = openWriter({ root, writer: "proxy", now, version: "t" });
        assert.equal(w2.state().state, "on");
        assert.equal(w2.state().tornFixed, 1);
        w2.close("test");
        const lines = readFileSync(file, "utf8").split("\n");
        const torn = lines.findIndex((l) => l.includes('"half"'));
        assert.ok(torn >= 0);
        const after = lines.slice(torn + 1).filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
        assert.equal((after[0].ref as Record<string, unknown>).action, "torn-tail");
        assert.equal(after[0].lseq, 4, "lseq continues after the last complete row");
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

test("writer: meta.json / salt unreadable at open (EBUSY once), or a root that shows up late, is picked up within a minute", () => {
    const parent = tmp("retry");
    try {
        for (const which of ["meta.json", "salt"]) {
            const sub = path.join(parent, which.replace(".", "-"));
            mkdirSync(sub);
            const root = makeRoot(sub);
            let busy = 1;
            const realRead = nodeFs.readFileSync;
            const fsx = {
                ...nodeFs,
                readFileSync: ((p: string, ...a: unknown[]) => {
                    if (busy > 0 && path.basename(String(p)) === which && path.dirname(String(p)) === root) { busy -= 1; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
                    return (realRead as (...x: unknown[]) => unknown)(p, ...a);
                }),
            };
            let t = Date.UTC(2026, 10, 20, 3, 0, 0);
            const now = (): number => t;
            const w = openWriter({ root, writer: "proxy", now, version: "t", fs: fsx as never });
            assert.deepEqual([w.state().state, w.state().reason], ["off", which === "salt" ? "no-salt" : "no-meta"], which);
            t += 30_000; w.tick();
            assert.equal(w.state().state, "off", "not looked at again within a minute");
            t += 30_000; w.tick();
            assert.equal(w.state().state, "on", `${which}: picked up after a minute`);
            assert.ok(w.append("usage", { ref: { layer: "provider" }, data: { total: 1 } }));
            w.close("test");
        }
        const lateParent = path.join(parent, "late");
        const late = path.join(lateParent, "ledger");
        let t = Date.UTC(2026, 10, 20, 3, 0, 0);
        const now = (): number => t;
        const w = openWriter({ root: late, writer: "proxy", now, version: "t" });
        assert.deepEqual([w.state().state, w.state().reason], ["no-root", "missing"]);
        t += 60_000; w.tick();
        assert.ok(!existsSync(late), "tick never creates the root");
        mkdirSync(lateParent);
        makeRoot(lateParent);
        t += 60_000; w.tick();
        assert.equal(w.state().state, "on");
        w.close("test");
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------ contract with the core

type Core = Record<string, (...args: unknown[]) => unknown>;
const CORE_PATH = process.env.FISH_LEDGER_CORE;
const coreSkip = CORE_PATH === undefined || CORE_PATH === "" ? "FISH_LEDGER_CORE not set (contract test needs the workspace core)" : false;
async function loadCore(): Promise<Core> {
    return (await import(pathToFileURL(CORE_PATH as string).href)) as Core;
}

test("contract: pure functions agree with ledger-core.mjs", { skip: coreSkip }, async () => {
    const core = await loadCore();
    const home = tmp("contract");
    try {
        const keys: unknown[] = [KEY, Buffer.alloc(32, 7), Buffer.alloc(16), null, "not a key"];
        const datas: unknown[] = ["", "abc", "多字节 ✓", Buffer.from([0, 1, 2]), new Uint8Array([9, 8]), 5, null];
        for (const k of keys) for (const d of datas) {
            assert.equal(hmacHex(k, d), core.hmacHex(k, d));
            assert.equal(egressHash(k, d), core.egressHash(k, d));
        }
        for (const k of keys) for (const [ns, raw] of [["qq:group", "123"], ["qq:private", 42], ["onebot", "x"], [5, "y"]] as const) assert.equal(pseudoId(k, ns, raw), core.pseudoId(k, ns, raw));
        for (const k of keys) for (const sid of ["session-abc", "onebot-group-123", "onebot-private-77_sub:abc", "onebot-other", "onebot-group-12x", "", 7, null]) assert.equal(sessionRef(k, sid), core.sessionRef(k, sid));
        for (const sid of ["a_sub:b", "a", "_sub:", 3, null]) assert.equal(baseSid(sid), core.baseSid(sid));
        for (const o of [{ upstreamHost: "API.Anthropic.com:443" }, { upstreamHost: "api.deepseek.com" }, { upstreamHost: "127.0.0.1:9" }, { protocol: "openai" }, {}, null]) assert.equal(providerOf(o), core.providerOf(o));
        for (const ms of [0, Date.UTC(2026, 10, 30, 15, 0, 0), 8.64e15, 8.64e15 + 1, NaN, "x"]) {
            assert.equal(isoOf(ms), core.isoOf(ms));
            for (const tz of [540, -720, 0]) if (typeof ms === "number" && Number.isFinite(ms)) assert.equal(localMonth(ms, tz), core.localMonth(ms, tz));
        }
        for (const p of [path.join(home, "a", "b"), home, path.join(path.parse(home).root, "elsewhere"), "", null]) assert.equal(maskPath(p, home), core.maskPath(p, home));
        const realpath = (p: string): string => p;
        const envs: Array<Record<string, string>> = [{}, { FISH_LEDGER_DIR: path.join(home, "r") }, { FISH_LEDGER_DIR: "rel" }, { BILI_LAUNCHER_LANE: "dsh" }, { BILI_LAUNCHER_LANE: "dsh", DSH_HOME: path.join(home, "c") }, { BILI_LAUNCHER_LANE: "dsh", DSH_FISH_HOME: "x" }, { BILI_LAUNCHER_LANE: "dsh", DSH_HOME: "~/.dsh" }, { BILI_LAUNCHER_LANE: "dsh", NODE_ENV: "test" }, { BILI_LAUNCHER_LANE: "dsh", NODE_TEST_CONTEXT: "child-v8" }, { BILI_LAUNCHER_LANE: "dsh", NODE_ENV: "test", FISH_LEDGER_DIR: path.join(home, "t") }];
        for (const env of envs) assert.deepEqual(proxyLedgerRoot({ env, home, realpath }), core.proxyLedgerRoot({ env, home, realpath }));
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("contract: the TS writer and the core writer produce byte-identical files", { skip: coreSkip }, async () => {
    const core = await loadCore();
    const parent = tmp("parity");
    try {
        mkdirSync(path.join(parent, "ts"));
        mkdirSync(path.join(parent, "core"));
        const roots = { ts: makeRoot(path.join(parent, "ts")), core: makeRoot(path.join(parent, "core")) };
        const script = (open: (o: Record<string, unknown>) => { append: (k: string, f: unknown) => unknown; tick: () => void; close: (r?: string) => void; state: () => Record<string, unknown> }, root: string): Array<unknown> => {
            const trace: unknown[] = [];
            let t = Date.UTC(2026, 10, 30, 14, 59, 0); // 23:59 Tokyo, last day of the month
            const now = (): number => t;
            const base = { root, writer: "proxy", now, pid: process.pid, procStart: "2026-11-30T14:00:00.000Z", version: "parity", limits: { partMax: 2048 } };
            const w1 = open({ ...base, instance: "aaaaaaaaaaaaaaaa" });
            trace.push(w1.state().state);
            for (let i = 0; i < 6; i++) trace.push(w1.append("request-manifest", { ref: { layer: "egress", fishReq: `fq-a-b-${i + 1}` }, data: { lane: "main", send: 1 }, author: "proxy", status: "noted", hash: "hmac:" + "0".repeat(64), size: { bytes: i * 10 } }));
            trace.push(w1.append("bogus-kind", {}));
            trace.push(w1.append("request-manifest", { ref: { layer: "bridge" }, data: { add: Array.from({ length: 30_000 }, (_, i) => [i, `m${i}`, "user", null, null, "f".repeat(32), 10]) } }));
            t += 120_000; // crosses midnight Tokyo → December file
            w1.tick();
            trace.push(w1.append("usage", { ref: { layer: "provider" }, data: { total: 5 }, readers: ["b", "a", "a"], derivedFrom: ["x", 3] }));
            w1.close("first");
            const dir = path.join(root, "proxy");
            const dec = path.join(dir, "ledger-2026-12.jsonl");
            appendFileSync(dec, '{"schema":1,"torn');
            const w2 = open({ ...base, instance: "bbbbbbbbbbbbbbbb" });
            for (let i = 0; i < 40; i++) w2.append("usage", { ref: { layer: "provider" }, data: { i } }); // rolls parts at 2 KiB
            t += 61_000;
            w2.tick();
            trace.push(w2.state());
            w2.close("second");
            return trace;
        };
        const tsTrace = script((o) => openWriter(o as never) as never, roots.ts);
        const coreTrace = script((o) => core.openWriter(o) as never, roots.core);
        assert.deepEqual(tsTrace, coreTrace);
        const tsFiles = readdirSync(path.join(roots.ts, "proxy")).sort();
        const coreFiles = readdirSync(path.join(roots.core, "proxy")).sort();
        assert.deepEqual(tsFiles, coreFiles);
        assert.ok(tsFiles.some((f) => /-p00\d\.jsonl$/.test(f)), "the size roll-over produced a second part");
        for (const f of tsFiles) {
            const a = readFileSync(path.join(roots.ts, "proxy", f), "utf8").replace(/"at":"[^"]*"/g, '"at":"T"');
            const b = readFileSync(path.join(roots.core, "proxy", f), "utf8").replace(/"at":"[^"]*"/g, '"at":"T"');
            assert.equal(a, b, `file ${f} differs between the TS and the core writer`);
        }
        // The core reads what the TS writer wrote.
        const listed = core.listLedgerFiles(path.join(roots.ts, "proxy")) as Array<{ file: string }>;
        let total = 0;
        let last = 0;
        for (const f of listed) {
            const rr = core.readRows(f.file) as { rows: Array<{ lseq: number; id: string }>; bad: unknown[]; torn: unknown };
            if (!f.file.endsWith("ledger-2026-12.jsonl")) assert.deepEqual(rr.bad, []);
            assert.equal(rr.torn, null);
            for (const row of rr.rows) {
                assert.ok(row.lseq > last, "lseq strictly increasing across files");
                assert.equal(row.id, `g1-${row.lseq}`);
                last = row.lseq;
                total++;
            }
        }
        const tail = core.tailSeq(path.join(roots.ts, "proxy")) as { lseq: number };
        assert.equal(tail.lseq, last);
        assert.ok(total > 40);
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------ wired into the proxy

test("startServer opens the writer after binding; /__bili/health carries fishLedger", async () => {
    const { bringUpProxy } = await import("./fish-ledger-harness.ts");
    const { closeServers } = await import("./server-close-guard.ts");
    const parent = tmp("health");
    const saved = process.env.FISH_LEDGER_DIR;
    try {
        const root = makeRoot(parent);
        _resetFishLedgerForTest();
        process.env.FISH_LEDGER_DIR = root;
        const h = await bringUpProxy("health");
        try {
            let body: Record<string, unknown> | undefined;
            for (let i = 0; i < 50 && body === undefined; i++) {
                const res = await fetch(`${h.origin}/__bili/health`);
                if (res.ok) body = (await res.json()) as Record<string, unknown>;
                else { await res.arrayBuffer(); await new Promise((r) => setTimeout(r, 50)); }
            }
            assert.ok(body, "health answered");
            const fl = body.fishLedger as Record<string, unknown>;
            assert.equal(fl.v, 1);
            assert.equal(fl.state, "on");
            assert.deepEqual(fl.capabilities, ["fish-request-header"]);
            assert.ok(existsSync(path.join(root, "proxy", "heartbeat.json")));
            assert.ok(!JSON.stringify(fl).includes(parent), "health must not carry an absolute path");
        } finally {
            h.store.cancelAll();
            await closeServers([h.proxy, h.upstream], "fish health");
            rmSync(h.root, { recursive: true, force: true });
        }
    } finally {
        if (saved === undefined) delete process.env.FISH_LEDGER_DIR;
        else process.env.FISH_LEDGER_DIR = saved;
        _resetFishLedgerForTest();
        rmSync(parent, { recursive: true, force: true });
    }
});
