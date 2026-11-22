// fish-ledger P0: a proxy started by a test never writes a ledger outside the test's own tmp root.
//
// The proxy's root on the DSH lane is <os.homedir()>/.dsh-fish-ledger, and on Windows os.homedir()
// follows USERPROFILE only — so a test that swaps HOME (the #4977 suite starts real DSH-lane proxies
// exactly like that) still resolves the developer's REAL home. Two locks close it:
//   1. tests/preload-test-env.mjs pins FISH_LEDGER_DIR to an absolute, never-created tmp path for the
//      whole suite; every child spawned with `...process.env` inherits it (→ no-root/missing).
//   2. proxyLedgerRoot gives no root to a test process (NODE_ENV=test or node --test's
//      NODE_TEST_CONTEXT) unless FISH_LEDGER_DIR names one.
// Plus a static check: a test file that starts a real proxy entry on the DSH lane must hand the child
// either the inherited environment (`...process.env`) or an explicit FISH_LEDGER_DIR.

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { proxyLedgerRoot } from "../src/fish-ledger.ts";

const ROOT = path.join(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "src", "index.ts");
const under = (p: string, dir: string): boolean => {
    const a = path.resolve(p).toLowerCase();
    const b = path.resolve(dir).toLowerCase();
    return a === b || a.startsWith(b + path.sep);
};

test("preload pins FISH_LEDGER_DIR to an absolute, never-created tmp path", () => {
    const d = process.env.FISH_LEDGER_DIR;
    assert.ok(typeof d === "string" && path.isAbsolute(d), "FISH_LEDGER_DIR set by tests/preload-test-env.mjs");
    assert.ok(under(d, tmpdir()), "under the OS tmp dir");
    assert.ok(!existsSync(d), "never created");
    assert.deepEqual(proxyLedgerRoot(), { root: path.resolve(d), why: "env" });
});

test("proxyLedgerRoot: a test process gets no root unless FISH_LEDGER_DIR names one", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fish-ledger-test-root-"));
    try {
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "dsh", NODE_ENV: "test" }, home }), { root: null, why: "test" });
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "dsh", NODE_TEST_CONTEXT: "child-v8" }, home }), { root: null, why: "test" });
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "dsh", NODE_ENV: "production" }, home }), { root: path.join(home, ".dsh-fish-ledger"), why: "live" });
        const abs = path.join(home, "named");
        assert.deepEqual(proxyLedgerRoot({ env: { BILI_LAUNCHER_LANE: "dsh", NODE_ENV: "test", FISH_LEDGER_DIR: abs }, home }), { root: path.resolve(abs), why: "env" });
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("static: every test that starts a real proxy entry on the DSH lane hands it the inherited env or FISH_LEDGER_DIR", () => {
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    let checked = 0;
    for (const f of readdirSync(dir).filter((x) => /\.test\.(ts|mjs|js)$/.test(x))) {
        const s = readFileSync(path.join(dir, f), "utf8");
        const dshLane = /BILI_LAUNCHER_LANE\s*:\s*["'`]dsh["'`]/.test(s) || (/BILI_LAUNCHER_LANE\s*:\s*LANE\b/.test(s) && /\bLANE\s*=\s*["'`]dsh["'`]/.test(s));
        const realEntry = /src[\\/"'`, ]+index\.ts|dist[\\/"'`, ]+index\.js/.test(s) && /\b(spawn|spawnSync|fork|execFile|execFileSync)\(/.test(s);
        if (!dshLane || !realEntry) continue;
        checked++;
        if (!/\.\.\.process\.env\b/.test(s) && !/FISH_LEDGER_DIR/.test(s)) offenders.push(f);
    }
    assert.ok(checked >= 1, "the #4977 suite (a real DSH-lane proxy) is found by this scan");
    assert.deepEqual(offenders, [], "these tests start a DSH-lane proxy with neither the inherited env nor FISH_LEDGER_DIR");
});

// ------------------------------------------------------------------ a real child proxy, #4977 shape

async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

async function killChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/** A complete, valid ledger root (fictional salt, fictional owner pseudonym) with proxy/enabled — what a
 *  live home holds after P0b. Returns the list of files in it, for the before/after comparison. */
function makeLiveLikeRoot(root: string): void {
    mkdirSync(path.join(root, "proxy"), { recursive: true });
    writeFileSync(path.join(root, "meta.json"), JSON.stringify({ schema: 1, epoch: 1, createdAt: "2026-11-20T03:00:00.000Z", tzOffsetMin: 540, by: "test", owner: { qqPrivate: "h0123456789abcdef" } }) + "\n");
    writeFileSync(path.join(root, "salt"), "c3".repeat(32) + "\n");
    writeFileSync(path.join(root, "proxy", "enabled"), JSON.stringify({ schema: 1, by: "test" }) + "\n");
}
const listTree = (d: string): string[] => {
    const out: string[] = [];
    const walk = (x: string, rel: string): void => {
        for (const e of readdirSync(x, { withFileTypes: true })) {
            const r = rel === "" ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) walk(path.join(x, e.name), r);
            else out.push(r);
        }
    };
    if (existsSync(d)) walk(d, "");
    return out.sort();
};

async function startProxy(sandbox: string, envOver: Record<string, string | undefined>): Promise<{ state: string | null; reason: string | null }> {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: path.join(sandbox, "home"),
        XDG_STATE_HOME: path.join(sandbox, "state"),
        XDG_DATA_HOME: path.join(sandbox, "data"),
        XDG_CONFIG_HOME: path.join(sandbox, "config"),
        XDG_CACHE_HOME: path.join(sandbox, "cache"),
        BILI_SESSIONS_DIR: path.join(sandbox, "sessions"),
        BILI_LAUNCHER_LANE: "dsh",
        BILI_PARENT_PID: String(process.pid),
        BILI_STRICT_PORT: "1",
        BILI_MITM: "0",
        ACP_PASSTHROUGH: "0",
    };
    for (const [k, v] of Object.entries(envOver)) { if (v === undefined) delete env[k]; else env[k] = v; }
    for (const d of ["home", "state", "data", "config", "cache", "sessions"]) mkdirSync(path.join(sandbox, d), { recursive: true });
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, "start", "--host", "127.0.0.1", "--port", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => { output = (output + c).slice(-4000); });
    child.stderr?.on("data", (c: string) => { output = (output + c).slice(-4000); });
    try {
        const deadline = Date.now() + 60_000;
        for (;;) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/__bili/health`);
                if (res.ok) {
                    const body = await res.json() as { fishLedger?: { state?: string; reason?: string | null } };
                    // let a writer that did open write its first rows before the tree is compared
                    await new Promise((r) => setTimeout(r, 500));
                    return { state: body.fishLedger?.state ?? null, reason: body.fishLedger?.reason ?? null };
                }
            } catch { /* still starting */ }
            if (child.exitCode !== null || Date.now() > deadline) throw new Error(`proxy did not answer /__bili/health (exit ${child.exitCode}): ${output.slice(-600)}`);
            await new Promise((r) => setTimeout(r, 200));
        }
    } finally {
        await killChild(child);
    }
}

test("a real DSH-lane proxy started the #4977 way (HOME swapped, USERPROFILE not) never touches the USERPROFILE ledger", { timeout: 240_000 }, async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "fish-ledger-4977-"));
    try {
        // USERPROFILE stands in for the developer's real home after P0b: a complete root with proxy/enabled
        const fakeReal = path.join(sandbox, "fake-real-home");
        const liveRoot = path.join(fakeReal, ".dsh-fish-ledger");
        makeLiveLikeRoot(liveRoot);
        const before = listTree(liveRoot);
        // a. exactly #4977's shape: inherits the preload's FISH_LEDGER_DIR, NODE_ENV=test, NODE_TEST_CONTEXT removed
        const a = await startProxy(path.join(sandbox, "a"), { NODE_ENV: "test", NODE_TEST_CONTEXT: undefined, USERPROFILE: fakeReal });
        assert.equal(a.state, "no-root", JSON.stringify(a));
        assert.deepEqual(listTree(liveRoot), before, "(a) not one file appeared in the USERPROFILE ledger");
        // b. a test that dropped FISH_LEDGER_DIR but runs with NODE_ENV=test: the test guard
        const b = await startProxy(path.join(sandbox, "b"), { NODE_ENV: "test", NODE_TEST_CONTEXT: undefined, FISH_LEDGER_DIR: undefined, USERPROFILE: fakeReal });
        assert.deepEqual(b, { state: "no-root", reason: "test" });
        assert.deepEqual(listTree(liveRoot), before, "(b) not one file appeared in the USERPROFILE ledger");
        // c. control (the hole the two locks close): neither lock → the child resolves USERPROFILE and writes there
        const c = await startProxy(path.join(sandbox, "c"), { NODE_ENV: undefined, NODE_TEST_CONTEXT: undefined, FISH_LEDGER_DIR: undefined, USERPROFILE: fakeReal });
        assert.equal(c.state, "on", "control: without the locks the proxy opens the USERPROFILE root " + JSON.stringify(c));
        assert.ok(listTree(liveRoot).some((f) => /^proxy\/ledger-\d{4}-\d{2}\.jsonl$/.test(f)), "control: rows were written under USERPROFILE");
    } finally {
        rmSync(sandbox, { recursive: true, force: true });
    }
});
