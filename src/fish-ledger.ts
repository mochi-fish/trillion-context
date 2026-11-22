// fish-ledger P0 — the proxy's writer for the local evidence ledger.
//
// What it records (INTERFACES.md §4.3, §8): one `request-manifest` row
// (layer "egress") right before every model request leaves for an upstream —
// a keyed HMAC-SHA256 of the exact outbound body bytes plus their length, the
// host's request id when the loopback hop carried one — and one `usage` row
// (layer "provider") per settled usage report. Rows carry ids, keyed hashes,
// pseudonyms, counts and model names only: never a body, a header value, a
// session's content or an absolute path.
//
// Where it writes: `<root>/proxy/ledger-YYYY-MM[-pNNN].jsonl`. The root is NOT
// derived from homedir() by default (ledger review M3): it is FISH_LEDGER_DIR
// when that is an absolute path, otherwise `<home>/.dsh-fish-ledger` only when
// the launcher marked this proxy as the DSH lane (BILI_LAUNCHER_LANE=dsh) and
// neither DSH_HOME (pointing elsewhere) nor DSH_FISH_HOME is set. The root
// must already exist and carry meta.json + salt, and the proxy additionally
// needs `<root>/proxy/enabled`; otherwise nothing is written — not a lock, not
// a heartbeat, not a byte.
//
// Never throws into a request: every entry point swallows its own errors and
// counts them. Writing is a synchronous append on an open fd (no fsync).
//
// This is a TypeScript port of the writer half of ledger-core.mjs (v0.1.0,
// INTERFACES §3.11): same root rules, meta/salt checks, lease lock, sequence
// recovery, torn-tail isolation, month/size roll-over, short-write and
// back-off handling, buffer caps and row layout. The contract test
// (tests/fish-ledger-writer.test.ts) runs both side by side when
// FISH_LEDGER_CORE points at the core file.

import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { FISH_REQUEST_CAPABILITY, FISH_SYM, fishRequestIdOf } from "./fish-request.js";

// ---------------------------------------------------------------- constants (§3.1)

const LEDGER_SCHEMA = 1;
/** The core version this port mirrors (rows' writer-start `coreVersion`). */
const LEDGER_CORE_VERSION = "0.1.0";
const WRITERS: Readonly<Record<string, string>> = Object.freeze({ bridge: "b", plugin: "p", proxy: "g" });
const KINDS: readonly string[] = Object.freeze(["utterance", "tool-result", "request-manifest", "usage", "delivery", "op"]);

interface LedgerLimits {
    rowMax: number;
    partMax: number;
    tailScan: number;
    bufferBytes: number;
    bufferRows: number;
    seqEvery: number;
    leaseMs: number;
    renewMs: number;
    retryMs: number;
    offCheckMs: number;
    backoffMs: number;
    manifestAddMax: number;
    manifestTail: number;
}

const LEDGER_LIMITS: Readonly<LedgerLimits> = Object.freeze({
    rowMax: 1_048_576,
    partMax: 268_435_456,
    tailScan: 2_097_152,
    bufferBytes: 8_388_608,
    bufferRows: 4096,
    seqEvery: 256,
    leaseMs: 300_000,
    renewMs: 60_000,
    retryMs: 60_000,
    offCheckMs: 60_000,
    backoffMs: 30_000,
    manifestAddMax: 512,
    manifestTail: 64,
});

// ---------------------------------------------------------------- small helpers

type Fs = typeof nodeFs;
type Obj = Record<string, unknown>;

const WIN = process.platform === "win32";
const NL = 0x0a;
const caseKey = (p: string): string => (WIN ? p.toLowerCase() : p);
const isStr = (s: unknown): s is string => typeof s === "string" && s !== "";
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const errCode = (e: unknown): string => {
    const c = (e as { code?: unknown } | null)?.code;
    return typeof c === "string" && c !== "" ? c : "EUNKNOWN";
};

interface TestHook { fs?: Fs; now?: () => number; limits?: Partial<LedgerLimits> }

/** Test hooks: only when FISH_LEDGER_TEST=1 (INTERFACES §12, same symbol as the core). */
function testHook(): TestHook | null {
    try {
        if (process.env.FISH_LEDGER_TEST !== "1") return null;
        const h = (globalThis as Record<PropertyKey, unknown>)[FISH_SYM.test];
        return h !== null && typeof h === "object" ? (h as TestHook) : null;
    } catch {
        return null;
    }
}
const pickFs = (fs?: Fs): Fs => fs ?? testHook()?.fs ?? nodeFs;
const pickNow = (now?: () => number): (() => number) => {
    if (typeof now === "function") return now;
    const h = testHook();
    return typeof h?.now === "function" ? h.now : Date.now;
};
const pickLimits = (over?: Partial<LedgerLimits>): Readonly<LedgerLimits> => {
    const h = testHook()?.limits;
    return Object.freeze({ ...LEDGER_LIMITS, ...(isObj(h) ? h : {}), ...(isObj(over) ? over : {}) });
};

function readJsonImpl(p: string, fs: Fs): Obj | null {
    try {
        let s: unknown = fs.readFileSync(p, "utf8");
        if (typeof s !== "string") s = String(s);
        let t = s as string;
        if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
        const v: unknown = JSON.parse(t);
        return isObj(v) ? v : null;
    } catch {
        return null;
    }
}

/** tmp + rename; null on success, an error code otherwise (tmp removed, never throws). */
function atomicWrite(p: string, obj: unknown, fs: Fs): string | null {
    const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
        const s = JSON.stringify(obj);
        if (typeof s !== "string") return "EBADROW";
        fs.writeFileSync(tmp, s + "\n", { flag: "wx" });
        fs.renameSync(tmp, p);
        return null;
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* never created */ }
        return errCode(e);
    }
}

function exists(p: string, fs: Fs): boolean {
    try {
        fs.statSync(p);
        return true;
    } catch (e) {
        const c = (e as { code?: unknown } | null)?.code;
        // only a definite "not there" counts as absent (off/enabled err on the side of stopping)
        return !(c === "ENOENT" || c === "ENOTDIR");
    }
}

function readFully(fs: Fs, fd: number, buf: Buffer, pos: number): number {
    let got = 0;
    while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, pos + got);
        if (!(n > 0)) break;
        got += n;
    }
    return got;
}

// ---------------------------------------------------------------- root, key, meta (§2.2, §3.2)

type Realpath = (p: string) => string;
const defaultRealpath: Realpath = (p) => nodeFs.realpathSync.native(p);

function safeReal(p: string, realpath: Realpath): string {
    const abs = path.resolve(p);
    try {
        const r = realpath(abs);
        return isStr(r) ? path.resolve(r) : abs;
    } catch {
        return abs;
    }
}
const samePath = (a: string, b: string, realpath: Realpath): boolean => caseKey(safeReal(a, realpath)) === caseKey(safeReal(b, realpath));

function expandTilde(p: string, home: string): string {
    if (p === "~") return home;
    if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
    return p;
}

type ProxyRootWhy = "env" | "env-relative" | "test" | "lane" | "dsh-home" | "fish-home" | "live";

/** The proxy's ledger root (INTERFACES §2.2). Never consults the root's existence. */
export function proxyLedgerRoot(opts: { env?: Record<string, string | undefined>; home?: string; realpath?: Realpath } = {}): { root: string | null; why: ProxyRootWhy } {
    try {
        const e = opts.env ?? process.env ?? {};
        const h = isStr(opts.home) ? opts.home : os.homedir();
        const rp = typeof opts.realpath === "function" ? opts.realpath : defaultRealpath;
        const d = e.FISH_LEDGER_DIR;
        if (isStr(d)) return path.isAbsolute(d) ? { root: path.resolve(d), why: "env" } : { root: null, why: "env-relative" };
        // A proxy started by a test (NODE_ENV=test, or node --test's NODE_TEST_CONTEXT) gets no root unless
        // FISH_LEDGER_DIR names one: on Windows os.homedir() follows USERPROFILE only, so a test that swaps HOME
        // still resolves the real home (the #4977 suite starts real DSH-lane proxies exactly like that).
        if (e.NODE_ENV === "test" || (isStr(e.NODE_TEST_CONTEXT) && e.NODE_TEST_CONTEXT !== "")) return { root: null, why: "test" };
        if (e.BILI_LAUNCHER_LANE !== "dsh") return { root: null, why: "lane" };
        if (isStr(e.DSH_HOME) && !samePath(expandTilde(e.DSH_HOME, h), path.join(h, ".dsh"), rp)) return { root: null, why: "dsh-home" };
        if (isStr(e.DSH_FISH_HOME)) return { root: null, why: "fish-home" };
        return { root: path.join(h, ".dsh-fish-ledger"), why: "live" };
    } catch {
        return { root: null, why: "lane" };
    }
}

interface LedgerMeta {
    schema: 1;
    epoch: number;
    tzOffsetMin: number;
    owner: { qqPrivate: string };
    [k: string]: unknown;
}

function readMeta(root: unknown, opts: { fs?: Fs } = {}): LedgerMeta | null {
    try {
        if (!isStr(root)) return null;
        const m = readJsonImpl(path.join(root, "meta.json"), pickFs(opts.fs));
        if (!m || m.schema !== 1) return null;
        if (!Number.isSafeInteger(m.epoch) || (m.epoch as number) < 1) return null;
        if (!Number.isInteger(m.tzOffsetMin) || (m.tzOffsetMin as number) < -720 || (m.tzOffsetMin as number) > 840) return null;
        const owner = m.owner;
        if (!isObj(owner) || typeof owner.qqPrivate !== "string" || !/^h[0-9a-f]{16}$/.test(owner.qqPrivate)) return null;
        return m as unknown as LedgerMeta;
    } catch {
        return null;
    }
}

function loadKey(root: unknown, opts: { fs?: Fs } = {}): Buffer | null {
    try {
        if (!isStr(root)) return null;
        const s: unknown = pickFs(opts.fs).readFileSync(path.join(root, "salt"), "utf8");
        const m = /^([0-9a-f]{64})\n?$/.exec(typeof s === "string" ? s : String(s));
        return m ? Buffer.from(m[1], "hex") : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- hashes, pseudonyms (§3.3)

export function hmacHex(key: unknown, data: unknown): string | null {
    try {
        if (!(key instanceof Uint8Array) || key.length !== 32) return null;
        if (typeof data === "string") return createHmac("sha256", key).update(Buffer.from(data, "utf8")).digest("hex");
        if (data instanceof Uint8Array) return createHmac("sha256", key).update(data).digest("hex");
        return null;
    } catch {
        return null;
    }
}

/** 'hmac:' + HMAC-SHA256(key, exact outbound body bytes) — no tag, so a test can
 *  recompute it straight from what the fake upstream received. */
export function egressHash(key: unknown, bodyBytes: unknown): string | null {
    try {
        const h = hmacHex(key, bodyBytes);
        return h === null ? null : "hmac:" + h;
    } catch {
        return null;
    }
}

export function pseudoId(key: unknown, ns: unknown, raw: unknown): string | null {
    try {
        if (typeof ns !== "string") return null;
        const h = hmacHex(key, "id\n" + ns + "\n" + String(raw));
        return h === null ? null : "h" + h.slice(0, 16);
    } catch {
        return null;
    }
}

/** onebot session ids embed QQ numbers — pseudonymize them like the host side does. */
export function sessionRef(key: unknown, sid: unknown): string | null {
    try {
        if (typeof sid !== "string") return null;
        const m = /^onebot-(group|private)-(\d+)(.*)$/.exec(sid);
        if (m) {
            const p = pseudoId(key, "qq:" + m[1], m[2]);
            return p === null ? null : `onebot-${m[1]}-${p}${m[3]}`;
        }
        if (sid.startsWith("onebot-")) {
            const p = pseudoId(key, "onebot", sid.slice("onebot-".length));
            return p === null ? null : "onebot-x-" + p;
        }
        return sid;
    } catch {
        return null;
    }
}

export function baseSid(sid: unknown): string | null {
    try {
        return typeof sid === "string" ? sid.replace(/_sub:[\s\S]*$/, "") : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- time, misc (§3.8)

export function isoOf(ms: unknown): string | null {
    try {
        if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    } catch {
        return null;
    }
}

function localDay(ms: number, tzOffsetMin: unknown): string | null {
    try {
        if (typeof tzOffsetMin !== "number" || !Number.isFinite(tzOffsetMin)) return null;
        const s = isoOf(ms + tzOffsetMin * 60_000);
        return s === null || !/^\d{4}-/.test(s) ? null : s.slice(0, 10);
    } catch {
        return null;
    }
}

export function localMonth(ms: number, tzOffsetMin: unknown): string | null {
    const d = localDay(ms, tzOffsetMin);
    return d === null ? null : d.slice(0, 7);
}

export function providerOf(opts: { upstreamHost?: unknown; protocol?: unknown } | null | undefined): string | null {
    try {
        const o = opts !== null && typeof opts === "object" ? opts : {};
        const h = typeof o.upstreamHost === "string" ? o.upstreamHost.trim().toLowerCase().replace(/:\d+$/, "") : "";
        if (h !== "") {
            if (h === "api.anthropic.com") return "anthropic";
            if (h === "api.deepseek.com") return "deepseek";
            return h;
        }
        return isStr(o.protocol) ? o.protocol : null;
    } catch {
        return null;
    }
}

/** Under home → '~' + rest (always '/'); elsewhere → '<FISH_LEDGER_DIR>'; null → null. */
export function maskPath(p: unknown, home?: string): string | null {
    try {
        if (typeof p !== "string" || p === "") return null;
        const h = isStr(home) ? home : os.homedir();
        const rel = path.relative(path.resolve(h), path.resolve(p));
        if (rel === "") return "~";
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return "<FISH_LEDGER_DIR>";
        return "~/" + rel.split(path.sep).join("/");
    } catch {
        return null;
    }
}

export function writeJsonAtomic(p: unknown, obj: unknown, opts: { fs?: Fs } = {}): boolean {
    try {
        if (!isStr(p)) return false;
        return atomicWrite(p, obj, pickFs(opts.fs)) === null;
    } catch {
        return false;
    }
}

function randomInstance(): string {
    return randomBytes(8).toString("hex");
}

function procStartIso(): string | null {
    try {
        return new Date(Math.round(performance.timeOrigin)).toISOString();
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- reading the tail (§3.6 step 4, §3.7)

const FILE_RE = /^ledger-(\d{4})-(\d{2})(?:-p(\d{3}))?\.jsonl$/;

function partName(ym: string, part: number): string {
    return part <= 1 ? `ledger-${ym}.jsonl` : `ledger-${ym}-p${String(part).padStart(3, "0")}.jsonl`;
}

interface LedgerFile { file: string; name: string; year: number; month: number; part: number; size: number }

/** Throws (readdir failure) to the caller. Sorted by (year, month, part) numerically. */
function listFilesImpl(dir: string, fs: Fs): LedgerFile[] {
    const out: Array<LedgerFile & { plain: number }> = [];
    for (const raw of fs.readdirSync(dir)) {
        const name = String(raw);
        const m = FILE_RE.exec(name);
        if (!m) continue;
        const file = path.join(dir, name);
        let st: nodeFs.Stats;
        try { st = fs.statSync(file); } catch { continue; }
        if (!st.isFile()) continue;
        out.push({ file, name, year: Number(m[1]), month: Number(m[2]), part: m[3] ? Number(m[3]) : 1, size: st.size, plain: m[3] ? 1 : 0 });
    }
    out.sort((a, b) => a.year - b.year || a.month - b.month || a.part - b.part || a.plain - b.plain);
    return out.map(({ plain: _plain, ...f }) => f);
}

/** lseq of one line (without its \n); 0 when the line does not qualify. */
function lineLseq(buf: Buffer, s: number, e: number, rowMax: number): number {
    if (e - s + 1 > rowMax || e <= s || buf[s] !== 0x7b) return 0;
    try {
        const o: unknown = JSON.parse(buf.toString("utf8", s, e));
        return isObj(o) && Number.isSafeInteger(o.lseq) && (o.lseq as number) > 0 ? (o.lseq as number) : 0;
    } catch {
        return 0;
    }
}

/** Stream the whole part (64 KiB chunks); last qualifying complete line's lseq (0 = none). */
function scanWhole(fs: Fs, fd: number, size: number, rowMax: number): number {
    const CH = 65536;
    const chunk = Buffer.alloc(CH);
    let pos = 0;
    let parts: Buffer[] = [];
    let partLen = 0;
    let skipping = false;
    let best = 0;
    while (pos < size) {
        const n = fs.readSync(fd, chunk, 0, Math.min(CH, size - pos), pos);
        if (!(n > 0)) break;
        pos += n;
        let s = 0;
        for (;;) {
            const i = chunk.indexOf(NL, s);
            if (i < 0 || i >= n) break;
            if (!skipping) {
                const piece = chunk.subarray(s, i);
                const line = partLen > 0 ? Buffer.concat([...parts, piece]) : piece;
                const v = lineLseq(line, 0, line.length, rowMax);
                if (v > 0) best = v;
            }
            parts = [];
            partLen = 0;
            skipping = false;
            s = i + 1;
        }
        if (s < n && !skipping) {
            const rest = Buffer.from(chunk.subarray(s, n));
            partLen += rest.length;
            if (partLen > rowMax) { skipping = true; parts = []; partLen = 0; } else parts.push(rest);
        }
    }
    return best;
}

/** Last qualifying complete line of one part: read back tailScan first, scan the
 *  whole part only when that window held no complete line. Throws on read errors. */
function lastLseqOf(file: string, size: number, fs: Fs, L: Readonly<LedgerLimits>): { lseq: number; from: "tail" | "scan" } | null {
    const fd = fs.openSync(file, "r");
    try {
        const start = Math.max(0, size - L.tailScan);
        const buf = Buffer.alloc(size - start);
        const got = readFully(fs, fd, buf, start);
        if (got !== buf.length) throw Object.assign(new Error("short read"), { code: "ESHORTREAD" });
        let end = buf.lastIndexOf(NL);
        while (end >= 0) {
            const prev = end > 0 ? buf.lastIndexOf(NL, end - 1) : -1;
            if (prev < 0 && start > 0) break; // this line starts before the window
            const v = lineLseq(buf, prev + 1, end, L.rowMax);
            if (v > 0) return { lseq: v, from: "tail" };
            end = prev;
        }
        if (start === 0) return null;
        const v = scanWhole(fs, fd, size, L.rowMax);
        return v > 0 ? { lseq: v, from: "scan" } : null;
    } finally {
        try { fs.closeSync(fd); } catch { /* already closed */ }
    }
}

type TailResult = { lseq: number; file: string | null; from: "tail" | "scan" | "none"; error?: undefined } | { error: string };

function tailSeqImpl(dir: string, fs: Fs, L: Readonly<LedgerLimits>): TailResult {
    let files: LedgerFile[];
    try {
        files = listFilesImpl(dir, fs);
    } catch (e) {
        const c = (e as { code?: unknown } | null)?.code;
        if (c === "ENOENT" || c === "ENOTDIR") return { lseq: 0, file: null, from: "none" };
        return { error: errCode(e) };
    }
    for (let i = files.length - 1; i >= 0; i--) {
        const f = files[i];
        if (f.size === 0) continue;
        let r: { lseq: number; from: "tail" | "scan" } | null;
        try { r = lastLseqOf(f.file, f.size, fs, L); } catch (e) { return { error: errCode(e) }; }
        if (r) return { lseq: r.lseq, file: f.name, from: r.from };
    }
    return { lseq: 0, file: null, from: "none" };
}

// ---------------------------------------------------------------- the writer (§3.6)

function liveMap(): Map<string, { instance: string; closed: boolean }> {
    const g = globalThis as Record<PropertyKey, unknown>;
    let m = g[FISH_SYM.liveWriters];
    if (!(m instanceof Map)) {
        m = new Map();
        g[FISH_SYM.liveWriters] = m;
    }
    return m as Map<string, { instance: string; closed: boolean }>;
}

function pidAlive(pid: unknown): boolean {
    // an unreadable pid counts as alive: the lease expiry takes over
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return true;
    try {
        process.kill(pid as number, 0);
        return true;
    } catch (e) {
        return (e as { code?: unknown } | null)?.code !== "ESRCH"; // EPERM (and anything else) = alive
    }
}

function normReaders(r: unknown): string[] | null {
    if (!Array.isArray(r)) return null;
    return [...new Set(r.filter((x): x is string => typeof x === "string"))].sort();
}

const cleanReason = (r: unknown): string | null => (typeof r === "string" && /^[A-Za-z0-9._:-]{1,40}$/.test(r) ? r : null);

interface LedgerWriterState {
    state: string;
    reason: string | null;
    epoch: number | null;
    lseq: number;
    written: number;
    buffered: number;
    bufferedBytes: number;
    dropped: number;
    droppedByKind: Record<string, number>;
    errors: Record<string, number>;
    lastError: { at: string | null; code: string } | null;
    tornFixed: number;
    lockTakeovers: number;
    lockLost: number;
    seqFrom: string | null;
    file: string | null;
    skipped: Record<string, number>;
}

interface LedgerRowFields {
    ref?: unknown;
    data?: unknown;
    author?: unknown;
    relayer?: unknown;
    readers?: unknown;
    readersBy?: unknown;
    occurredAt?: unknown;
    learnedAt?: unknown;
    derivedFrom?: unknown;
    status?: unknown;
    hash?: unknown;
    size?: unknown;
}

interface LedgerWriter {
    readonly key: Buffer | null;
    readonly meta: LedgerMeta | null;
    append(kind: string, fields: LedgerRowFields): { id: string; lseq: number } | null;
    tick(): void;
    flush(): void;
    state(): LedgerWriterState;
    close(reason?: string): void;
}

interface OpenWriterOptions {
    root?: string | null;
    writer?: string;
    fs?: Fs;
    now?: () => number;
    pid?: number;
    procStart?: string;
    instance?: string;
    limits?: Partial<LedgerLimits>;
    version?: string;
}

/** INTERFACES §3.6. Never throws; an unusable writer comes back with state !== 'on'. */
export function openWriter(opts: OpenWriterOptions = {}): LedgerWriter {
    try {
        return makeWriter(isObj(opts) ? opts : {});
    } catch {
        return deadWriter();
    }
}

function deadWriter(): LedgerWriter {
    const st: LedgerWriterState = { state: "error", reason: "lock-io", epoch: null, lseq: 0, written: 0, buffered: 0, bufferedBytes: 0, dropped: 0, droppedByKind: {}, errors: { EUNKNOWN: 1 }, lastError: null, tornFixed: 0, lockTakeovers: 0, lockLost: 0, seqFrom: null, file: null, skipped: {} };
    return { key: null, meta: null, append: () => null, tick() {}, flush() {}, state: () => ({ ...st }), close() {} };
}

interface QueuedRow { lseq: number; kind: string; buf: Buffer }
interface DropPending { count: number; byKind: Record<string, number>; firstLseq: number; lastLseq: number }
interface Takeover { prevPid: number | null; prevInstance: string | null; prevAt: string | null; why: string }

function makeWriter(opts: OpenWriterOptions): LedgerWriter {
    const fs = pickFs(opts.fs);
    const now = pickNow(opts.now);
    const L = pickLimits(opts.limits);
    const writer = typeof opts.writer === "string" ? opts.writer : "";
    const letter = Object.prototype.hasOwnProperty.call(WRITERS, writer) ? WRITERS[writer] : null;
    const root = isStr(opts.root) ? path.resolve(opts.root) : null;
    const ownPid = Number.isSafeInteger(opts.pid) && (opts.pid as number) > 0 ? (opts.pid as number) : process.pid;
    const procStart = isStr(opts.procStart) ? opts.procStart : procStartIso();
    const instance = typeof opts.instance === "string" && /^[0-9a-f]{16}$/.test(opts.instance) ? opts.instance : randomInstance();
    const version = isStr(opts.version) ? opts.version.slice(0, 64) : null;
    const dir = root && letter ? path.join(root, writer) : null;
    const lockPath = dir ? path.join(dir, "writer.lock") : "";
    const lockKey = lockPath ? caseKey(lockPath) : "";
    const seqPath = dir ? path.join(dir, "seq.json") : "";
    const offPath = root ? path.join(root, "off") : "";
    const enabledPath = root ? path.join(root, "proxy", "enabled") : "";

    const S = {
        state: "no-root",
        reason: null as string | null,
        epoch: null as number | null,
        lastLseq: 0,
        written: 0,
        dropped: 0,
        droppedByKind: {} as Record<string, number>,
        errors: {} as Record<string, number>,
        lastError: null as { at: string | null; code: string } | null,
        tornFixed: 0,
        lockTakeovers: 0,
        lockLost: 0,
        seqFrom: null as string | null,
        skipped: {} as Record<string, number>,
    };
    let key: Buffer | null = null;
    let meta: LedgerMeta | null = null;
    let holdLock = false;
    let closed = false;
    let started = false;
    let lseqFrom = 0;
    let fd: number | null = null;
    let fdName: string | null = null;
    let fdMonth: string | null = null;
    let fdSize = 0;
    let retryAt = 0;
    const queue: QueuedRow[] = [];
    let queueBytes = 0;
    let dropPending: DropPending | null = null;
    let sinceCkpt = 0;
    let seqPending = false;
    let pendingTakeover: Takeover | null = null;
    let lastOffCheck = 0;
    let lastRenew = 0;
    let lastRetry = 0;

    const setState = (s: string, r: string | null = null): void => { S.state = s; S.reason = r; };
    const countErr = (code: string): void => {
        const c = isStr(code) ? code : "EUNKNOWN";
        S.errors[c] = (S.errors[c] ?? 0) + 1;
        S.lastError = { at: isoOf(now()), code: c };
    };
    const wref = (action: string): Obj => ({ layer: "writer", action, file: fdName });

    function closeFd(): void {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { /* */ }
            fd = null;
        }
    }
    function fail(code: string): void {
        countErr(code);
        closeFd();
        retryAt = now() + L.backoffMs;
    }

    // step 1: root, meta, salt, enabled — writes nothing, takes no lock
    function step1(): boolean {
        if (!root) { setState("no-root", null); return false; }
        let st: nodeFs.Stats | null = null;
        try { st = fs.statSync(root); } catch { st = null; }
        if (!st || !st.isDirectory()) { setState("no-root", "missing"); return false; }
        meta = readMeta(root, { fs });
        if (!meta) { key = null; setState("off", "no-meta"); return false; }
        S.epoch = meta.epoch;
        key = loadKey(root, { fs });
        if (!key) { setState("off", "no-salt"); return false; }
        if (writer === "proxy" && !exists(enabledPath, fs)) { setState("off", "not-enabled"); return false; }
        return true;
    }

    // step 2: our own sub-directory only (never recursive, never the root)
    function step2(): boolean {
        try {
            fs.mkdirSync(dir as string);
        } catch (e) {
            if ((e as { code?: unknown } | null)?.code !== "EEXIST") { countErr(errCode(e)); setState("error", "mkdir"); return false; }
        }
        return true;
    }

    // step 3: the lease lock
    const lockBody = (): Obj => ({ schema: 1, writer, pid: ownPid, instance, procStart, at: isoOf(now()) });
    function createLock(): "ok" | "exists" | "error" {
        let lfd: number | null = null;
        try {
            lfd = fs.openSync(lockPath, "wx");
        } catch (e) {
            if ((e as { code?: unknown } | null)?.code === "EEXIST") return "exists";
            countErr(errCode(e));
            return "error";
        }
        try {
            const buf = Buffer.from(JSON.stringify(lockBody()) + "\n", "utf8");
            const n = fs.writeSync(lfd, buf);
            if (n !== buf.length) throw Object.assign(new Error("short"), { code: "ESHORT" });
            fs.closeSync(lfd);
            lfd = null;
            return "ok";
        } catch (e) {
            countErr(errCode(e));
            if (lfd !== null) { try { fs.closeSync(lfd); } catch { /* */ } }
            try { fs.unlinkSync(lockPath); } catch { /* */ }
            return "error";
        }
    }
    function gotLock(): boolean {
        holdLock = true;
        liveMap().set(lockKey, { instance, closed: false });
        lastRenew = now();
        return true;
    }
    function markLiveClosed(): void {
        const e = liveMap().get(lockKey);
        if (e && e.instance === instance) e.closed = true;
    }
    function stalePath(): string {
        const base = `${lockPath}.stale-${Math.floor(now())}`;
        if (!exists(base, fs)) return base;
        for (let i = 2; i < 100; i++) if (!exists(`${base}-${i}`, fs)) return `${base}-${i}`;
        return `${base}-${randomBytes(3).toString("hex")}`;
    }
    function acquire(): boolean {
        for (let attempt = 0; attempt < 3; attempt++) {
            const r = createLock();
            if (r === "ok") return gotLock();
            if (r === "error") { setState("error", "lock-io"); return false; }
            const cur = readJsonImpl(lockPath, fs);
            let why: string;
            if (!cur) {
                let mt: number;
                try { mt = fs.statSync(lockPath).mtimeMs; } catch { continue; } // just removed: try creating again
                if (now() - mt > L.leaseMs) why = "unreadable";
                else { setState("locked", "held"); return false; }
            } else if (cur.instance === instance) {
                return gotLock();
            } else if (cur.pid === ownPid) {
                const lw = liveMap().get(lockKey);
                if (lw && lw.instance === cur.instance && !lw.closed) { setState("locked", "held"); return false; }
                why = "same-proc-closed";
            } else if (!pidAlive(cur.pid)) {
                why = "dead";
            } else {
                let at = Date.parse(String(cur.at));
                if (!Number.isFinite(at)) { try { at = fs.statSync(lockPath).mtimeMs; } catch { at = now(); } }
                if (now() - at > L.leaseMs) why = "expired";
                else { setState("locked", "held"); return false; }
            }
            // take over: keep the old lock under a new name (P0 deletes nothing), then create ours
            try { fs.renameSync(lockPath, stalePath()); } catch { setState("locked", "held"); return false; }
            const r2 = createLock();
            if (r2 === "ok") {
                pendingTakeover = {
                    prevPid: cur !== null && Number.isSafeInteger(cur.pid) ? (cur.pid as number) : null,
                    prevInstance: cur !== null && typeof cur.instance === "string" && /^[0-9a-f]{16}$/.test(cur.instance) ? cur.instance : null,
                    prevAt: cur !== null && typeof cur.at === "string" && cur.at.length <= 40 ? cur.at : null,
                    why,
                };
                S.lockTakeovers++;
                return gotLock();
            }
            if (r2 === "exists") { setState("locked", "held"); return false; }
            setState("error", "lock-io");
            return false;
        }
        setState("locked", "held");
        return false;
    }
    function releaseLock(): void {
        if (!holdLock) return;
        holdLock = false;
        const cur = readJsonImpl(lockPath, fs);
        if (cur && cur.instance === instance) {
            try { fs.unlinkSync(lockPath); } catch (e) { countErr(errCode(e)); }
        }
        markLiveClosed();
    }
    function discardQueue(): void {
        for (const q of queue) {
            S.dropped++;
            S.droppedByKind[q.kind] = (S.droppedByKind[q.kind] ?? 0) + 1;
        }
        queue.length = 0;
        queueBytes = 0;
        dropPending = null;
    }

    // step 4: next = max(L+1, C+1) — never restart from 0
    function step4(): boolean {
        const t = tailSeqImpl(dir as string, fs, L);
        if (t.error !== undefined) { countErr(t.error); setState("error", "seq-read"); return false; }
        let C = 0;
        const sj = readJsonImpl(seqPath, fs);
        if (sj && sj.writer === writer && sj.epoch === (meta as LedgerMeta).epoch && Number.isSafeInteger(sj.lseq) && (sj.lseq as number) > 0) C = sj.lseq as number;
        S.seqFrom = C > t.lseq ? "ckpt" : t.lseq > 0 ? t.from : "fresh";
        const base = Math.max(t.lseq, C, S.lastLseq);
        lseqFrom = base;
        S.lastLseq = base;
        return true;
    }

    // opening the fd (§3.6.1): every (re)open looks at the last byte first
    function findTornStart(file: string, size: number): { offset: number | null; length: number | null } {
        let rfd: number | null = null;
        try {
            rfd = fs.openSync(file, "r");
            const start = Math.max(0, size - L.tailScan);
            const buf = Buffer.alloc(size - start);
            readFully(fs, rfd, buf, start);
            const i = buf.lastIndexOf(NL);
            if (i >= 0) return { offset: start + i + 1, length: size - (start + i + 1) };
            if (start === 0) return { offset: 0, length: size };
            return { offset: null, length: null };
        } catch {
            return { offset: null, length: null };
        } finally {
            if (rfd !== null) { try { fs.closeSync(rfd); } catch { /* */ } }
        }
    }
    function lastByte(file: string, size: number): number {
        const rfd = fs.openSync(file, "r");
        try {
            const b = Buffer.alloc(1);
            const n = fs.readSync(rfd, b, 0, 1, size - 1);
            if (n !== 1) throw Object.assign(new Error("short read"), { code: "ESHORTREAD" });
            return b[0];
        } finally {
            try { fs.closeSync(rfd); } catch { /* */ }
        }
    }
    function openFd(): boolean {
        if (fd !== null) return true;
        const ym = localMonth(now(), (meta as LedgerMeta).tzOffsetMin) as string;
        let files: LedgerFile[];
        try { files = listFilesImpl(dir as string, fs); } catch (e) { fail(errCode(e)); return false; }
        const mine = files.filter((f) => `${String(f.year).padStart(4, "0")}-${String(f.month).padStart(2, "0")}` === ym);
        let part = 1;
        if (mine.length > 0) {
            const last = mine[mine.length - 1];
            part = last.size >= L.partMax ? last.part + 1 : last.part;
        }
        fdName = mine.length > 0 && part === mine[mine.length - 1].part ? mine[mine.length - 1].name : partName(ym, part);
        fdMonth = ym;
        const file = path.join(dir as string, fdName);
        try { fd = fs.openSync(file, "a"); } catch (e) { fd = null; fail(errCode(e)); return false; }
        try { fdSize = fs.fstatSync(fd).size; } catch (e) { fail(errCode(e)); return false; }
        if (fdSize > 0) {
            let b: number;
            try { b = lastByte(file, fdSize); } catch (e) { fail(errCode(e)); return false; }
            if (b !== NL) {
                const torn = findTornStart(file, fdSize);
                let n: number;
                try { n = fs.writeSync(fd, Buffer.from("\n")); } catch (e) { fail(errCode(e)); return false; }
                if (n !== 1) { fail("ESHORT"); return false; }
                fdSize += 1;
                S.tornFixed++;
                internalAppend("op", { ref: wref("torn-tail"), data: { offset: torn.offset, length: torn.length }, status: "fixed" });
            }
        }
        return true;
    }
    function ensureFd(): boolean {
        if (fd !== null) {
            if (localMonth(now(), (meta as LedgerMeta).tzOffsetMin) === fdMonth && fdSize < L.partMax) return true;
            closeFd();
        }
        return openFd();
    }

    // writing
    function enforceCaps(): void {
        while (queue.length > 0 && (queue.length > L.bufferRows || queueBytes > L.bufferBytes)) {
            let i = queue.findIndex((q) => q.kind === "request-manifest");
            if (i < 0) i = 0;
            const [q] = queue.splice(i, 1);
            queueBytes -= q.buf.length;
            S.dropped++;
            S.droppedByKind[q.kind] = (S.droppedByKind[q.kind] ?? 0) + 1;
            if (!dropPending) dropPending = { count: 0, byKind: {}, firstLseq: q.lseq, lastLseq: q.lseq };
            dropPending.count++;
            dropPending.byKind[q.kind] = (dropPending.byKind[q.kind] ?? 0) + 1;
            dropPending.firstLseq = Math.min(dropPending.firstLseq, q.lseq);
            dropPending.lastLseq = Math.max(dropPending.lastLseq, q.lseq);
        }
    }
    function pump(force = false): void {
        if (force || now() >= retryAt) {
            while (queue.length > 0) {
                if (!ensureFd()) break;
                const q = queue[0];
                let n: number;
                try { n = fs.writeSync(fd as number, q.buf); } catch (e) { fail(errCode(e)); break; }
                if (n !== q.buf.length) {
                    fdSize += Number.isSafeInteger(n) && n > 0 ? n : 0;
                    fail("ESHORT"); // the row stays first in the buffer; the reopen isolates the half line
                    break;
                }
                queue.shift();
                queueBytes -= q.buf.length;
                fdSize += n;
                S.written++;
                if (queue.length === 0 && dropPending) {
                    const d = dropPending;
                    dropPending = null;
                    internalAppend("op", { ref: wref("dropped"), data: d, status: "dropped" });
                }
            }
            if (queue.length === 0 && seqPending) writeSeq();
        }
        enforceCaps();
    }
    /** No disk inside the back-off window: remember, write once the buffer drained (force: close / release). */
    function writeSeq(force = false): void {
        if (!holdLock || !meta || S.lastLseq < 1) return;
        if (!force && now() < retryAt) { seqPending = true; return; }
        seqPending = false;
        const code = atomicWrite(seqPath, { schema: 1, writer, epoch: meta.epoch, lseq: S.lastLseq, at: isoOf(now()) }, fs);
        if (code !== null) countErr(code);
    }
    function buildRow(kind: string, f: LedgerRowFields, lseq: number): Obj {
        return {
            schema: LEDGER_SCHEMA,
            writer,
            epoch: S.epoch,
            lseq,
            id: `${letter}${S.epoch}-${lseq}`,
            kind,
            ref: isObj(f.ref) ? f.ref : {},
            data: f.data !== null && typeof f.data === "object" ? f.data : null,
            author: strOrNull(f.author),
            relayer: strOrNull(f.relayer),
            readers: normReaders(f.readers),
            readersBy: typeof f.readersBy === "string" ? f.readersBy : "n/a",
            occurredAt: strOrNull(f.occurredAt),
            learnedAt: typeof f.learnedAt === "string" ? f.learnedAt : isoOf(now()),
            derivedFrom: Array.isArray(f.derivedFrom) ? f.derivedFrom.filter((x): x is string => typeof x === "string").slice(0, 200) : [],
            supersedes: null,
            status: strOrNull(f.status),
            hash: strOrNull(f.hash),
            size: isObj(f.size) ? f.size : null,
        };
    }
    /** Over-long request manifest: drop data.add from the front, mark truncated. null = cannot fit. */
    function shrink(row: Obj): { row: Obj; json: string } | null {
        const data = row.data;
        if (row.kind !== "request-manifest" || !isObj(data) || !Array.isArray(data.add)) return null;
        const add = data.add as unknown[];
        const empty = { ...row, data: { ...data, add: [], truncated: true } };
        const budget = L.rowMax - (Buffer.byteLength(JSON.stringify(empty), "utf8") + 1);
        if (budget < 0) return null;
        let from = add.length;
        let used = 0;
        while (from > 0) {
            const sz = Buffer.byteLength(JSON.stringify(add[from - 1]) ?? "null", "utf8") + 1;
            if (used + sz > budget) break;
            used += sz;
            from--;
        }
        const nr = { ...row, data: { ...data, add: add.slice(from), truncated: true } };
        const json = JSON.stringify(nr);
        return Buffer.byteLength(json, "utf8") + 1 <= L.rowMax ? { row: nr, json } : null;
    }
    function internalAppend(kind: string, fields: LedgerRowFields): { id: string; lseq: number } | null {
        const f = isObj(fields) ? (fields as LedgerRowFields) : {};
        const lseq = S.lastLseq + 1;
        let row = buildRow(kind, f, lseq);
        let json: string;
        try { json = JSON.stringify(row); } catch { countErr("EBADROW"); return null; }
        if (typeof json !== "string") { countErr("EBADROW"); return null; }
        if (Buffer.byteLength(json, "utf8") + 1 > L.rowMax) {
            const fit = shrink(row);
            if (!fit) {
                S.dropped++;
                S.droppedByKind.oversize = (S.droppedByKind.oversize ?? 0) + 1;
                countErr("EOVERSIZE");
                return null;
            }
            row = fit.row;
            json = fit.json;
        }
        S.lastLseq = lseq;
        const buf = Buffer.from(json + "\n", "utf8");
        queue.push({ lseq, kind, buf });
        queueBytes += buf.length;
        if (++sinceCkpt >= L.seqEvery) { sinceCkpt = 0; writeSeq(); }
        return { id: row.id as string, lseq };
    }
    function emitStart(): void {
        internalAppend("op", {
            ref: wref("writer-start"),
            data: { pid: ownPid, procStart, instance, version, coreVersion: LEDGER_CORE_VERSION, schema: LEDGER_SCHEMA, tzOffsetMin: (meta as LedgerMeta).tzOffsetMin, seqFrom: S.seqFrom, lseqFrom, resume: started },
            status: "start",
        });
        started = true;
        if (pendingTakeover) {
            internalAppend("op", { ref: wref("lock-takeover"), data: pendingTakeover, status: "taken" });
            pendingTakeover = null;
        }
    }

    // step 5: an `off` file keeps the lock and writes nothing; otherwise open this month's file
    function step5(): void {
        lastOffCheck = now();
        if (exists(offPath, fs)) { setState("off", "off-file"); return; }
        setState("on", null);
        openFd();
        emitStart();
        pump();
    }

    function runOpen(): void {
        try {
            if (!step1()) return;
            if (!step2()) return;
            if (!acquire()) return;
            if (!step4()) return;
            step5();
        } catch (e) {
            countErr(errCode(e));
            setState("error", holdLock ? "seq-read" : "lock-io");
        }
    }

    function renew(): void {
        const cur = readJsonImpl(lockPath, fs);
        if (!cur || cur.instance !== instance) {
            // the lock is no longer ours: close the fd, write nothing, stop
            closeFd();
            holdLock = false;
            discardQueue();
            S.lockLost++;
            setState("locked", "lock-lost");
            lastRetry = now();
            return;
        }
        const code = atomicWrite(lockPath, lockBody(), fs);
        if (code !== null) countErr(code);
    }
    function goOff(why: string): void {
        pump();
        internalAppend("op", { ref: wref("off"), data: { why }, status: "off" });
        pump();
        closeFd();
    }
    function checkOff(): void {
        if (writer === "proxy" && !exists(enabledPath, fs)) {
            if (S.state === "on") goOff("not-enabled");
            closeFd();
            writeSeq(true);
            discardQueue();
            releaseLock();
            setState("off", "not-enabled");
            return;
        }
        const off = exists(offPath, fs);
        if (S.state === "on" && off) {
            goOff("off-file");
            setState("off", "off-file");
        } else if (S.state === "off" && S.reason === "off-file" && !off) {
            setState("on", null);
            openFd();
            emitStart();
            pump();
        }
    }

    const api: LedgerWriter = {
        get key() { return key; },
        get meta() { return meta; },
        append(kind, fields) {
            try {
                if (closed || S.state !== "on") {
                    S.skipped[S.state] = (S.skipped[S.state] ?? 0) + 1;
                    return null;
                }
                if (!KINDS.includes(kind)) { countErr("EBADKIND"); return null; }
                const r = internalAppend(kind, fields);
                if (r === null) return null;
                pump();
                return r;
            } catch {
                return null;
            }
        },
        tick() {
            try {
                if (closed) return;
                const t = now();
                if (holdLock && t - lastRenew >= L.renewMs) { lastRenew = t; renew(); }
                if (S.state === "on") {
                    if (t - lastOffCheck >= L.offCheckMs) { lastOffCheck = t; checkOff(); }
                    if (S.state === "on" && queue.length > 0 && now() >= retryAt) pump();
                } else if (S.state === "off") {
                    if (t - lastOffCheck >= L.offCheckMs) {
                        lastOffCheck = t;
                        if (S.reason === "off-file") checkOff();
                        // not-enabled, and meta.json / salt unreadable at open time (an AV or backup tool holding
                        // the file): reopen once a minute, same as the core writer
                        else if (S.reason === "not-enabled" || S.reason === "no-meta" || S.reason === "no-salt") runOpen();
                    }
                } else if (S.state === "locked" || S.state === "error" || (S.state === "no-root" && S.reason === "missing")) {
                    // a root that shows up later is picked up within a minute; runOpen's step 1 only stats, never creates it
                    if (t - lastRetry >= L.retryMs) { lastRetry = t; runOpen(); }
                }
            } catch {
                /* never throws */
            }
        },
        flush() {
            try {
                if (!closed && S.state === "on") pump();
            } catch {
                /* never throws */
            }
        },
        state() {
            return {
                state: S.state,
                reason: S.reason,
                epoch: S.epoch,
                lseq: S.lastLseq,
                written: S.written,
                buffered: queue.length,
                bufferedBytes: queueBytes,
                dropped: S.dropped,
                droppedByKind: { ...S.droppedByKind },
                errors: { ...S.errors },
                lastError: S.lastError ? { ...S.lastError } : null,
                tornFixed: S.tornFixed,
                lockTakeovers: S.lockTakeovers,
                lockLost: S.lockLost,
                seqFrom: S.seqFrom,
                file: fdName,
                skipped: { ...S.skipped },
            };
        },
        close(reason) {
            try {
                if (closed) return;
                if (S.state === "on") {
                    pump(true);
                    internalAppend("op", { ref: wref("writer-stop"), data: { reason: cleanReason(reason), written: S.written, dropped: S.dropped }, status: "stop" });
                    pump(true);
                }
                closeFd();
                if (holdLock) {
                    writeSeq(true);
                    releaseLock();
                }
                markLiveClosed();
                discardQueue();
                closed = true;
                setState("off", "closed");
            } catch {
                closed = true;
            }
        },
    };

    if (!letter) {
        setState("error", "lock-io");
        countErr("EBADWRITER");
        return api;
    }
    lastOffCheck = lastRetry = lastRenew = now();
    runOpen();
    return api;
}

// ---------------------------------------------------------------- the proxy's ledger (§8)

/** lane vocabulary (INTERFACES §8.2). */
export type EgressLane = "main" | "loop" | "resend" | "side";

interface ProxyLedger {
    writer: LedgerWriter | null;
    root: string | null;
    why: string;
    instance: string;
    procStart: string | null;
    version: string;
    commit: string;
    timer: ReturnType<typeof setInterval> | undefined;
    prevHashBySid: Map<string, string>;
    counts: { egress: number; resend: number; side: number; usage: number; fishReqSeen: number; fishReqBad: number; internalErrors: number };
}

let ledger: ProxyLedger | undefined;
const PREV_HASH_CAP = 256;
const HEARTBEAT_MS = 60_000;

function freshCounts(): ProxyLedger["counts"] {
    return { egress: 0, resend: 0, side: 0, usage: 0, fishReqSeen: 0, fishReqBad: 0, internalErrors: 0 };
}

/** Open the proxy writer once per process (idempotent). Called after the
 *  listener bound; a no-root/off configuration opens nothing. Never throws. */
export function startFishLedger(opts: { version: string; commit: string; env?: Record<string, string | undefined>; home?: string }): void {
    try {
        if (ledger !== undefined) return;
        const { root, why } = proxyLedgerRoot({ env: opts.env ?? process.env, home: opts.home });
        const instance = randomInstance();
        const L: ProxyLedger = {
            writer: null, root, why, instance, procStart: procStartIso(), version: String(opts.version).slice(0, 64), commit: String(opts.commit).slice(0, 40),
            timer: undefined, prevHashBySid: new Map(), counts: freshCounts(),
        };
        ledger = L;
        if (root === null) return;
        L.writer = openWriter({ root, writer: "proxy", version: L.version, instance });
        writeHeartbeat(L);
        L.timer = setInterval(() => tickFishLedger(), HEARTBEAT_MS);
        L.timer.unref?.();
    } catch {
        /* never throws into startup */
    }
}

function tickFishLedger(): void {
    const L = ledger;
    if (L === undefined || L.writer === null) return;
    try {
        L.writer.tick();
        writeHeartbeat(L);
    } catch {
        L.counts.internalErrors++;
    }
}

/** Heartbeat only while we hold the lock (on, or off by the `off` file);
 *  no-root / not-enabled / bad meta / locked write nothing (INTERFACES §9.4). */
function writeHeartbeat(L: ProxyLedger): void {
    const w = L.writer;
    if (w === null || L.root === null) return;
    const st = w.state();
    if (!(st.state === "on" || (st.state === "off" && st.reason === "off-file"))) return;
    writeJsonAtomic(path.join(L.root, "proxy", "heartbeat.json"), {
        schema: 1, writer: "proxy", pid: process.pid, instance: L.instance, procStart: L.procStart, at: isoOf(Date.now()),
        version: L.version, commit: L.commit, state: st.state, reason: st.reason, root: maskPath(L.root),
        // INTERFACES §9.3 lists "writer" twice (the name and the stats); a JSON
        // object cannot carry both, so the stats ride under writerStats.
        writerStats: { epoch: st.epoch, lseq: st.lseq, written: st.written, buffered: st.buffered, bufferedBytes: st.bufferedBytes, dropped: st.dropped, droppedByKind: st.droppedByKind, errors: st.errors, tornFixed: st.tornFixed, lockTakeovers: st.lockTakeovers, lockLost: st.lockLost, seqFrom: st.seqFrom },
        capabilities: [FISH_REQUEST_CAPABILITY],
        counts: { egress: L.counts.egress, resend: L.counts.resend, side: L.counts.side, usage: L.counts.usage, fishReqSeen: L.counts.fishReqSeen, fishReqBad: L.counts.fishReqBad },
    });
}

/** Close on graceful exit: flush, writer-stop, seq.json, release the lock. */
export function stopFishLedger(reason = "exit"): void {
    const L = ledger;
    if (L === undefined) return;
    try {
        if (L.timer !== undefined) clearInterval(L.timer);
        L.timer = undefined;
        L.writer?.close(reason);
    } catch {
        /* never throws */
    }
}

/** Read the request-id header of one inbound request (validated, counted).
 *  Repeated headers arrive comma-joined/arrays and count as malformed. */
export function fishRequestIdFromHeaders(headers: Record<string, string | string[] | undefined>): string | undefined {
    try {
        const raw = headers["x-bili-plugin-fish-request"];
        if (raw === undefined) return undefined;
        const v = fishRequestIdOf(Array.isArray(raw) ? null : raw);
        const L = ledger;
        if (v === null || v === undefined) {
            if (L !== undefined) L.counts.fishReqBad++;
            return undefined;
        }
        if (L !== undefined) L.counts.fishReqSeen++;
        return v;
    } catch {
        return undefined;
    }
}

function writerOn(L: ProxyLedger | undefined): L is ProxyLedger & { writer: LedgerWriter } {
    return L !== undefined && L.writer !== null && L.writer.state().state === "on" && L.writer.key !== null;
}

const cleanModel = (m: unknown): string | null => (typeof m === "string" && m.length > 0 && m.length <= 200 && /^[\x20-\x7e]+$/.test(m) ? m : null);
const cleanHost = (h: unknown): string | null => (typeof h === "string" && /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(h) ? h.toLowerCase() : null);
const cleanReasonWord = (r: unknown): string | null => (typeof r === "string" && /^[a-z0-9-]{1,40}$/.test(r) ? r : null);
const cleanInt = (n: unknown): number | null => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null);
const cleanCount = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

// fork（多模型，M6）：fishLedger.recordEstimate。开着时 usage provider 行多带一个
// data.est（这份请求的本地估计），给离线拟合加性校准 (b, k, c) 用。关着（缺省）时
// 一个字段都不多，行和上游逐字节一样。由 handle.ts 每份请求按配置现设。
let recordEstimate = false;
export function setFishLedgerRecordEstimate(on: boolean): void {
    recordEstimate = on === true;
}
export function fishLedgerRecordEstimateOn(): boolean {
    return recordEstimate;
}
/** M6 的 est 字段（INTERFACES §4.3 增补）。全是数，没有原文。 */
export interface UsageEstimateFacts {
    /** 和这份读数配对的本地文字估计（k̂ 环用的同一个 lastLocalTextEstimate）。 */
    text?: number | null;
    /** 外发的图片张数。 */
    images?: number | null;
    /** 外发时按图算的 token（本地先验 / 学到的单价）。 */
    imageTokens?: number | null;
    /** 外发时的文字侧估计（消息加线上开销），图片学习用的同一个数。 */
    textSide?: number | null;
    /** 这次结算之前发布着的 k̂（没有 = null）。 */
    k?: number | null;
}
function cleanEstimate(e: UsageEstimateFacts | undefined): Record<string, number | null> | null {
    if (!e || typeof e !== "object") return null;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 10_000) / 10_000 : null);
    return { text: num(e.text), images: num(e.images), imageTokens: num(e.imageTokens), textSide: num(e.textSide), k: num(e.k) };
}

/** Host of an upstream URL ("api.anthropic.com"); null when unparsable. */
export function upstreamHostOf(url: unknown): string | null {
    try {
        return typeof url === "string" ? cleanHost(new URL(url).host) : null;
    } catch {
        return null;
    }
}

/** One egress row right before a model request is sent (INTERFACES §4.3). Never throws. */
export function noteEgress(a: {
    sid?: string;
    captureId?: string;
    round?: number;
    fishReq?: string;
    lane: EgressLane;
    reason?: string | null;
    send?: number;
    model?: string;
    msgs?: number | null;
    samePayload?: boolean | null;
    upstreamHost?: string | null;
    body: string | Uint8Array | undefined | null;
}): void {
    const L = ledger;
    if (!writerOn(L)) return;
    try {
        const body = a.body;
        if (body === undefined || body === null) return;
        const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
        const key = L.writer.key as Buffer;
        const hash = egressHash(key, bytes);
        const sid = typeof a.sid === "string" && a.sid !== "" ? sessionRef(key, a.sid) : null;
        const prevHash = sid !== null ? L.prevHashBySid.get(sid) ?? null : null;
        const lane: EgressLane = a.lane === "loop" || a.lane === "resend" || a.lane === "side" ? a.lane : "main";
        const r = L.writer.append("request-manifest", {
            ref: {
                layer: "egress",
                sid,
                captureId: typeof a.captureId === "string" ? a.captureId : null,
                round: cleanInt(a.round),
                fishReq: lane === "side" ? null : fishRequestIdOf(a.fishReq) ?? null,
            },
            data: {
                lane,
                reason: cleanReasonWord(a.reason),
                send: cleanInt(a.send),
                model: cleanModel(a.model),
                msgs: cleanInt(a.msgs),
                samePayload: typeof a.samePayload === "boolean" ? a.samePayload : null,
                prevHash,
                upstreamHost: cleanHost(a.upstreamHost),
            },
            author: "proxy",
            status: "noted",
            hash,
            size: { bytes: bytes.byteLength },
        });
        if (r === null) return;
        if (sid !== null && hash !== null) {
            L.prevHashBySid.delete(sid);
            L.prevHashBySid.set(sid, hash);
            if (L.prevHashBySid.size > PREV_HASH_CAP) {
                const oldest = L.prevHashBySid.keys().next().value;
                if (oldest !== undefined) L.prevHashBySid.delete(oldest);
            }
        }
        if (lane === "resend") L.counts.resend++;
        else if (lane === "side") L.counts.side++;
        else L.counts.egress++;
    } catch {
        L.counts.internalErrors++;
    }
}

/** One provider-usage row per settled report (INTERFACES §4.3). `total <= 0`
 *  with no output is not recorded. Never throws. */
export function noteUsage(a: {
    sid?: string;
    captureId?: string;
    round?: number;
    fishReq?: string;
    lane: "main" | "loop" | "side";
    model?: string;
    protocol?: string;
    upstreamHost?: string | null;
    total: number;
    cached: number | null;
    creation: number | null;
    output: number | null | undefined;
    fold?: unknown;
    seam?: unknown;
    /** fork（M6）：只在 recordEstimate 开着时写进 data.est。 */
    est?: UsageEstimateFacts;
}): void {
    const L = ledger;
    if (!writerOn(L)) return;
    try {
        const total = cleanCount(a.total) ?? 0;
        const output = cleanCount(a.output);
        if (total <= 0 && !(output !== null && output > 0)) return;
        const cached = cleanCount(a.cached);
        const creation = cleanCount(a.creation);
        const key = L.writer.key as Buffer;
        const sid = typeof a.sid === "string" && a.sid !== "" ? sessionRef(key, a.sid) : null;
        const lane = a.lane === "loop" || a.lane === "side" ? a.lane : "main";
        const host = cleanHost(a.upstreamHost);
        const protocol = typeof a.protocol === "string" && /^[a-z0-9-]{1,20}$/.test(a.protocol) ? a.protocol : null;
        const r = L.writer.append("usage", {
            ref: {
                layer: "provider",
                sid,
                captureId: typeof a.captureId === "string" ? a.captureId : null,
                round: cleanInt(a.round),
                fishReq: lane === "side" ? null : fishRequestIdOf(a.fishReq) ?? null,
            },
            data: {
                lane,
                model: cleanModel(a.model),
                protocol,
                upstreamHost: host,
                provider: providerOf({ upstreamHost: host, protocol }),
                total,
                cached,
                creation,
                uncached: total - (cached ?? 0) - (creation ?? 0),
                output,
                hitPct: cached !== null && total > 0 ? Math.round((cached / total) * 10_000) / 10_000 : null,
                fold: typeof a.fold === "number" && Number.isFinite(a.fold) ? a.fold : null,
                seam: typeof a.seam === "number" && Number.isFinite(a.seam) ? a.seam : null,
                ...(recordEstimate && a.est !== undefined ? { est: cleanEstimate(a.est) } : {}),
            },
            author: "provider",
            relayer: "proxy",
            status: "settled",
        });
        if (r !== null) L.counts.usage++;
    } catch {
        L.counts.internalErrors++;
    }
}

interface FishLedgerHealth {
    v: 1;
    state: string;
    reason: string | null;
    root: string | null;
    written: number;
    buffered: number;
    dropped: number;
    errors: Record<string, number>;
    egress: number;
    resend: number;
    side: number;
    usage: number;
    fishReqSeen: number;
    fishReqBad: number;
    capabilities: string[];
}

/** `/__bili/health` → `fishLedger` (INTERFACES §10.3). No key, no absolute path. */
export function fishLedgerHealth(): FishLedgerHealth {
    const L = ledger;
    const base = { v: 1 as const, capabilities: [FISH_REQUEST_CAPABILITY] };
    try {
        if (L === undefined) {
            return { ...base, state: "starting", reason: null, root: null, written: 0, buffered: 0, dropped: 0, errors: {}, egress: 0, resend: 0, side: 0, usage: 0, fishReqSeen: 0, fishReqBad: 0 };
        }
        const c = L.counts;
        const counts = { egress: c.egress, resend: c.resend, side: c.side, usage: c.usage, fishReqSeen: c.fishReqSeen, fishReqBad: c.fishReqBad };
        if (L.writer === null) {
            return { ...base, state: "no-root", reason: L.why === "live" || L.why === "env" ? null : L.why, root: null, written: 0, buffered: 0, dropped: 0, errors: {}, ...counts };
        }
        const st = L.writer.state();
        return { ...base, state: st.state, reason: st.reason, root: st.state === "no-root" ? null : maskPath(L.root), written: st.written, buffered: st.buffered, dropped: st.dropped, errors: st.errors, ...counts };
    } catch {
        return { ...base, state: "error", reason: null, root: null, written: 0, buffered: 0, dropped: 0, errors: {}, egress: 0, resend: 0, side: 0, usage: 0, fishReqSeen: 0, fishReqBad: 0 };
    }
}

/** Test hooks: run one maintenance tick now / forget the process singleton. */
export function _tickFishLedgerForTest(): void {
    tickFishLedger();
}
export function _resetFishLedgerForTest(): void {
    stopFishLedger("test-reset");
    ledger = undefined;
}
