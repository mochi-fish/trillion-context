// fish-ledger P0 (F11): the model-request inventory. Every fetch-family call
// site under src/ is classified here: either it sends a model request from the
// proxy and is RECORDED (an egress note sits on its path — INTERFACES §8.2), or
// it is listed with the reason it is not proxy model egress, or it is a KNOWN
// GAP named on purpose. A new call site, or a changed count in a listed file,
// fails this test until someone classifies it — adding a model request without
// an egress row cannot slip in silently.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "..", "src");
const CALL_RE = /(?<![A-Za-z0-9_.$])(fetch|fetchWithTimeout|fetchWithRetry|fetchWithTransportRetry)\s*\(/g;
const NOTE_RE = /\b(?:noteFishEgress|fishEgress)\(/g;

/** Proxy model requests with an egress note on their path (lane / reason in the comment). */
const RECORDED: Record<string, { calls: number; why: string }> = {
    "server/relay.ts": { calls: 8, why: "main (first send) + resend: ws-1009-shrink, role-compat, pck-probe, thinking-strip (fork M7, off by default), image-shed, refold, fake-done-retry" },
    "loop/core.ts": { calls: 1, why: "loop: compress-loop rounds" },
    "compress-loop-responses.ts": { calls: 1, why: "loop: Responses compress-loop rounds" },
    "degenerate-retry.ts": { calls: 1, why: "resend: degenerate-retry" },
    "reasoning-guard.ts": { calls: 1, why: "resend: reasoning-guard continuation round" },
    "server.ts": { calls: 1, why: "side: nudge-decide" },
    "preflight.ts": { calls: 1, why: "side: preflight-summary" },
    "server/threads-lane.ts": { calls: 1, why: "side: threads-summary" },
    "external-summary-http.ts": { calls: 1, why: "side: external-summary" },
    "cache-keepalive.ts": { calls: 1, why: "side: cache-keepalive ping" },
};

/** Model traffic the proxy sends WITHOUT an egress row — named gaps. */
const KNOWN_GAP: Record<string, { calls: number; why: string }> = {
    "responses-ws.ts": { calls: 2, why: "Responses-over-WebSocket transport (egressHttp fallback; the other match is the transport's own `async fetch(` method). Its frames re-serialize the body, so the relay's main egress row does not equal these bytes. DSH's Anthropic lane never uses it." },
};

/** Not proxy model egress. */
const NOT_MODEL: Record<string, { calls: number; why: string }> = {
    "fetch-util.ts": { calls: 3, why: "the fetch helpers themselves (callers are classified)" },
    "advisory.ts": { calls: 2, why: "advisory feed" },
    "agent/dsh-native-client.ts": { calls: 4, why: "host-side client → local proxy" },
    "agent/dsh-native.ts": { calls: 2, why: "host-side client → local proxy" },
    "agent/opencode-acp-command.ts": { calls: 1, why: "host-side client → local proxy" },
    "agent/pi.ts": { calls: 3, why: "host-side client → local proxy" },
    "agent/shared.ts": { calls: 2, why: "host-side client → local proxy (manifest, status, tools)" },
    "claude-mcp-entry.ts": { calls: 1, why: "MCP shim → local proxy" },
    "cli.ts": { calls: 1, why: "CLI → local proxy" },
    "kimi/native.ts": { calls: 1, why: "host-side client → local proxy" },
    "launcher.ts": { calls: 7, why: "launcher health / shutdown probes" },
    "liveness.ts": { calls: 1, why: "liveness probe" },
    "mcp.ts": { calls: 4, why: "MCP shim → local proxy" },
    "plugin-install.ts": { calls: 1, why: "plugin installer" },
    "plugin.ts": { calls: 1, why: "not a call: the word inside a log string" },
    "port-owner.ts": { calls: 1, why: "port owner probe" },
    "remote-notices.ts": { calls: 1, why: "remote notices feed" },
    "server/admin.ts": { calls: 1, why: "/__bili/upstream/test HEAD reachability probe (no body)" },
    "storage/engine-bootstrap.ts": { calls: 1, why: "storage engine download" },
    "update-notes.ts": { calls: 1, why: "release notes" },
    "update-policy.ts": { calls: 2, why: "update policy" },
    "update.ts": { calls: 1, why: "self-update" },
    "web/blog-refresh.ts": { calls: 5, why: "blog feed" },
    "web/changelog.ts": { calls: 1, why: "changelog feed" },
    "web/client.ts": { calls: 3, why: "browser panel → local proxy" },
    "zcode/native.ts": { calls: 1, why: "host-side client → local proxy" },
};

function scan(): Map<string, { calls: number; notes: number }> {
    const out = new Map<string, { calls: number; notes: number }>();
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!p.endsWith(".ts")) continue;
            let calls = 0;
            let notes = 0;
            for (const line of readFileSync(p, "utf8").split("\n")) {
                const t = line.trim();
                if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
                CALL_RE.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = CALL_RE.exec(line)) !== null) {
                    if (/function\s*\*?\s*$/.test(line.slice(0, m.index))) continue;
                    calls++;
                }
                NOTE_RE.lastIndex = 0;
                while (NOTE_RE.exec(line) !== null) notes++;
            }
            if (calls > 0) out.set(path.relative(SRC, p).split(path.sep).join("/"), { calls, notes });
        }
    };
    walk(SRC);
    return out;
}

test("every fetch-family call site in src/ is classified (recorded / known gap / not model egress)", () => {
    const found = scan();
    const tables = { ...RECORDED, ...KNOWN_GAP, ...NOT_MODEL };
    const unlisted = [...found.keys()].filter((f) => !(f in tables));
    assert.deepEqual(unlisted, [], `unclassified call sites — add each to RECORDED (with an egress note) or to a named list: ${unlisted.map((f) => `${f}×${found.get(f)!.calls}`).join(", ")}`);
    for (const [file, spec] of Object.entries(tables)) {
        const got = found.get(file);
        assert.ok(got, `${file} is listed but has no call sites any more — update the inventory`);
        assert.equal(got.calls, spec.calls, `${file}: call-site count changed (${spec.why}) — reclassify`);
    }
});

test("every recorded proxy model-request site carries an egress note", () => {
    const found = scan();
    for (const [file, spec] of Object.entries(RECORDED)) {
        const got = found.get(file);
        assert.ok(got);
        assert.ok(got.notes >= spec.calls, `${file}: ${got.calls} model-request call(s) but only ${got.notes} egress note(s) (${spec.why})`);
    }
});
