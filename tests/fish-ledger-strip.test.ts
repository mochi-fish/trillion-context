// fish-ledger P0 (F1): the request-id header is loopback-only bookkeeping —
// the proxy must strip it at egress exactly like the #5658 turn id, on every
// lane, while everything else about the outbound request stays as it was.

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { UPSTREAM_HOP_HEADERS } from "../src/server/headers.ts";
import { closeServers } from "./server-close-guard.ts";
import { anthropicTurn, bringUpProxy, postAnthropic } from "./fish-ledger-harness.ts";

const HEADER = "x-bili-plugin-fish-request";
const RID = "fq-abc-def-7";

test("the fish request header is in the egress strip table", () => {
    assert.ok(UPSTREAM_HOP_HEADERS.has(HEADER));
});

test("a tagged anthropic turn reaches the fake upstream without the fish header", async () => {
    const h = await bringUpProxy("strip-anth");
    try {
        const tagged = await postAnthropic(h, "strip-sess-a", anthropicTurn("fictional question one"), { [HEADER]: RID, "x-bili-plugin-probe": "kept" });
        assert.equal(tagged.status, 200, tagged.text.slice(0, 400));
        const untagged = await postAnthropic(h, "strip-sess-b", anthropicTurn("fictional question one"));
        assert.equal(untagged.status, 200);
        assert.ok(h.hits.length >= 2, "both turns reached the upstream");
        for (const hit of h.hits) assert.ok(!hit.headerKeys.includes(HEADER), `${HEADER} leaked to the model endpoint`);
        // Unrelated headers ride exactly as before (only the new name is stripped).
        assert.equal(h.hits[0].headers["x-bili-plugin-probe"], "kept");
        // Same request shape with and without the tag: identical header-name set.
        const names = (i: number): string[] => h.hits[i].headerKeys.filter((k) => k !== "x-bili-plugin-probe" && k !== "content-length").sort();
        assert.deepEqual(names(0), names(1));
    } finally {
        h.store.cancelAll();
        await closeServers([h.proxy, h.upstream], "fish strip");
        rmSync(h.root, { recursive: true, force: true });
    }
});

test("a malformed or repeated fish header is stripped too", async () => {
    const h = await bringUpProxy("strip-bad");
    try {
        for (const value of ["not a rid", "fq-x-y-0", `${RID}, ${RID}`]) {
            const r = await postAnthropic(h, `strip-bad-${value.length}`, anthropicTurn("fictional question two"), { [HEADER]: value });
            assert.equal(r.status, 200);
        }
        for (const hit of h.hits) assert.ok(!hit.headerKeys.includes(HEADER));
    } finally {
        h.store.cancelAll();
        await closeServers([h.proxy, h.upstream], "fish strip bad");
        rmSync(h.root, { recursive: true, force: true });
    }
});
