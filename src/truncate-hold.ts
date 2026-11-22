// fork（养成向）：紧急截断只认落了账的真用量。
//
// 一份请求被掐断、用量没落账时，下一份请求判大小用的是本地估计（effectiveTokenCount
// 的 "estimate"，#4383 的 cycle-stale 那条路）。估计值常是真用量的 1.5–1.9 倍：
// 陪伴会话设了 256k 上限以后，一次掐断就够把估计值推过 95%，内核的
// emergency-truncate 当场剪掉几条最长的旧消息、锁住，直到她下一次压成功。
// 催压那边早有「估计值先等一轮」（nudge.requireUsageSampleForPressure），截断没有。
//
// 开关 compress.requireUsageSampleForTruncate（三级 + compress.sessions.<id>）落在
// 内核的 truncate.requireUsageSample 上，判断在内核里（emergency-truncate 节点：估计值
// 不剪新的、照旧重放已经锁住的）。这里只做两件旁观的事：认出「这一次本来会剪、因为
// 是估计值没剪」，在会话 metadata 里记一个数、日志里打一行，好让人事后核对。
// 开关不开时这里什么都不做。不 import session.ts（结构类型），免得成环。

/** 会话 metadata 里记数的键（和别的 metadata 一起落盘）。 */
export const TRUNCATE_HOLD_METADATA_KEY = "truncateHeldForUsage";

interface TruncateHoldCounts {
    /** 开关开着、读数是估计值、而且到了截断线（所以这一次没剪新的）的次数。 */
    held: number;
    /** 最后一次的时间（ISO）和那一次的读数、窗口。 */
    lastAt?: string;
    lastTokens?: number;
    lastLimit?: number;
}

/** True when this turn's kernel pass held emergency truncation because the
 *  reading was an estimate: the switch is on (resolved kernel config carries
 *  truncate.requireUsageSample === true), the source is "estimate", and the
 *  reading is at/above the truncate threshold. Observability only — the
 *  decision itself is the kernel's. */
export function truncateHeldThisTurn(config: unknown, tokenCount: number, source: "usage" | "estimate" | undefined): boolean {
    const c = config as { modelContextLimit?: unknown; truncate?: { threshold?: unknown; requireUsageSample?: unknown } } | undefined;
    if (c?.truncate?.requireUsageSample !== true || source !== "estimate") return false;
    const limit = typeof c.modelContextLimit === "number" ? c.modelContextLimit : 0;
    const threshold = typeof c.truncate.threshold === "number" ? c.truncate.threshold : 0;
    return limit > 0 && threshold > 0 && Number.isFinite(tokenCount) && tokenCount / limit >= threshold;
}

/** Record one held truncation on the session and return the running count. */
export function noteTruncateHeld(session: { metadata?: Record<string, unknown> }, tokenCount: number, limit: number): number {
    const meta = session.metadata ?? (session.metadata = {});
    const raw = meta[TRUNCATE_HOLD_METADATA_KEY];
    const prev = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).held : 0;
    const next: TruncateHoldCounts = {
        held: (typeof prev === "number" && Number.isFinite(prev) && prev >= 0 ? Math.floor(prev) : 0) + 1,
        lastAt: new Date().toISOString(),
        lastTokens: tokenCount,
        lastLimit: limit,
    };
    meta[TRUNCATE_HOLD_METADATA_KEY] = next;
    return next.held;
}

/** The one log line a held truncation writes (same wording on every lane). */
export function truncateHeldLine(sessionId: string, tokenCount: number, limit: number, held: number): string {
    const pct = limit > 0 ? Math.round((tokenCount / limit) * 100) : 0;
    return `[${sessionId}] [truncate-hold] emergency truncation held: ${tokenCount}/${limit} (${pct}%) is a local estimate, not a billed usage report (requireUsageSampleForTruncate) — latched clips replay, new cuts wait for the next real usage (held ${held}x on this session)`;
}
