// fork（养成向）：「不代写」开关。
//
// 陪伴会话里，摘要就是她以后的记忆：作者必须是她自己。上游代理在上下文越线
// 时有几条路会替模型写摘要——preflight 代写（拿模型、外部摘要服务或确定性
// 摘要折一段，也包括分层合并 #2952）、externalSummary 模式下替她的 compress
// 补写摘要、autoFold 增长折叠。开关开着时这几条路一律不走：越线只催她自己
// 压（催压提醒照常发），每次「本来要代写」的地方在会话 metadata 里记一个数，
// 好让人事后核对。
//
// 开关来自请求的 Config 轨（compress.noGhostwrite 三级合并，或
// compress.sessions.<id>.noGhostwrite 按会话覆盖，见 compress-settings.ts），
// 和 externalSummary 走同一条轨：handle.ts 解出来、storeEffectiveConfig 存到
// 会话上，插件工具那条路读 effectiveConfig 时也看得到。默认不写 = 和上游一样。
//
// 这个模块不 import session.ts（结构类型），免得成环。

type GhostwritePath = "preflight" | "externalSummary" | "autoFold";

interface NoGhostwriteCounts {
    /** preflight 本来要替她折（模型摘要 / 外部摘要 / 确定性摘要 / 分层合并）的次数。 */
    preflight: number;
    /** externalSummary 模式本来要替她的 compress 写摘要的次数。 */
    externalSummary: number;
    /** autoFold 增长折叠本来要触发的次数。 */
    autoFold: number;
    /** 越过配置的窗口、载荷放得进真实窗口但加上这次的输出预算放不进时，
     *  把这次请求的输出预算收小再转发的次数（不是代写，只是少给一点输出）。 */
    outputClamped: number;
    /** 最后一次记数的时间（ISO）和路。 */
    lastAt?: string;
    lastPath?: GhostwritePath;
}

/** The session-metadata key the counters live under (persisted with the
 *  session like every other metadata field). */
export const NO_GHOSTWRITE_METADATA_KEY = "noGhostwrite";

/** True only when the request's resolved Config carries `noGhostwrite: true`.
 *  Anything else (absent, false, a stray string) is OFF — the upstream
 *  behavior, byte for byte. */
export function noGhostwriteOn(config: unknown): boolean {
    return (config as { noGhostwrite?: unknown } | undefined)?.noGhostwrite === true;
}

function emptyCounts(): NoGhostwriteCounts {
    return { preflight: 0, externalSummary: 0, autoFold: 0, outputClamped: 0 };
}

/** Read the session's counters (zeros when nothing was ever blocked). */
export function noGhostwriteCounts(session: { metadata?: Record<string, unknown> } | undefined): NoGhostwriteCounts {
    const raw = session?.metadata?.[NO_GHOSTWRITE_METADATA_KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyCounts();
    const r = raw as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return {
        preflight: n(r.preflight),
        externalSummary: n(r.externalSummary),
        autoFold: n(r.autoFold),
        outputClamped: n(r.outputClamped),
        ...(typeof r.lastAt === "string" ? { lastAt: r.lastAt } : {}),
        ...(r.lastPath === "preflight" || r.lastPath === "externalSummary" || r.lastPath === "autoFold" ? { lastPath: r.lastPath } : {}),
    };
}

/** Smallest output budget a clamped no-ghostwrite forward may carry: enough
 *  room for the model to answer with a compress call (its own summary) —
 *  below it the request is refused instead (413), like before. */
export const NO_GHOSTWRITE_MIN_OUTPUT = 4096;

/** Record one output-budget clamp (the forward-instead-of-413 path) and
 *  return the updated counters. lastAt/lastPath are left alone: they name the
 *  last BLOCKED ghostwrite, which is a different event. */
export function noteGhostwriteOutputClamped(session: { metadata?: Record<string, unknown> }): NoGhostwriteCounts {
    const next = noGhostwriteCounts(session);
    next.outputClamped += 1;
    (session.metadata ?? (session.metadata = {}))[NO_GHOSTWRITE_METADATA_KEY] = next;
    return next;
}

/** Record one blocked ghostwrite on `path` and return the updated counters.
 *  The caller marks the session dirty (it already holds the session lock). */
export function noteGhostwriteBlocked(
    session: { metadata?: Record<string, unknown> },
    path: GhostwritePath,
    now: Date = new Date(),
): NoGhostwriteCounts {
    const next = noGhostwriteCounts(session);
    next[path] += 1;
    next.lastAt = now.toISOString();
    next.lastPath = path;
    (session.metadata ?? (session.metadata = {}))[NO_GHOSTWRITE_METADATA_KEY] = next;
    return next;
}
