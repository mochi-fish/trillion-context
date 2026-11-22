// Fish field shape (2026-11-14, DSH 0.2.2-rc.x, plugin lane "dsh"): the host
// switched the model mid-session (deepseek-flash → claude-*). On the new
// provider the host stops replaying the OTHER model's thinking blocks
// (pi-ai transformMessages drops foreign thinking), in-history system updates
// are re-projected, and a few dozen whole tool turns no longer ride the wire.
// Field numbers: 27,833 covered ids, 20,303 still verbatim on the wire,
// 7,160 of the 7,530 missing were reasoning cores; the per-request runtime
// context carrier at inbound[1] changes on every pass, so the head-truncation
// explainer never holds. Under 0.1.213 every steady pass read as total drift
// (claims==0) and the third one latched foldEpochConfirmPending, which then
// stayed set for 192 consecutive passes (compression paused) although the
// fold substrate was alive. #5715 (upstream PR #5737) gates the terminal
// verdict on a surviving direct-ID majority; these tests pin that the port
// covers this exact shape, including a latch persisted by the older build.
// Since the review (2026-11-15) the port is opt-in — compress.epochMajorityGuard
// (passed to reconcile as majorityGuard) — so an unconfigured build keeps the
// 0.1.213 verdict byte for byte; the last describe pins both sides.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { simhashHex } from "../src/affinity-simhash.ts";
import {
    normalizedIdentity,
    canonicalTextOf,
    reconcileFoldCoverage,
    wordBagDigest,
    type FoldAnchor,
} from "../src/fold-reconcile.ts";
import { epochConfirmPending, epochMajorityGuardOn, METADATA_DRIFT_ESCALATED } from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

function msg(id: string, role: string, text: string, extra?: Partial<CoreMessage>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}
function anchorOf(m: CoreMessage): FoldAnchor {
    const a: FoldAnchor = { n: normalizedIdentity(m), r: m.role, c: m.contentType, b: m.text?.length ?? 0 };
    if (m.toolCallId) a.t = m.toolCallId;
    if (m.text && m.text !== "" && m.contentType !== "reasoning") {
        a.sh = simhashHex(canonicalTextOf(m.text));
        a.wh = wordBagDigest(canonicalTextOf(m.text));
    }
    return a;
}
const repair = () => ({ mode: "repair" as const, inboundMessageCount: 200, majorityGuard: true });
/** the same pass without the opt-in switch: the 0.1.213 verdict */
const repairOff = () => ({ mode: "repair" as const, inboundMessageCount: 200 });

/** 40 hard turns (user/assistant text) with a reasoning core before every
 *  assistant turn, all covered by one fold; a runtime-context carrier sits at
 *  inbound[1] and is NOT covered (it is re-minted on every request). */
function fixture() {
    const hard: CoreMessage[] = [];
    const reasoning: CoreMessage[] = [];
    const history: CoreMessage[] = [];
    for (let i = 0; i < 40; i++) {
        const role = i % 2 ? "assistant" : "user";
        if (role === "assistant") {
            const r = msg(`q${i}`, "assistant", `deepseek thinking core ${i} omega vocabulary ${i}`, { contentType: "reasoning" });
            reasoning.push(r);
            history.push(r);
        }
        const h = msg(`t${i}`, role, `history turn ${i} with distinctive vocabulary marker word ${i} for shingle coverage`);
        hard.push(h);
        history.push(h);
    }
    const covered = history.map((m) => m.id as string);
    const carrier = (k: number) => msg(`rc${k}`, "user", `Current runtime context snapshot ${k}`);
    const lead = msg("lead", "user", "wake");
    const preSwitch = [lead, carrier(0), ...history, msg("tail0", "user", "latest question before the switch")];
    return { hard, reasoning, history, covered, carrier, lead, preSwitch };
}
function sessionFor(covered: string[], preSwitch: CoreMessage[]): Session {
    const anchors: Record<string, FoldAnchor> = {};
    for (const m of preSwitch) if (covered.includes(m.id as string)) anchors[m.id as string] = anchorOf(m);
    return {
        id: "s-fish-switch",
        metadata: { foldAnchors: anchors, foldAnchorOrder: preSwitch.map((m) => m.id as string), pluginAgent: "dsh" },
        state: {
            blocks: [{ active: true, blockId: "blk-1", effectiveMessageIds: [...covered], directMessageIds: [...covered] }],
            messageRefs: { byRaw: {}, byRef: {} },
        },
    } as unknown as Session;
}
/** The post-switch wire of pass k: no reasoning at all, `vanished` hard turns
 *  gone, a fresh carrier, and the new turns appended so far. */
function postSwitchWire(f: ReturnType<typeof fixture>, vanished: Set<number>, k: number): CoreMessage[] {
    const fresh: CoreMessage[] = [];
    for (let j = 1; j <= k; j++) {
        fresh.push(msg(`nu${j}`, "user", `new user turn ${j} after the switch`));
        fresh.push(msg(`na${j}`, "assistant", `new assistant turn ${j} after the switch`));
    }
    return [f.lead, f.carrier(k), ...f.hard.filter((_, i) => !vanished.has(i)), msg("tail0", "user", "latest question before the switch"), ...fresh];
}
// twelve INTERIOR hard turns vanish (>= FOLD_DRIFT_ESCALATE_MIN_UNMATCHED)
const VANISHED = new Set([5, 7, 9, 11, 13, 15, 21, 23, 25, 27, 29, 31]);

describe("fish model switch: dropped foreign thinking + a few vanished turns is not an epoch", () => {
    test("precondition: the shape really is total drift for the classifier (claims 0, no explainer)", () => {
        const f = fixture();
        const session = sessionFor(f.covered, f.preSwitch);
        for (let k = 1; k <= 4; k++) reconcileFoldCoverage(session, postSwitchWire(f, VANISHED, k), repair());
        assert.ok((session.metadata["foldDriftStreak"] as number ?? 0) >= 3,
            "the drift streak accrues: the head carrier churns every pass, so no truncation explainer applies");
    });

    test("no epoch-confirm latch while the hard majority rides verbatim", () => {
        const f = fixture();
        const session = sessionFor(f.covered, f.preSwitch);
        for (let k = 1; k <= 6; k++) reconcileFoldCoverage(session, postSwitchWire(f, VANISHED, k), repair());
        assert.equal(epochConfirmPending(session), false, "28 of 40 hard ids present verbatim: the substrate is alive");
        assert.notEqual(session.metadata[METADATA_DRIFT_ESCALATED], true);
        const blocks = (session.state as { blocks: Array<{ blockId?: string }> }).blocks;
        assert.ok(blocks.some((b) => b.blockId === "blk-1"), "the fold is retained");
    });

    test("a latch persisted by 0.1.213 (streak 192, escalated, frozen witness) clears on the first pass and stays clear", () => {
        const f = fixture();
        const session = sessionFor(f.covered, f.preSwitch);
        const md = session.metadata as Record<string, unknown>;
        md["foldEpochConfirmPending"] = true;
        md["foldDriftEscalated"] = true;
        md["foldDriftStreak"] = 192;
        md["foldDriftSince"] = Date.now() - 86_400_000;
        md["foldShapeChurnNoted"] = true;
        md["foldEpisodeOrder"] = postSwitchWire(f, VANISHED, 0).map((m) => m.id as string);
        assert.equal(epochConfirmPending(session), true, "precondition: latched");
        const logs: string[] = [];
        reconcileFoldCoverage(session, postSwitchWire(f, VANISHED, 1), { ...repair(), log: (l: string, m: string) => logs.push(`${l}: ${m}`) });
        assert.equal(epochConfirmPending(session), false, "the first pass under the new build releases the paused compression");
        for (let k = 2; k <= 6; k++) reconcileFoldCoverage(session, postSwitchWire(f, VANISHED, k), { ...repair(), log: (l: string, m: string) => logs.push(`${l}: ${m}`) });
        assert.equal(epochConfirmPending(session), false, "and it does not come back on later steady passes");
        assert.ok(!logs.some((l) => l.includes("fold epoch confirmation required")), "no new epoch verdict");
        assert.ok(logs.some((l) => l.startsWith("info") && l.includes("partial interior loss")), "the #5715 note names the residue once");
    });

    test("switch off (default): the 0.1.213 verdict — the same shape latches, and a persisted latch stays", () => {
        assert.equal(epochMajorityGuardOn(undefined), false);
        assert.equal(epochMajorityGuardOn({ epochMajorityGuard: "true" }), false, "only a real true");
        assert.equal(epochMajorityGuardOn({ epochMajorityGuard: true }), true);
        const f = fixture();
        const session = sessionFor(f.covered, f.preSwitch);
        for (let k = 1; k <= 6; k++) reconcileFoldCoverage(session, postSwitchWire(f, VANISHED, k), repairOff());
        assert.equal(epochConfirmPending(session), true, "without the switch the old build latches (what the field saw)");
        const g = fixture();
        const latched = sessionFor(g.covered, g.preSwitch);
        const md = latched.metadata as Record<string, unknown>;
        md["foldEpochConfirmPending"] = true;
        md["foldDriftEscalated"] = true;
        md["foldDriftStreak"] = 192;
        md["foldEpisodeOrder"] = postSwitchWire(g, VANISHED, 0).map((m) => m.id as string);
        const logs: string[] = [];
        reconcileFoldCoverage(latched, postSwitchWire(g, VANISHED, 1), { ...repairOff(), log: (l: string, m: string) => logs.push(`${l}: ${m}`) });
        assert.equal(epochConfirmPending(latched), true, "without the switch a persisted latch is not cleared by the majority");
        assert.ok(!logs.some((l) => l.includes("partial interior loss")), "no #5715 note without the switch");
    });

    test("teeth: when the hard turns are gone too, the epoch verdict still fires", () => {
        const f = fixture();
        const session = sessionFor(f.covered, f.preSwitch);
        const mostlyGone = new Set(Array.from({ length: 40 }, (_, i) => i).filter((i) => i % 8 !== 0)); // 5 of 40 survive
        for (let k = 1; k <= 4; k++) reconcileFoldCoverage(session, postSwitchWire(f, mostlyGone, k), repair());
        assert.equal(epochConfirmPending(session), true, "a real collapse of the hard substrate still asks for confirmation");
    });
});
