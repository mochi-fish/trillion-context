// fork（养成向）：文件图折起时留「图片路径」占位（compress.foldHostFileImagePaths）。
//
// 背景：compress.foldHostFileImages 开着时，工具结果里宿主那边的图（Anthropic 线的
// {type:"file"}）可以折；折掉以后像素不在了，decompress 拿不回图，块尾巴只写「原图在
// 宿主那边」。可宿主其实给每张图都存了一份只读的规范化副本（附件库
// `<DSH_HOME>/attachments/v1/objects/<前两位>/<64 位>`，从不自动删），并且每张图前面
// 那段 handle 文字里就写着这份副本的路径。这个模块在建块那一刻把这些路径认出来，
// 写成 `~/…/attachments/v1/objects/xx/<64 位>`（去掉家目录，所以路径里没有系统用户名），
// 她以后想再看哪张，用 read_image 读这个路径（宿主的文件工具会展开 `~/`）。
//
// 守的规矩：
//   - 只在 foldHostFileImages 和 foldHostFileImagePaths 都开着时才走；不开时这里一行都不跑，
//     出站、回执、账本和不带这个模块时逐字节一样。
//   - 路径只从宿主自己的 handle 文字里取，而且必须落在家目录下、目录结构对、文件名等于
//     handle 里的附件编号、文件在盘上；任何一条不满足就照实写「不留路径」的原因。
//   - 隐私那几道一律偏严（认不准就不留路径，fail-closed）：
//       · 没有工具名（配对的 tool_use 不在这一次请求里）→ 不留；
//       · 屏幕截图：工具名是 mcp__wincu__…、或者名字里有 windows_computer_use_（任何服务名下，照线上桥
//         WINCU_LOOK_RE 放宽），或者工具结果的字里出现 wincu 截屏的文件名
//         （windows-computer-use-*、wcu-wgc-*、dsh-wcu-browser-screenshots）或 `.dsh-watch-`
//         ——不管哪个工具、文件在哪个目录 → 不留；
//       · 结果头（`<path>…</path>\n<type>image</type>`，`\r\n` 也认）指向临时目录 → 不管哪个工具都不留；
//         结果头的路径认不准（8.3 短名、`\\?\`、`..`、Windows 上段末尾带点或空格）→ 不留；
//       · read_image 认不出结果头 → 不留；
//       · 截屏、临时目录、没有工具名这三样「污染」那张图的编号：同一个编号在别处（同一块、别的块、并块
//         带上来、decompress 那条路）出现也不给路径。跨块的靠会话 metadata 里记的编号集合
//         （hostImagePathsNoPath，建块时记）加上这一次请求整份历史里扫到的；
//       · 路径里（附件库以上那几段）出现系统用户名 → 不留：用户名除了家目录最后一段，
//         还另取 os.userInfo().username、USERNAME / USER、USERPROFILE 最后一段各查一遍
//         （BILI_HOST_HOME 配错成 `C:\Users`、`C:\` 时靠这个挡），家目录本身太浅
//         （Windows 少于 3 段、别处少于 2 段）一律不留。
//   - 尾巴在建块时算好、存进块里，以后每次请求逐字相同（不在每次请求时 stat 文件）。
//   - 给她看的字写中文、照实：说清「已折起，不在上下文里了」；块里没有代理存着像素的图时写
//     「decompress 拿不回图」，有的话（同一块里上游那行「restores pixels」）写成「写着 restores
//     pixels、带 m 编号的那几张 decompress 也许还取得回，别的 decompress 拿不回」，两句不打架；
//     不引她去 decompress 找路径。
//
// 这个模块不 import session.ts（结构类型），免得成环。

import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { CoreMessage } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";

/** 一块尾巴里最多列几张图（含从子块带上来的）。超了留最新的，最后一行照实写少了几张。 */
export const HOST_IMAGE_PATH_MAX_LINES = 16;

/** 截屏工具的名字：第 36 条的屏幕截图只有「看一眼」那一轮能看，这些工具给的图不留路径。
 *  照线上桥的 WINCU_LOOK_RE（`^mcp__(?:.+__windows_computer_use_|wincu__)…`）认，放宽：任何服务名下的
 *  `mcp__wincu__…`，名字里任何地方的 `windows_computer_use_`（wincu 换了服务名注册、或者不走 MCP 时也认），
 *  不分大小写、不限动作（偏严，只少路径）。 */
const HOST_IMAGE_SHOT_TOOL_RE = /^mcp__wincu__|(?:^|_)windows_computer_use_/i;
function isShotTool(tool: string): boolean {
    return HOST_IMAGE_SHOT_TOOL_RE.test(tool);
}

/** 工具结果的字里出现这些就当屏幕截图（照桥第 36 条的 WINCU_SHOT_RE，放宽：不要求 .png 结尾），
 *  不管哪个工具、文件在哪个目录。`.dsh-watch-` 是眼耳嘴插件的目录（key、听写、看到的屏幕）。 */
const HOST_IMAGE_SHOT_TEXT_RE = /windows-computer-use-|wcu-wgc-|dsh-wcu-browser-screenshots|\.dsh-watch-/i;

/** 上游给本机存着字节的图写的那一行的结尾（stream.ts 建块时追加）。 */
const UPSTREAM_RESTORES_PIXELS_MARK = "— decompress({ imageRef }) restores pixels]";

type SkipWhy = "screenshot" | "temp" | "missing" | "unknown" | "notool";

/** 一张图在尾巴里的一行：有路径（path）或者有不留路径的原因（why），二者必有其一。 */
export interface HostImageEntry {
    /** 产生这张图的工具名（清洗过；认不出就没有）。 */
    tool?: string;
    /** 宿主 handle 里的附件编号（64 位十六进制，不带 `sha256:`）。 */
    sha?: string;
    /** `~/…/attachments/v1/objects/xx/<64 位>`。 */
    path?: string;
    why?: SkipWhy;
}

/** 算路径要用的环境（测试里换成假的）。 */
export interface HostImagePathEnv {
    /** 宿主展开 `~` 用的家目录。 */
    home: string;
    /** 系统临时目录（read_image 读这些目录下的文件时不留路径）。 */
    tempRoots: readonly string[];
    exists: (absPath: string) => boolean;
    /** 路径按 Windows 规矩比（不分大小写、`\` 和 `/` 都算分隔符）。 */
    win: boolean;
    /** 家目录最后一段以外，另外要查的系统用户名（os.userInfo().username 等）：附件库以上那几段里
     *  出现任何一个就不留路径。不给就只查家目录最后一段。 */
    userNames?: readonly string[];
}

/** True only when BOTH compress.foldHostFileImages and compress.foldHostFileImagePaths
 *  are `true` on the resolved Config. Anything else = this module is never reached. */
export function hostImagePathsOn(config: unknown): boolean {
    const c = config as { foldHostFileImages?: unknown; foldHostFileImagePaths?: unknown } | undefined;
    return c?.foldHostFileImages === true && c?.foldHostFileImagePaths === true;
}

/** 真环境：家目录取 BILI_HOST_HOME（宿主和代理不在同一个用户目录下时、或演练架子用），
 *  没写就是 os.homedir()；临时目录取 os.tmpdir()、TEMP、TMP，Windows 上再加
 *  `<家目录>\AppData\Local\Temp`，各自再加一份 realpath（8.3 短名那种）。
 *  另查的用户名：os.userInfo().username、USERNAME / USER、USERPROFILE 的最后一段——
 *  BILI_HOST_HOME 配错时（比如 `C:\Users`）家目录最后一段不是用户名，靠这几样再挡一道。 */
export function hostImagePathEnv(): HostImagePathEnv {
    const win = process.platform === "win32";
    const override = (process.env.BILI_HOST_HOME ?? "").trim();
    const home = override !== "" ? override : homedir();
    const roots = new Set<string>();
    const add = (p: string | undefined): void => {
        if (typeof p !== "string" || p.trim() === "") return;
        roots.add(p);
        try { roots.add(realpathSync.native(p)); } catch { /* 不存在就只按字面比 */ }
    };
    add(tmpdir());
    add(process.env.TEMP);
    add(process.env.TMP);
    if (win) add(join(home, "AppData", "Local", "Temp"));
    const users = new Set<string>();
    const addUser = (u: unknown): void => {
        if (typeof u === "string" && u.trim() !== "") users.add(u.trim());
    };
    try { addUser(userInfo().username); } catch { /* 取不到就算了，还有别的几样 */ }
    addUser(process.env.USERNAME);
    addUser(process.env.USER);
    if (win && typeof process.env.USERPROFILE === "string") addUser(lastSegment(process.env.USERPROFILE, true));
    return { home, tempRoots: [...roots], exists: existsSync, win, userNames: [...users] };
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
function cleanToolName(name: unknown): string | undefined {
    return typeof name === "string" && TOOL_NAME_RE.test(name) ? name : undefined;
}

// DSH 的 handle（packages/llm/llm/src/content.ts requestImageHandleText）：
//   `Image ${identity}; request preview WxHpx.` + 可选的
//   ` Normalized copy (read-only; may be resized or re-encoded): ${JSON 引号的路径} (WxHpx, image/x).`
// identity 没有名字时是 `sha256:<64>`，有名字时是 `${JSON 引号的名字} (sha256:<64>)`。
const HANDLE_RE = /^Image (?:"(?:[^"\\]|\\.)*" \(sha256:([0-9a-f]{64})\)|sha256:([0-9a-f]{64})); request preview \d+x\d+px\.(?: Normalized copy \(read-only; may be resized or re-encoded\): ("(?:[^"\\]|\\.)*") \(\d+x\d+px, image\/[a-z]+\)\.)?/;

function parseHandle(text: string): { sha: string; path?: string } | undefined {
    const m = HANDLE_RE.exec(text);
    if (!m) return undefined;
    const sha = (m[1] ?? m[2])!;
    if (m[3] === undefined) return { sha };
    try {
        const p: unknown = JSON.parse(m[3]);
        return typeof p === "string" ? { sha, path: p } : { sha };
    } catch {
        return { sha };
    }
}

// 结果头（packages/fs/tool-fs/src/read-image.ts formatImageReadOutput 的样子）。别的工具要是也这么写，
// 一样认：结果头指向临时目录的，不管哪个工具都不留路径。换行 `\n`、`\r\n` 都认（DSH 自己只写 `\n`）。
const READ_IMAGE_ENVELOPE_RE = /^<path>([^\n]*)<\/path>\r?\n<type>image<\/type>/;

/** 这条工具结果里所有结果头的路径（一般就一个）。 */
function envelopePaths(content: readonly unknown[]): string[] {
    const out: string[] = [];
    for (const c of content) {
        if (!isObj(c) || c.type !== "text" || typeof c.text !== "string") continue;
        const m = READ_IMAGE_ENVELOPE_RE.exec(c.text);
        if (m) out.push(m[1]!);
    }
    return out;
}

/** 结果头的路径能不能拿来和临时目录比：Windows 上只认 `X:\…` 这种平常的绝对路径，`\\?\`、UNC、相对路径、
 *  带 8.3 短名（`~1` 这种）、带 `.` / `..` 段的都比不了——比不了就当认不出（偏严，宿主写的结果头从来不是这样）。
 *  Windows 打开文件时会去掉每一段末尾的点和空格（`…\Temp.\f.png`、`…\Temp \f.png` 读到的是临时目录里的文件），
 *  按字面比不准：任何一段以点或空格结尾也当认不出（线上桥 fishOffLimits 第 8 步的规则，这里取偏严的那一半）。 */
function plainAbsolute(p: string, win: boolean): boolean {
    if (win) {
        if (!/^[A-Za-z]:[\\/]/.test(p) || /~\d/.test(p)) return false;
    } else if (!p.startsWith("/")) return false;
    return !p.split(/[\\/]/).some((s) => s === "." || s === ".." || (win && /[. ]$/.test(s)));
}

/** 工具结果的字（结果头、handle 里的图名、别的说明）里有没有截屏的样子。 */
function mentionsShot(content: readonly unknown[]): boolean {
    return content.some((c) => isObj(c) && c.type === "text" && typeof c.text === "string" && HOST_IMAGE_SHOT_TEXT_RE.test(c.text));
}

function normSep(p: string, win: boolean): string {
    return win ? p.replace(/\//g, "\\") : p;
}
function stripTrailingSep(p: string): string {
    return p.length > 1 ? p.replace(/[\\/]+$/, "") : p;
}
/** 路径的最后一段（`C:\Users\x\` → `x`）。 */
function lastSegment(p: string, win: boolean): string {
    return stripTrailingSep(normSep(p, win)).split(/[\\/]/).pop() ?? "";
}
/** 家目录太浅（配错成 `C:\Users`、`C:\`、`/home` 这类）：一律不留路径。 */
function homeTooShallow(env: HostImagePathEnv): boolean {
    const parts = normSep(env.home, env.win).split(/[\\/]/).filter((s) => s !== "");
    return parts.length < (env.win ? 3 : 2);
}
function under(p: string, root: string, win: boolean): boolean {
    const sep = win ? "\\" : "/";
    const a = normSep(p, win);
    const r = stripTrailingSep(normSep(root, win));
    if (r === "") return false;
    const A = win ? a.toLowerCase() : a;
    const R = win ? r.toLowerCase() : r;
    return A === R || A.startsWith(R + sep);
}

/** 最后一道核：只许这种样子（没有盘符、没有反斜杠、没有空白）。 */
const TILDE_PATH_RE = /^~\/(?:[^\\/:*?"<>|\s]+\/)*attachments\/v1\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
const SEGMENT_BAD_RE = /[\\/:*?"<>|\s\x00-\x1f]/;

/** `~/…` 写法 → 宿主展开以后的绝对路径段（家目录下的相对段）。不合规矩就 undefined。 */
function tildeSegments(segs: readonly string[], sha: string | undefined, env: HostImagePathEnv): string[] | undefined {
    if (segs.length < 5) return undefined;
    if (segs.some((s) => s === "" || s === "." || s === ".." || SEGMENT_BAD_RE.test(s))) return undefined;
    // Windows 会去掉段末尾的点（空格上面已经拒了）：按字面认不准，不留（和 plainAbsolute 同一条规矩）。
    if (env.win && segs.some((s) => s.endsWith("."))) return undefined;
    const [a, v, o, xx, name] = segs.slice(segs.length - 5) as [string, string, string, string, string];
    if (a !== "attachments" || v !== "v1" || o !== "objects") return undefined;
    if (!/^[0-9a-f]{64}$/.test(name) || xx !== name.slice(0, 2)) return undefined;
    if (sha !== undefined && name !== sha) return undefined;
    if (homeTooShallow(env)) return undefined;
    // 路径里不许出现系统用户名：家目录最后一段，加上另取的那几样（os.userInfo().username 等，
    // 家目录配错时靠它们）。只看附件库以上的那几段（编号是十六进制，不算）。
    const above = segs.slice(0, segs.length - 5).map((s) => (env.win ? s.toLowerCase() : s));
    for (const user of [lastSegment(env.home, env.win), ...(env.userNames ?? [])]) {
        if (user.length < 2) continue;
        const U = env.win ? user.toLowerCase() : user;
        if (above.some((s) => s.includes(U))) return undefined;
    }
    const tilde = "~/" + segs.join("/");
    if (!TILDE_PATH_RE.test(tilde)) return undefined;
    return [...segs];
}

function absFromSegments(segs: readonly string[], env: HostImagePathEnv): string {
    const sep = env.win ? "\\" : "/";
    return [stripTrailingSep(normSep(env.home, env.win)), ...segs].join(sep);
}

/** 宿主 handle 里的绝对路径 → `~/…`（只认家目录下、附件库的样子、编号对得上的）。 */
function tildeFromHostPath(p: string, sha: string, env: HostImagePathEnv): { tilde: string; abs: string } | undefined {
    const home = stripTrailingSep(normSep(env.home, env.win));
    if (home === "" || !under(p, home, env.win)) return undefined;
    const rel = normSep(p, env.win).slice(home.length + 1);
    const segs = tildeSegments(rel.split(/[\\/]/), sha, env);
    if (!segs) return undefined;
    return { tilde: "~/" + segs.join("/"), abs: absFromSegments(segs, env) };
}

/** 一条带图的工具结果：工具名、整条的「不留路径」原因（没有就是还要逐张看路径），和每张图（file、base64，
 *  顺序同线上）前面的 handle。不是带图的工具结果就回 undefined。不碰盘。 */
function scanToolResult(m: CoreMessage, env: HostImagePathEnv): { tool?: string; msgWhy?: SkipWhy; images: ({ sha: string; path?: string } | undefined)[] } | undefined {
    const ab = (m as BiliMessage).rawAnthropicBlock;
    if (!isObj(ab) || ab.type !== "tool_result" || !Array.isArray(ab.content)) return undefined;
    const content = ab.content as unknown[];
    const images: ({ sha: string; path?: string } | undefined)[] = [];
    for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (!isObj(c) || c.type !== "image") continue;
        const s = c.source;
        if (!isObj(s) || (s.type !== "file" && s.type !== "base64")) continue;
        const prev = content[i - 1];
        images.push(isObj(prev) && prev.type === "text" && typeof prev.text === "string" ? parseHandle(prev.text) : undefined);
    }
    if (images.length === 0) return undefined;
    const tool = cleanToolName((m as { toolName?: unknown }).toolName);
    const envelopes = envelopePaths(content);
    let msgWhy: SkipWhy | undefined;
    if ((tool !== undefined && isShotTool(tool)) || mentionsShot(content)) msgWhy = "screenshot";
    else if (envelopes.some((p) => !plainAbsolute(p, env.win))) msgWhy = "unknown";
    else if (envelopes.some((p) => env.tempRoots.some((r) => under(p, r, env.win)))) msgWhy = "temp";
    else if (tool === undefined) msgWhy = "notool";
    else if (tool === "read_image" && envelopes.length === 0) msgWhy = "unknown";
    return { ...(tool !== undefined ? { tool } : {}), ...(msgWhy !== undefined ? { msgWhy } : {}), images };
}

/** 一条工具结果里每张图（file、base64 两种来源，顺序同线上）在尾巴里的样子。
 *  不是带图的工具结果就回空数组。
 *  隐私那几道按这个先后（截屏、临时目录、没有工具名这三样会「污染」同一个编号，别处出现也不给路径；
 *  跨块的见 hostImageNoPathMap）：
 *    截屏（工具名是 wincu 的，或者结果的字里有截屏文件名 / `.dsh-watch-`，不管哪个工具、哪个目录）
 *    → 结果头的路径没法和临时目录比（8.3 短名、`\\?\`、`..`、段末尾带点或空格这种）：认不出
 *    → 结果头指向临时目录（不管哪个工具）
 *    → 没有工具名（配对不上 tool_use）
 *    → read_image 认不出结果头、handle 认不出 → 才看路径本身。 */
export function hostImageEntries(m: CoreMessage, env: HostImagePathEnv): HostImageEntry[] {
    const r = scanToolResult(m, env);
    if (!r) return [];
    return r.images.map((handle) => {
        const e: HostImageEntry = {};
        if (r.tool !== undefined) e.tool = r.tool;
        if (handle) e.sha = handle.sha;
        if (r.msgWhy !== undefined) e.why = r.msgWhy;
        else if (!handle || handle.path === undefined) e.why = "unknown";
        else {
            const t = tildeFromHostPath(handle.path, handle.sha, env);
            if (!t) e.why = "unknown";
            else if (!env.exists(t.abs)) e.why = "missing";
            else e.path = t.tilde;
        }
        return e;
    });
}

// ---------- 「不留路径」的编号（跨块） ----------

/** 会「污染」同一个编号的原因：一张图在任何一处算这几样，别处（同一块、别的块、并块带上来、
 *  decompress 那条路）出现也不给路径。先后：截屏 > 临时目录 > 没有工具名（同一个编号几处原因不同时，
 *  尾巴里写排在前面的那个）。 */
type TaintWhy = "screenshot" | "temp" | "notool";
const TAINT_RANK: Record<TaintWhy, number> = { screenshot: 3, temp: 2, notool: 1 };
function isTaint(why: unknown): why is TaintWhy {
    return why === "screenshot" || why === "temp" || why === "notool";
}
function addTaint(map: Map<string, TaintWhy>, sha: string, why: TaintWhy): void {
    const had = map.get(sha);
    if (!isTaint(had) || TAINT_RANK[why] > TAINT_RANK[had]) map.set(sha, why);
}

/** 会话 metadata 里记「不留路径」编号的键（随会话落盘）：`{ <64 位编号>: 原因 }`。只有开关开着、
 *  compress 真提交了、而且见到过这种编号时才会出现。 */
export const HOST_IMAGE_NO_PATH_METADATA_KEY = "hostImagePathsNoPath";
/** 最多记这么多个编号（超了丢最早记下的）。 */
export const HOST_IMAGE_NO_PATH_MAX = 1024;
const SHA64_RE = /^[0-9a-f]{64}$/;

function readNoPath(session: { metadata?: Record<string, unknown> }): Map<string, TaintWhy> {
    const raw = session.metadata?.[HOST_IMAGE_NO_PATH_METADATA_KEY];
    const out = new Map<string, TaintWhy>();
    if (!isObj(raw)) return out;
    for (const [sha, why] of Object.entries(raw)) {
        if (SHA64_RE.test(sha) && isTaint(why)) addTaint(out, sha, why);
    }
    return out;
}

/** 这些消息里（一般是这一次请求的整份历史）算截屏 / 临时目录 / 没有工具名的图的编号。不碰盘。 */
function hostImageTaintsOf(messages: Iterable<CoreMessage>, env: HostImagePathEnv): Map<string, TaintWhy> {
    const out = new Map<string, TaintWhy>();
    for (const m of messages) {
        const r = scanToolResult(m, env);
        const why = r?.msgWhy;
        if (!r || !isTaint(why)) continue;
        for (const h of r.images) if (h) addTaint(out, h.sha, why);
    }
    return out;
}

/** 跨块的「不留路径」编号：会话里记下的（以前建块时见过的，宿主后来把图换成占位字也还记得），
 *  加上这一次请求整份历史里的（还没折的截屏也算，见 S2 / U2）。 */
export function hostImageNoPathMap(session: { metadata?: Record<string, unknown> }, view: Iterable<CoreMessage>, env: HostImagePathEnv): Map<string, TaintWhy> {
    const out = readNoPath(session);
    for (const [sha, why] of hostImageTaintsOf(view, env)) addTaint(out, sha, why);
    return out;
}

/** 把这次见到的「不留路径」编号记进会话（并进原来的，超了丢最早的）。有变化才写；回 true = 写了。 */
export function rememberHostImageNoPath(session: { metadata?: Record<string, unknown> }, add: ReadonlyMap<string, SkipWhy>): boolean {
    const cur = readNoPath(session);
    let changed = false;
    for (const [sha, why] of add) {
        if (!SHA64_RE.test(sha) || !isTaint(why)) continue;
        const had = cur.get(sha);
        addTaint(cur, sha, why);
        if (cur.get(sha) !== had) changed = true;
    }
    if (!changed) return false;
    const entries = [...cur];
    const keep = entries.length > HOST_IMAGE_NO_PATH_MAX ? entries.slice(entries.length - HOST_IMAGE_NO_PATH_MAX) : entries;
    (session.metadata ?? (session.metadata = {}))[HOST_IMAGE_NO_PATH_METADATA_KEY] = Object.fromEntries(keep);
    return true;
}

/** 一串尾巴行里会污染编号的那几样（给 rememberHostImageNoPath）。 */
export function hostImageTaintsOfEntries(entries: readonly HostImageEntry[]): Map<string, TaintWhy> {
    const out = new Map<string, TaintWhy>();
    for (const e of entries) if (e.sha !== undefined && isTaint(e.why)) addTaint(out, e.sha, e.why);
    return out;
}

// ---------- 尾巴的字 ----------

// 头一句关于 decompress 的那半句：块里没有代理存着像素的图时整句说「拿不回」；有的话（同一块里上游
// 那行「[folded images: … — decompress({ imageRef }) restores pixels]」，或者并进来的子块有过）
// 照实分开说，不和上游那行打架。
const HEAD_DECOMPRESS_NONE = "decompress 拿不回图";
const HEAD_DECOMPRESS_MIXED = "写着 restores pixels、带 m 编号的那几张 decompress 也许还取得回，别的 decompress 拿不回";
const HEAD_PREFIX = "[这一段里有 ";
const headRest = (clause: string): string => ` 张图，已折起，不在上下文里了；${clause}。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：`;
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOTE_HEAD_RE = new RegExp(`^${reEscape(HEAD_PREFIX)}(\\d+)(${reEscape(headRest(HEAD_DECOMPRESS_NONE))}|${reEscape(headRest(HEAD_DECOMPRESS_MIXED))})$`);
const noteHead = (n: number, mixed: boolean): string => `${HEAD_PREFIX}${n}${headRest(mixed ? HEAD_DECOMPRESS_MIXED : HEAD_DECOMPRESS_NONE)}`;
const WHY_TEXT: Record<SkipWhy, string> = {
    screenshot: "屏幕截图，不留路径",
    temp: "读的是临时目录里的文件，不留路径",
    missing: "宿主的副本已经不在了，看不回来了",
    unknown: "认不出宿主把副本放在哪，不留路径",
    notool: "认不出是哪个工具给的图，不留路径",
};
const cappedLine = (n: number): string => `（还有 ${n} 张更早的图没留路径：一块最多记 ${HOST_IMAGE_PATH_MAX_LINES} 张）`;
const unlistedLine = (n: number): string => `（还有 ${n} 张更早的图折起时没记路径）`;
const CAPPED_RE = new RegExp(`^（还有 (\\d+) 张更早的图没留路径：一块最多记 ${HOST_IMAGE_PATH_MAX_LINES} 张）$`);
const UNLISTED_RE = /^（还有 (\d+) 张更早的图折起时没记路径）$/;
const LINE_RE = /^图(\d+)(?: ([A-Za-z0-9_.:-]{1,80}))?：(.+)$/;
const SAME_RE = /^同图(\d+)$/;
// 088df7d 的 file 图尾巴（只开 foldHostFileImages、不开路径时建的块）：并块时把张数记成「折起时没记路径」。
const OLD_HOST_HELD_NOTE_RE = /^\[这一段里有 (\d+) 张图，已折起：像素不在这里，decompress 拿不回图，原图在宿主那边\]$/;

/** 一段尾巴的内容：按顺序的图、超额少了几张、更早没记路径的几张；`mixed` = 这一块里（或并进来的
 *  子块里）有代理存着像素的图（上游那行「restores pixels」），头一句要分开说。 */
interface HostImagePathSection {
    entries: HostImageEntry[];
    capped: number;
    unlisted: number;
    mixed?: boolean;
}

/** 渲染统计（给计数用）。 */
interface RenderTally { listed: number; sameAs: number; screenshot: number; temp: number; missing: number; unknown: number; notool: number; capped: number; unlisted: number }

/** 把一串图写成尾巴。超过一块的上限留最新的；同一个编号第二次出现写「同图k」；
 *  一个编号在任何一处算截屏 / 临时目录 / 没有工具名（这一串里的，加上 `noPath` 里跨块记下的），
 *  别处出现也不留路径。什么都没有就回 undefined。 */
export function renderHostImagePathNote(section: HostImagePathSection, noPath?: ReadonlyMap<string, SkipWhy>): { text: string; tally: RenderTally } | undefined {
    const all = section.entries;
    let capped = section.capped;
    const keep = all.length > HOST_IMAGE_PATH_MAX_LINES ? all.slice(all.length - HOST_IMAGE_PATH_MAX_LINES) : all;
    capped += all.length - keep.length;
    const unlisted = section.unlisted;
    if (keep.length === 0 && capped === 0 && unlisted === 0) return undefined;
    const tainted = hostImageTaintsOfEntries(all);
    if (noPath) for (const [sha, why] of noPath) if (isTaint(why)) addTaint(tainted, sha, why);
    const first = new Map<string, number>();
    const tally: RenderTally = { listed: 0, sameAs: 0, screenshot: 0, temp: 0, missing: 0, unknown: 0, notool: 0, capped, unlisted };
    const lines: string[] = [];
    keep.forEach((e, i) => {
        const k = i + 1;
        const label = `图${k}${e.tool !== undefined ? ` ${e.tool}` : ""}：`;
        const j = e.sha !== undefined ? first.get(e.sha) : undefined;
        if (j !== undefined) {
            lines.push(`${label}同图${j}`);
            tally.sameAs += 1;
            return;
        }
        if (e.sha !== undefined) first.set(e.sha, k);
        // 最后一道：没有工具名的行不管带没带路径都不给（hostImageEntries / 认尾巴已经这么做了，这里再兜一次）。
        const taintedWhy = e.sha !== undefined ? tainted.get(e.sha) : undefined;
        const why: SkipWhy | undefined = taintedWhy ?? e.why ?? (e.tool === undefined ? "notool" : undefined);
        if (why === undefined && e.path !== undefined) {
            lines.push(`${label}${e.path}`);
            tally.listed += 1;
            return;
        }
        const w = why ?? "unknown";
        lines.push(`${label}${WHY_TEXT[w]}`);
        tally[w] += 1;
    });
    if (capped > 0) lines.push(cappedLine(capped));
    if (unlisted > 0) lines.push(unlistedLine(unlisted));
    const n = keep.length + capped + unlisted;
    return { text: `${noteHead(n, section.mixed === true)}\n${lines.join("\n")}]`, tally };
}

/** 从一个块的摘要末尾认出机器加的那段尾巴（只认最末尾、整段都合规矩的；她自己写的、
 *  长得像的字不认）。也认 088df7d 那种不带路径的尾巴（只记张数）。认不出就 undefined。
 *  `text` 是这段尾巴在摘要里的原文（不含前面的空行）。带路径的行会照当前环境再核一遍
 *  （样子、编号、用户名、文件在不在），不过关的改成相应的原因。 */
export function parseHostImagePathNote(summary: string, env: HostImagePathEnv): (HostImagePathSection & { text: string; mixed: boolean }) | undefined {
    const at = summary.lastIndexOf(`\n\n${HEAD_PREFIX}`);
    if (at < 0) return undefined;
    const text = summary.slice(at + 2);
    const old = OLD_HOST_HELD_NOTE_RE.exec(text);
    if (old) return { entries: [], capped: 0, unlisted: Number(old[1]), mixed: false, text };
    if (!text.endsWith("]")) return undefined;
    const rows = text.slice(0, -1).split("\n");
    const head = NOTE_HEAD_RE.exec(rows[0] ?? "");
    if (!head) return undefined;
    const mixed = head[2] === headRest(HEAD_DECOMPRESS_MIXED);
    const entries: HostImageEntry[] = [];
    let capped = 0;
    let unlisted = 0;
    let tailMode = false;
    for (const row of rows.slice(1)) {
        const cm = CAPPED_RE.exec(row);
        if (cm && !tailMode && capped === 0) { capped = Number(cm[1]); tailMode = true; continue; }
        const um = UNLISTED_RE.exec(row);
        if (um && unlisted === 0) { unlisted = Number(um[1]); tailMode = true; continue; }
        if (tailMode) return undefined;
        const lm = LINE_RE.exec(row);
        if (!lm || Number(lm[1]) !== entries.length + 1) return undefined;
        const e: HostImageEntry = {};
        if (lm[2] !== undefined) e.tool = lm[2];
        const body = lm[3]!;
        const same = SAME_RE.exec(body);
        if (same) {
            const ref = entries[Number(same[1]) - 1];
            if (!ref || Number(same[1]) >= entries.length + 1) return undefined;
            if (ref.sha !== undefined) e.sha = ref.sha;
            if (ref.path !== undefined) e.path = ref.path;
            if (ref.why !== undefined) e.why = ref.why;
            entries.push(e);
            continue;
        }
        const why = (Object.keys(WHY_TEXT) as SkipWhy[]).find((w) => WHY_TEXT[w] === body);
        if (why !== undefined) { e.why = why; entries.push(e); continue; }
        if (!TILDE_PATH_RE.test(body)) return undefined;
        const segs = tildeSegments(body.slice(2).split("/"), undefined, env);
        const sha = body.slice(body.length - 64);
        e.sha = sha;
        // 带上来的行照建块时的规矩再核：没有工具名、截屏工具的，一律不给路径（机器写的尾巴里不会有，
        // 有就是别处来的字）。
        if (e.tool === undefined) e.why = "notool";
        else if (isShotTool(e.tool)) e.why = "screenshot";
        else if (!segs) e.why = "unknown";
        else if (!env.exists(absFromSegments(segs, env))) e.why = "missing";
        else e.path = body;
        entries.push(e);
    }
    if (Number(head[1]) !== entries.length + capped + unlisted) return undefined;
    return { entries, capped, unlisted, mixed, text };
}

/** 并块时：这个子块的摘要里有没有代理存着像素的图（上游那行，或者它自己的尾巴就是分开说的那种）。 */
export function summaryHasRestorableImages(summary: string): boolean {
    return summary.includes(UPSTREAM_RESTORES_PIXELS_MARK) || summary.includes(HEAD_DECOMPRESS_MIXED);
}

// ---------- decompress({ imageRef }) 取不到时给路径 ----------

/** 一条消息里能给出路径的图（去重、按出现顺序），以及没留路径的有几张。`noPath`：跨块记下的
 *  「不留路径」编号（hostImageNoPathMap），这些编号也不给。 */
export function hostImagePathsOfMessage(m: CoreMessage, env: HostImagePathEnv, noPath?: ReadonlyMap<string, SkipWhy>): { paths: string[]; withoutPath: number } {
    const entries = hostImageEntries(m, env);
    const tainted = new Set([...hostImageTaintsOfEntries(entries).keys(), ...(noPath ? [...noPath].filter(([, w]) => isTaint(w)).map(([k]) => k) : [])]);
    const paths: string[] = [];
    let withoutPath = 0;
    for (const e of entries) {
        if (e.path !== undefined && !(e.sha !== undefined && tainted.has(e.sha))) {
            if (!paths.includes(e.path)) paths.push(e.path);
        } else withoutPath += 1;
    }
    return { paths, withoutPath };
}

/** decompress({ imageRef }) 失败、但认得出是宿主的文件图时给她的回执。开头保持
 *  `[decompress FAILED:`（失败的识别靠它）。 */
export function hostImageRestoreFailedText(ref: string, paths: readonly string[], withoutPath: number): string {
    const where = paths.length === 1 ? paths[0]! : `\n${paths.map((p, i) => `图${i + 1}：${p}`).join("\n")}`;
    const more = withoutPath > 0 ? `\n（这一条里另有 ${withoutPath} 张没留路径）` : "";
    return `[decompress FAILED: "${ref}" 这张图的像素不在代理这里（它现在是宿主那边的文件图），decompress 拿不回。宿主存着只读副本（可能缩过），要再看就用 read_image 读：${where}${more}]`;
}

// ---------- 计数 ----------

/** 会话 metadata 里的计数键（随会话落盘）。只有开关开着时才会出现。 */
export const HOST_IMAGE_PATHS_METADATA_KEY = "hostImagePaths";

interface HostImagePathCounts {
    /** 写了路径的行 */
    listed: number;
    /** 「同图k」行 */
    sameAs: number;
    /** 截屏、临时目录、副本不在、认不出：不留路径的行 */
    skippedTool: number;
    skippedTemp: number;
    missing: number;
    unknown: number;
    /** 没有工具名（配对不上 tool_use）、不留路径的行 */
    noTool: number;
    /** 从子块带上来的行 */
    carried: number;
    /** 超过一块上限、没列出来的张数 */
    capped: number;
    /** decompress({ imageRef }) 失败时给了路径 / 没给出路径 */
    decompressPaths: number;
    decompressNoPath: number;
    lastAt?: string;
}

const COUNT_KEYS = ["listed", "sameAs", "skippedTool", "skippedTemp", "missing", "unknown", "noTool", "carried", "capped", "decompressPaths", "decompressNoPath"] as const;

function readCounts(session: { metadata?: Record<string, unknown> }): HostImagePathCounts {
    const raw = session.metadata?.[HOST_IMAGE_PATHS_METADATA_KEY];
    const r = isObj(raw) ? raw : {};
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const out = Object.fromEntries(COUNT_KEYS.map((k) => [k, n(r[k])])) as unknown as HostImagePathCounts;
    if (typeof r.lastAt === "string") out.lastAt = r.lastAt;
    return out;
}

/** 加一组计数，返回加完的。 */
export function noteHostImagePaths(session: { metadata?: Record<string, unknown> }, delta: Partial<Record<(typeof COUNT_KEYS)[number], number>>): HostImagePathCounts {
    const next = readCounts(session);
    for (const k of COUNT_KEYS) next[k] += delta[k] ?? 0;
    next.lastAt = new Date().toISOString();
    (session.metadata ?? (session.metadata = {}))[HOST_IMAGE_PATHS_METADATA_KEY] = next;
    return next;
}

/** 一次建块里尾巴的计数（tally 是渲染统计；carried 是带上来的行数）。 */
export function tallyToDelta(t: RenderTally, carried: number): Partial<Record<(typeof COUNT_KEYS)[number], number>> {
    return { listed: t.listed, sameAs: t.sameAs, skippedTool: t.screenshot, skippedTemp: t.temp, missing: t.missing, unknown: t.unknown, noTool: t.notool, carried, capped: t.capped };
}
