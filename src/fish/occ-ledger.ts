/**
 * fork（日期，D4）：A 档的旁路表 —— 以后往前记「这条消息真正发生在什么时候」。
 *
 * 开关 `fish.dateNotes.recordOccurrence`，缺省关。**关着时这里一个字节都不写、一个键都不加**
 * （session_ext 不会多出 `fish:occ:*`，E0-wire 核这个）。开着时：
 *  - 上游回复结算的那一刻（settleUsageReport）记「这个会话上一段回复的结束时刻」，只在内存里；
 *  - 下一次请求、内核盖完章以后（prepare-* 里 `session.state = turn.state` 之前），找这一次新盖章的 id：
 *      非 assistant 记它自己的章（= 第一次看到的时刻）；
 *      排在这一批最前面的 assistant（上一段回复）记上一段回复的结束时刻（没有、或比上一次请求还早 / 比现在晚就不记）。
 *    这一批新盖章的 id 有 17 条以上、或者 assistant 不在最前面（重铸潮、换模型重铸），整批一条都不记。
 *  - 写进 `session_ext` 的 `fish:occ:YYYYMM`（当地月，按 tzOffsetMin），值 `{ v:1, m:{ <msgId>: 毫秒 } }`；
 *    已经记过的 id 不覆盖（第一次为准）。写失败只少 A 档，不影响请求。
 * 不碰内核的 tsStamps、不碰 `<acp time=…>`、不改任何发出去的字节。读的那一半在 occurrence.ts。
 */

import type { CompressionState, CoreMessage } from "acp-kernel";
import { OCC_EXT_PREFIX } from "./occurrence.js";

interface OccExtStore {
    getSessionExt(sessionId: string, key: string): unknown;
    setSessionExt(sessionId: string, key: string, value: unknown): void;
}

const MAX_NEW_PER_TURN = 16; // ≥ 17 = 重铸潮（和 B 档同一个界）
const MAX_REPLY_LAG_MS = 6 * 60 * 60 * 1000;
/** 她说话的工具调用（和 date-notes.ts 的 SPEECH_CALLS、corpus 的 CALL_TEXT 同一张表里的这三个）。 */
const SPEECH_TOOLS = new Set(["im_send", "her_note", "her_leave"]);

/**
 * G2 复核 F2：只记注记用得上的那几条 —— user / assistant 的正文、她用 im_send / her_note / her_leave 说的话。
 * 工具回执、别的工具调用、思考不记（注记不标它们）：月份键小一个量级，每次请求整份重写的代价跟着小。
 * 重铸潮、「assistant 不在最前面」照旧按这一批**全部**新盖章的消息判。
 */
function worthRecording(m: CoreMessage): boolean {
    if (m.contentType === "text") return m.role === "user" || m.role === "assistant";
    return m.role === "assistant" && m.contentType === "tool-call" && typeof m.toolName === "string" && SPEECH_TOOLS.has(m.toolName);
}

/** 计数（health 的 dateNotes.occ）：写了几条、几次请求整批没记、写失败几次（失败只少 A 档，不影响请求）。 */
const counters = { turns: 0, recorded: 0, skippedWave: 0, skippedOrder: 0, notRecordedKinds: 0, writeFailed: 0, lastFailure: null as string | null, largestShardBytes: 0 };
export function occLedgerTotals(): Record<string, unknown> {
    return { ...counters };
}

const lastResponseEnd = new Map<string, number>();
const lastRequestAt = new Map<string, number>();

/** 回复结算的那一刻（调用方只在开关开着时调）。 */
export function noteOccResponseEnd(sessionId: string, now: number): void {
    lastResponseEnd.set(sessionId, now);
}

/** 当地月份键 YYYYMM（固定偏移，不看进程时区）。 */
export function occMonthKey(ms: number, tzOffsetMin: number): string {
    const d = new Date(ms + tzOffsetMin * 60000);
    return `${OCC_EXT_PREFIX}${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 这一次请求新盖章的消息 → A 档记录。prev / next 是内核这一轮前后的 state；messages 是这一轮交给内核的消息
 * （带 id、role）。回写了几条（测试看）。调用方只在开关开着时调。
 */
export function recordOccurrences(
    sessionId: string,
    prev: CompressionState,
    next: CompressionState,
    messages: readonly CoreMessage[],
    store: OccExtStore,
    tzOffsetMin: number,
    now: number,
): number {
    const before = prev.tsStamps ?? {};
    const after = next.tsStamps ?? {};
    const fresh: Array<{ id: string; asst: boolean; ts: number; keep: boolean }> = [];
    const seen = new Set<string>();
    for (const m of messages) {
        if (!m.id || seen.has(m.id)) continue;
        seen.add(m.id);
        if (before[m.id] !== undefined) continue;
        const ts = after[m.id];
        if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
        fresh.push({ id: m.id, asst: m.role === "assistant", ts, keep: worthRecording(m) });
    }
    const reqPrev = lastRequestAt.get(sessionId);
    lastRequestAt.set(sessionId, now);
    if (fresh.length === 0) return 0;
    counters.turns++;
    if (fresh.length > MAX_NEW_PER_TURN) { counters.skippedWave++; return 0; }
    let seenOther = false;
    for (const f of fresh) {
        if (!f.asst) seenOther = true;
        else if (seenOther) { counters.skippedOrder++; return 0; } // assistant 不在最前面：不是一次正常的请求
    }
    const end = lastResponseEnd.get(sessionId);
    const replyAt = end !== undefined && end <= now && now - end <= MAX_REPLY_LAG_MS && (reqPrev === undefined || end >= reqPrev) ? end : undefined;
    const byKey = new Map<string, Record<string, number>>();
    for (const f of fresh) {
        if (!f.keep) { counters.notRecordedKinds++; continue; }
        const at = f.asst ? replyAt : f.ts;
        if (at === undefined) continue;
        const key = occMonthKey(at, tzOffsetMin);
        let m = byKey.get(key);
        if (!m) { m = {}; byKey.set(key, m); }
        m[f.id] = at;
    }
    let wrote = 0;
    for (const [key, add] of byKey) {
        try {
            const cur = store.getSessionExt(sessionId, key);
            let parsed: unknown = cur;
            if (typeof cur === "string") {
                try { parsed = JSON.parse(cur); } catch { parsed = null; }
            }
            const old = parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === 1 && (parsed as { m?: unknown }).m && typeof (parsed as { m?: unknown }).m === "object" ? { ...((parsed as { m: Record<string, number> }).m) } : {};
            let n = 0;
            for (const [id, at] of Object.entries(add)) {
                if (old[id] !== undefined) continue;
                old[id] = at;
                n++;
            }
            if (n > 0) {
                const value = { v: 1, m: old };
                store.setSessionExt(sessionId, key, value);
                wrote += n;
                const bytes = JSON.stringify(value).length;
                if (bytes > counters.largestShardBytes) counters.largestShardBytes = bytes;
            }
        } catch (e) {
            // 写失败只少 A 档；记个数（health 看得到），不打断请求
            counters.writeFailed++;
            counters.lastFailure = String((e as Error)?.message ?? e).slice(0, 120);
        }
    }
    counters.recorded += wrote;
    return wrote;
}

/** 测试用。 */
export function _resetOccLedgerForTest(): void {
    lastResponseEnd.clear();
    lastRequestAt.clear();
    Object.assign(counters, { turns: 0, recorded: 0, skippedWave: 0, skippedOrder: 0, notRecordedKinds: 0, writeFailed: 0, lastFailure: null, largestShardBytes: 0 });
}
