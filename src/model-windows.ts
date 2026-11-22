// fork（多模型，fork-1120）：按模型的判窗（M5）、切模型后按住紧急截断（R4）、
// Anthropic 签名思考的前缀绑定兜底（M7）。三样都默认关：没写 compress.modelWindows、
// 会话条目里没写 limitMode / truncateHoldAfterSwitch / anthropicThinkingBinding 时，
// 这里的函数一个都不会被调到，外发字节、账本行、会话里的键都和上游一样。
import { sanitizeModelWindowEntry, type CompressSettings, type ModelWindowEntry } from "./config.js";
import { log as loggerLog } from "./logger.js";

/** models.md 2.3：没校准过的路线取 0.85。 */
const DEFAULT_INPUT_SAFETY = 0.85;
/** models.md 2.3：r(m) = min(本次 max_tokens, 0.25 × W_native)。 */
const INPUT_RESERVE_CAP_PCT = 0.25;

const warnedModelWindows = new Set<string>();
function warnOnce(sig: string, msg: string): void {
    if (warnedModelWindows.has(sig)) return;
    warnedModelWindows.add(sig);
    loggerLog("warn", msg);
}

/** 按请求的 model 在 compress.modelWindows 里找一行：先整串认，再认键里「/」后面那段
 *  （只认唯一的一行；两行都对得上就都不认，打一次 warn）。写坏的行丢掉、打一次 warn。 */
export function resolveModelWindowEntry(
    globalCompress: CompressSettings | undefined,
    model: string | undefined,
): { key: string; entry: ModelWindowEntry } | undefined {
    const table = (globalCompress as { modelWindows?: unknown } | undefined)?.modelWindows;
    if (!table || typeof table !== "object" || Array.isArray(table) || typeof model !== "string" || model.length === 0) return undefined;
    const clean = (key: string): ModelWindowEntry | undefined => {
        const { value, problems } = sanitizeModelWindowEntry((table as Record<string, unknown>)[key]);
        if (problems.length > 0) warnOnce(`row|${key}|${problems.join("|")}`, `[model-window] compress.modelWindows["${key}"]: ${problems.join("; ")} — ${value ? "the valid fields still apply" : "the row is ignored"}`);
        return value;
    };
    if (Object.prototype.hasOwnProperty.call(table, model)) {
        const entry = clean(model);
        return entry !== undefined ? { key: model, entry } : undefined;
    }
    const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
    const hits = Object.keys(table).filter((k) => k.includes("/") && k.slice(k.lastIndexOf("/") + 1) === tail);
    if (hits.length > 1) {
        warnOnce(`ambiguous|${model}`, `[model-window] model=${model} matches ${hits.length} compress.modelWindows rows (${hits.join(", ")}) — none applied; key the row by the exact model id`);
        return undefined;
    }
    if (hits.length === 0) return undefined;
    const entry = clean(hits[0]!);
    return entry !== undefined ? { key: hits[0]!, entry } : undefined;
}

interface InputJudgeBase {
    judgeBase: number;
    /** 算的时候用的原生窗口（宿主报的和表里 window 取小）。 */
    native: number;
    safety: number;
    quality: number | undefined;
    reserve: number;
    /** ⌊native × safety⌋ − reserve */
    headroomBound: number;
}

/** models.md 2.3：judgeBase = min(T_in, Q, ⌊W × s⌋ − min(maxOutput, 0.25 × W))。
 *  provenReserve（上游在 400 里点过的输出份额）在的话，再夹到 W − provenReserve 以下。
 *  W 拿不到（undefined / 不是正数）→ undefined，调用方照 "window" 算。 */
export function computeInputJudgeBase(a: {
    target: number;
    hostNative: number | undefined;
    maxOutput: number;
    entry?: ModelWindowEntry;
    provenReserve?: number;
}): InputJudgeBase | undefined {
    if (!(typeof a.hostNative === "number" && Number.isFinite(a.hostNative) && a.hostNative > 0)) return undefined;
    const native = a.entry?.window !== undefined ? Math.min(a.hostNative, a.entry.window) : a.hostNative;
    const safety = a.entry?.safety ?? DEFAULT_INPUT_SAFETY;
    const quality = a.entry?.quality;
    const maxOutput = typeof a.maxOutput === "number" && Number.isFinite(a.maxOutput) && a.maxOutput > 0 ? a.maxOutput : 0;
    const reserve = Math.min(maxOutput, Math.floor(INPUT_RESERVE_CAP_PCT * native));
    const headroomBound = Math.floor(native * safety) - reserve;
    let judgeBase = Math.min(a.target, headroomBound);
    if (quality !== undefined) judgeBase = Math.min(judgeBase, quality);
    const proven = a.provenReserve ?? 0;
    if (proven > 0 && native > proven) judgeBase = Math.min(judgeBase, native - proven);
    judgeBase = Math.max(1, Math.floor(judgeBase));
    return { judgeBase, native, safety, quality, reserve, headroomBound };
}

// ---------------------------------------------------------------- R4

/** R4 的会话状态（只在开着时写进 session.metadata.truncateHoldAfterSwitch）。 */
export interface SwitchHoldState {
    /** 还要按住几份请求（含这一份）。 */
    left: number;
    /** 触发的原因：model / origin / window。 */
    reason: string;
    /** 从什么换过来的（model@origin），只给日志。 */
    from: string;
    at: number;
}

/** R4：这一份请求要不要按住紧急截断。
 *  - holdN 不是正数 → 不按住、不写任何东西（调用方连这个函数都不该调）。
 *  - 上一份请求的 model 或 origin 和这一份不一样（两边都知道时才比），或这一份出了
 *    [window-change] → 从这一份起按住 holdN 份。
 *  - 已经在按住 → 这一份照按，剩下的份数减一。
 *  返回 { hold, state }：state 是要写回 metadata 的新值（undefined = 删掉这个键）。 */
export function stepSwitchTruncateHold(a: {
    holdN: number;
    prev: SwitchHoldState | undefined;
    prevModel: string | undefined;
    curModel: string | undefined;
    prevOrigin: string | undefined;
    curOrigin: string | undefined;
    windowChanged: boolean;
    now: number;
}): { hold: boolean; started: boolean; state: SwitchHoldState | undefined } {
    const n = Math.max(0, Math.min(8, Math.floor(a.holdN)));
    if (n <= 0) return { hold: false, started: false, state: undefined };
    const modelChanged = a.prevModel !== undefined && a.curModel !== undefined && a.prevModel !== a.curModel;
    const originChanged = a.prevOrigin !== undefined && a.curOrigin !== undefined && a.prevOrigin !== a.curOrigin;
    if (modelChanged || originChanged || a.windowChanged) {
        const reason = [modelChanged ? "model" : "", originChanged ? "origin" : "", a.windowChanged ? "window" : ""].filter(Boolean).join("+");
        const left = n - 1;
        return {
            hold: true,
            started: true,
            state: left > 0 ? { left, reason, from: `${a.prevModel ?? "?"}@${a.prevOrigin ?? "?"}`, at: a.now } : undefined,
        };
    }
    const prev = a.prev;
    if (prev !== undefined && typeof prev.left === "number" && prev.left > 0) {
        const left = Math.min(prev.left, n) - 1;
        return { hold: true, started: false, state: left > 0 ? { ...prev, left } : undefined };
    }
    return { hold: false, started: false, state: undefined };
}

// ---------------------------------------------------------------- M7

/** Anthropic 的前缀绑定 400：「Invalid `signature` in `thinking` block. The block is
 *  bound to a different conversation.」。签名坏了的那种 400 没有后半句，不认（去掉思考也救不了）。 */
export function isThinkingBindingError(status: number, text: string | null | undefined): boolean {
    if (status !== 400 || typeof text !== "string" || text.length === 0) return false;
    return /invalid\s+`?signature`?\s+in\s+`?(?:redacted_)?thinking`?\s+block/i.test(text)
        && /bound to a different conversation/i.test(text);
}

/** 把 Anthropic 请求体里所有 assistant 消息的 thinking / redacted_thinking 块去掉。
 *  - 只有思考、没有别的内容的 assistant 消息整条去掉（发空消息只会换一个 400；
 *    相邻的同角色消息 Anthropic 会合成一轮）。最后一条消息是这种 → 不改（null）。
 *  - 开着 thinking 时，工具循环里的最后一轮 assistant（最后一条消息是带
 *    tool_result 的 user）必须以思考块开头（RC-6）：这一轮的思考被去掉了，就把
 *    顶层的 thinking 也去掉（这一份重发不思考）；别的情况顶层 thinking 不动。
 *  没有可去的 → null。 */
export function stripAnthropicThinking(body: string): { body: string; stripped: number; messages: number; dropped: number; thinkingOff: boolean } | null {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const top = parsed as { messages?: unknown; thinking?: unknown };
    const msgs = top.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) return null;
    const isThinking = (b: unknown): boolean => !!b && typeof b === "object" && ((b as { type?: unknown }).type === "thinking" || (b as { type?: unknown }).type === "redacted_thinking");
    let lastAssistant = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i] as { role?: unknown } | null;
        if (m && typeof m === "object" && m.role === "assistant") { lastAssistant = i; break; }
    }
    let stripped = 0;
    let touched = 0;
    let lastLost = false;
    const drop = new Set<number>();
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m || typeof m !== "object") continue;
        const mm = m as { role?: unknown; content?: unknown };
        if (mm.role !== "assistant" || !Array.isArray(mm.content)) continue;
        const kept = mm.content.filter((b) => !isThinking(b));
        const removed = mm.content.length - kept.length;
        if (removed === 0) continue;
        if (kept.length === 0) {
            if (i === msgs.length - 1) return null;
            drop.add(i);
        } else mm.content = kept;
        stripped += removed;
        touched++;
        if (i === lastAssistant) lastLost = true;
    }
    if (stripped === 0) return null;
    if (drop.size > 0) top.messages = msgs.filter((_m, i) => !drop.has(i));
    // the tool loop's last assistant turn lost its thinking → this request cannot think
    const final = msgs[msgs.length - 1] as { role?: unknown; content?: unknown } | null;
    const toolLoop = !!final && typeof final === "object" && final.role === "user" && Array.isArray(final.content)
        && final.content.some((b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result");
    const thinkingOn = !!top.thinking && typeof top.thinking === "object" && (top.thinking as { type?: unknown }).type !== "disabled";
    let thinkingOff = false;
    if (lastLost && toolLoop && thinkingOn) {
        delete top.thinking;
        thinkingOff = true;
    }
    return { body: JSON.stringify(parsed), stripped, messages: touched, dropped: drop.size, thinkingOff };
}

// ---------------------------------------------------------------- M8

/** M8：vLLM 新版回 `reasoning`，有的网关回 `reasoning_text`。 */
const OPENAI_REASONING_ALIASES: readonly string[] = Object.freeze(["reasoning", "reasoning_text"]);

/** 这一份请求的 Config 上开没开 openaiReasoningAliases（会话条目写的，见
 *  applySessionCompressOverride）。没开 → undefined，openaiToCore 照上游的调法。 */
export function openaiReasoningAliasesOf(config: unknown): readonly string[] | undefined {
    return (config as { openaiReasoningAliases?: unknown } | undefined)?.openaiReasoningAliases === true ? OPENAI_REASONING_ALIASES : undefined;
}

/** M7：这一份请求的 Config 上是不是 strip_retry。 */
export function anthropicStripRetryOn(config: unknown): boolean {
    return (config as { anthropicThinkingBinding?: unknown } | undefined)?.anthropicThinkingBinding === "strip_retry";
}
