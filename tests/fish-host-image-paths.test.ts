// fork（养成向）：文件图折起时留「图片路径」占位（compress.foldHostFileImagePaths，只在
// foldHostFileImages 也开着时起作用）。设计：fish-dsh 工作区 sessionless/w/fold-image-placeholder/DESIGN.md。
//
// 守的几条（每条下面都有测试）：
//   - 路径只从宿主每张图前面的 handle 文字里取，写成 `~/…/attachments/v1/objects/xx/<64 位>`：
//     没有盘符、没有家目录的绝对写法、没有系统用户名；
//   - 截屏（mcp__wincu__）、read_image 读临时目录里的文件、副本不在、认不出的，不留路径，照实写原因；
//   - 尾巴的字逐字固定；一块最多 16 行；并块时把子块的尾巴带上来（只认摘要最末尾那段）；
//   - compress 回执附上同一段，指纹的 head/tail 按去掉尾巴的摘要取；
//   - 不开路径开关时，尾巴、回执和 088df7d 一样（逐字节对 088df7d 的比较在工作区的 A/B 里）；
//   - 块编号、消息编号不随开关变；建块以后连续两次出站逐字节相同；
//   - decompress({ imageRef }) 取不到宿主的文件图时给路径；
//   - 占位里的路径按 DSH fs-local 的规则（rc.3 源码里的 expandHomePrefix / localDisplayPath，
//     加 read_image 认文件头的 sniffImageMediaType）在临时家目录里真的读得到。
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const { createCore, defaultConfig } = await import("acp-kernel");
type Config = import("acp-kernel").Config;
type CoreMessage = import("acp-kernel").CoreMessage;
const { anthropicToCore } = await import("acp-kernel/wire");
const { hostHeldFoldNote } = await import("../src/image-note.ts");
const {
    HOST_IMAGE_PATH_MAX_LINES, HOST_IMAGE_PATHS_METADATA_KEY, HOST_IMAGE_NO_PATH_MAX, HOST_IMAGE_NO_PATH_METADATA_KEY,
    hostImageEntries, hostImageNoPathMap, hostImagePathEnv, hostImagePathsOn,
    hostImagePathsOfMessage, hostImageRestoreFailedText, parseHostImagePathNote, rememberHostImageNoPath, renderHostImagePathNote,
} = await import("../src/host-image-paths.ts");
type HostImagePathEnv = import("../src/host-image-paths.ts").HostImagePathEnv;
const { executeProxyToolAsync } = await import("../src/loop/core.ts");
const { createSession, listSessions } = await import("../src/session.ts");
const { parseCompressSettings, sanitizeSessionCompressOverride } = await import("../src/config.ts");
const { applySessionCompressOverride, resolveRequestConfig, resolveSessionCompressOverride } = await import("../src/compress-settings.ts");
const { summaryFingerprintLine } = await import("../src/stream.ts");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
type ProxyOptions = import("../src/config.ts").ProxyOptions;

// ---------- 假的 handle、假的工具结果 ----------

const shaOf = (label: string): string => createHash("sha256").update(label).digest("hex");
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const PNG_B64 = PNG_1X1.toString("base64");

/** DSH content.ts requestImageHandleText 的样子（有 / 没有名字，有 / 没有 Normalized copy 段）。 */
function handleText(sha: string, hostPath: string | undefined, name?: string): string {
    const identity = name === undefined ? `sha256:${sha}` : `${JSON.stringify(name)} (sha256:${sha})`;
    const preview = `Image ${identity}; request preview 64x64px.`;
    if (hostPath === undefined) return `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`;
    return `${preview} Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(hostPath)} (64x64px, image/png). Source dimensions, format, and byte size may differ. Copy to a writable path ending in .png before editing.`;
}
/** read_image 的结果头（tool-fs read-image.ts formatImageReadOutput）。 */
const envelope = (p: string) => `<path>${p}</path>\n<type>image</type>\n<content>\nimage/png image, 64x64 px, 120 bytes\n</content>`;
const objWin = (home: string, sha: string) => `${home}\\.dsh\\attachments\\v1\\objects\\${sha.slice(0, 2)}\\${sha}`;
const tilde = (sha: string) => `~/.dsh/attachments/v1/objects/${sha.slice(0, 2)}/${sha}`;
const fileImg = (id: string) => ({ type: "image", source: { type: "file", file_id: id } });
const b64Img = () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } });

function trCore(tool: string, content: unknown[]): CoreMessage {
    const body = { messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_t", name: tool, input: { path: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t", content }] },
    ] };
    const tr = anthropicToCore(body as never).msgs.find((m) => m.contentType === "tool-result");
    assert.ok(tr);
    return tr as CoreMessage;
}

const HOME = "C:\\Users\\User";
const TEMP = "C:\\Users\\User\\AppData\\Local\\Temp";
function fakeEnv(present: readonly string[], home = HOME): HostImagePathEnv {
    const set = new Set(present.map((p) => p.toLowerCase()));
    return { home, tempRoots: [TEMP], exists: (p) => set.has(p.toLowerCase()), win: true };
}

/** 摘要至少 50 字（内核的 minSummaryLength）。 */
const PAD = "这几张图她都看过，聊了几句，没有要接着办的事；以后要再看哪张，照块尾巴里的路径读，读不到就算了。";
const SHA_A = shaOf("a"), SHA_B = shaOf("b"), SHA_C = shaOf("c"), SHA_S = shaOf("screen"), SHA_T = shaOf("temp");

// ---------- T1 handle 解析 ----------

test("T1 handle：有名字 / 没名字 / 名字里有引号和反斜杠 / 正斜杠写法，都认成 ~/ 路径；没有 Normalized copy 段、不在家目录、家目录大小写不同、结构不对、编号对不上、有 .. 的都不留路径", () => {
    const env = fakeEnv([objWin(HOME, SHA_A)]);
    const one = (text: string, tool = "bili_humanism_read") => hostImageEntries(trCore(tool, [{ type: "text", text }, fileImg("file-1")]), env)[0]!;
    assert.deepEqual(one(handleText(SHA_A, objWin(HOME, SHA_A))), { tool: "bili_humanism_read", sha: SHA_A, path: tilde(SHA_A) }, "没名字");
    assert.equal(one(handleText(SHA_A, objWin(HOME, SHA_A), "a1b2c3d4e5.png")).path, tilde(SHA_A), "有名字");
    assert.equal(one(handleText(SHA_A, objWin(HOME, SHA_A), 'x "quoted" \\ back.png')).path, tilde(SHA_A), "名字里有引号和反斜杠");
    assert.equal(one(handleText(SHA_A, objWin(HOME, SHA_A).replaceAll("\\", "/"))).path, tilde(SHA_A), "正斜杠写法");
    assert.equal(one(handleText(SHA_A, objWin("c:\\users\\user", SHA_A))).path, tilde(SHA_A), "家目录大小写不同（Windows 不分大小写）");
    assert.deepEqual(one(handleText(SHA_A, undefined)), { tool: "bili_humanism_read", sha: SHA_A, why: "unknown" }, "没有 Normalized copy 段");
    assert.equal(one(handleText(SHA_A, objWin("D:\\dsh-home", SHA_A))).why, "unknown", "不在家目录下");
    assert.equal(one(handleText(SHA_A, objWin("C:\\Users\\Guest", SHA_A))).why, "unknown", "别人的家目录");
    assert.equal(one(handleText(SHA_A, `${HOME}\\.dsh\\attachments\\v2\\objects\\${SHA_A.slice(0, 2)}\\${SHA_A}`)).why, "unknown", "目录结构不对");
    assert.equal(one(handleText(SHA_A, `${HOME}\\.dsh\\attachments\\v1\\objects\\ff\\${SHA_A}`)).why, "unknown", "前两位对不上");
    assert.equal(one(handleText(SHA_A, objWin(HOME, SHA_B))).why, "unknown", "文件名和 handle 里的编号不一致");
    assert.equal(one(handleText(SHA_A, `${HOME}\\x\\..\\.dsh\\attachments\\v1\\objects\\${SHA_A.slice(0, 2)}\\${SHA_A}`)).why, "unknown", "相对部分有 ..");
    assert.equal(one(handleText(SHA_A, `${HOME}\\User-dsh\\attachments\\v1\\objects\\${SHA_A.slice(0, 2)}\\${SHA_A}`)).why, "unknown", "附件库以上那几段里带用户名");
    assert.equal(one(`前面有字 ${handleText(SHA_A, objWin(HOME, SHA_A))}`).why, "unknown", "handle 必须在那一块的开头");
    assert.equal(one("随便一段字").why, "unknown", "前一块不是 handle");
    const noPrev = hostImageEntries(trCore("bili_humanism_read", [fileImg("file-1")]), env)[0]!;
    assert.deepEqual(noPrev, { tool: "bili_humanism_read", why: "unknown" }, "前面没有文字块");
    // 不是工具结果、没有图：空
    assert.deepEqual(hostImageEntries({ id: "x", role: "user", contentType: "text", text: "hi" } as CoreMessage, env), []);
    assert.deepEqual(hostImageEntries(trCore("read_image", [{ type: "text", text: "只有字" }]), env), []);
});

// ---------- T2 跳过 ----------

test("T2 跳过：wincu 截屏、read_image 读临时目录、read_image 认不出结果头、副本不在，都不留路径；base64 的图也列", () => {
    const env = fakeEnv([objWin(HOME, SHA_A), objWin(HOME, SHA_S), objWin(HOME, SHA_T)]);
    const shot = hostImageEntries(trCore("mcp__wincu__windows_computer_use_screenshot", [{ type: "text", text: handleText(SHA_S, objWin(HOME, SHA_S)) }, fileImg("f")]), env);
    assert.deepEqual(shot, [{ tool: "mcp__wincu__windows_computer_use_screenshot", sha: SHA_S, why: "screenshot" }]);
    const temp = hostImageEntries(trCore("read_image", [{ type: "text", text: envelope(`${TEMP}\\wincu-shot-1.png`) }, { type: "text", text: handleText(SHA_T, objWin(HOME, SHA_T)) }, fileImg("f")]), env);
    assert.deepEqual(temp, [{ tool: "read_image", sha: SHA_T, why: "temp" }]);
    const tempLower = hostImageEntries(trCore("read_image", [{ type: "text", text: envelope(`${TEMP.toLowerCase()}/x.png`) }, { type: "text", text: handleText(SHA_T, objWin(HOME, SHA_T)) }, fileImg("f")]), env);
    assert.equal(tempLower[0]!.why, "temp", "临时目录不分大小写、正斜杠也认");
    const noEnvelope = hostImageEntries(trCore("read_image", [{ type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, fileImg("f")]), env);
    assert.equal(noEnvelope[0]!.why, "unknown", "read_image 认不出结果头：偏严，不留");
    const ok = hostImageEntries(trCore("read_image", [{ type: "text", text: envelope(`${HOME}\\.dsh\\media\\onebot\\abc`) }, { type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, fileImg("f")]), env);
    assert.deepEqual(ok, [{ tool: "read_image", sha: SHA_A, path: tilde(SHA_A) }], "原文件在 onebot 媒体目录：给的是附件库副本的路径，不是原文件");
    const gone = hostImageEntries(trCore("read_image", [{ type: "text", text: envelope("D:\\pics\\x.png") }, { type: "text", text: handleText(SHA_B, objWin(HOME, SHA_B)) }, fileImg("f")]), env);
    assert.equal(gone[0]!.why, "missing", "副本不在盘上");
    const b64 = hostImageEntries(trCore("bili_humanism_read", [{ type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, b64Img()]), env);
    assert.equal(b64[0]!.path, tilde(SHA_A), "base64 的图也列（5.6）");
    const url = hostImageEntries(trCore("bili_humanism_read", [{ type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, { type: "image", source: { type: "url", url: "https://example.com/a.png" } }]), env);
    assert.deepEqual(url, [], "网址来源的图不归这里管（上游照旧记网址）");
});

/** 配对的 tool_use 不在这一次请求里：内核不补工具名（kernel/src/wire/anthropic.ts 的 tool_result 那一支）。 */
function trCoreNoName(content: unknown[]): CoreMessage {
    const body = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_orphan", content }] }] };
    const tr = anthropicToCore(body as never).msgs.find((m) => m.contentType === "tool-result");
    assert.ok(tr);
    assert.equal((tr as { toolName?: string }).toolName, undefined, "前提：消息上没有工具名");
    return tr as CoreMessage;
}

test("T2（B1）隐私那几道偏严：没有工具名一律不留；结果头在临时目录不管哪个工具都不留；截屏文件名、.dsh-watch- 不管在哪都不留", () => {
    const env = fakeEnv([objWin(HOME, SHA_A), objWin(HOME, SHA_S), objWin(HOME, SHA_T)]);
    const h = (sha: string, name?: string) => ({ type: "text", text: handleText(sha, objWin(HOME, sha), name) });
    // 1. 没有工具名：附件库路径样样都对，也不留
    const plain = hostImageEntries(trCoreNoName([h(SHA_A), fileImg("f")]), env);
    assert.deepEqual(plain, [{ sha: SHA_A, why: "notool" }], "没有工具名：不留路径");
    const plainB64 = hostImageEntries(trCoreNoName([h(SHA_A), b64Img()]), env);
    assert.deepEqual(plainB64, [{ sha: SHA_A, why: "notool" }], "base64 的也一样");
    assert.deepEqual(hostImagePathsOfMessage(trCoreNoName([h(SHA_A), fileImg("f")]), env), { paths: [], withoutPath: 1 }, "decompress({ imageRef }) 那条路也不给");
    // 复核探针的两种（review-probes/probe-noname.mts）：没名字的 wincu 截屏结果、没名字的 read_image 读临时目录里的截屏
    assert.deepEqual(hostImageEntries(trCoreNoName([h(SHA_S), fileImg("f")]), env), [{ sha: SHA_S, why: "notool" }], "没名字的截屏结果");
    const tempShotNoName = hostImageEntries(trCoreNoName([{ type: "text", text: envelope(`${TEMP}\\windows-computer-use-1.png`) }, h(SHA_S), fileImg("f")]), env);
    assert.deepEqual(tempShotNoName, [{ sha: SHA_S, why: "screenshot" }], "没名字、结果头是临时目录里的截屏：按截屏算（会污染同一编号）");
    const tempNoName = hostImageEntries(trCoreNoName([{ type: "text", text: envelope(`${TEMP}\\x.png`) }, h(SHA_T), fileImg("f")]), env);
    assert.deepEqual(tempNoName, [{ sha: SHA_T, why: "temp" }], "没名字、结果头在临时目录");
    // 2. 结果头在临时目录：不是 read_image 也不留
    const otherTemp = hostImageEntries(trCore("bili_humanism_frames", [{ type: "text", text: envelope(`${TEMP}\\frame-1.png`) }, h(SHA_T), fileImg("f")]), env);
    assert.deepEqual(otherTemp, [{ tool: "bili_humanism_frames", sha: SHA_T, why: "temp" }], "别的工具的结果头在临时目录");
    // 结果头的路径没法和临时目录比（复核探针 tempShort 那种）：认不出，不留
    const oddEnvelopes: [string, string][] = [
        ["8.3 短名的临时目录", "C:\\Users\\USER~1\\AppData\\Local\\Temp\\x.png"],
        ["\\\\?\\ 开头", `\\\\?\\${TEMP}\\x.png`],
        ["UNC", "\\\\localhost\\c$\\Users\\User\\AppData\\Local\\Temp\\x.png"],
        ["带 ..", `${HOME}\\Documents\\..\\AppData\\Local\\Temp\\x.png`],
        ["相对路径", "x.png"],
    ];
    for (const [what, p] of oddEnvelopes) {
        assert.deepEqual(hostImageEntries(trCore("read_image", [{ type: "text", text: envelope(p) }, h(SHA_A), fileImg("f")]), env), [{ tool: "read_image", sha: SHA_A, why: "unknown" }], what);
    }
    // 3. 截屏文件名 / .dsh-watch-：不管哪个工具、哪个目录
    const shotCases: [string, string][] = [
        ["临时目录以外的 wincu 截屏名", "D:\\shots\\windows-computer-use-2.png"],
        ["wcu-wgc 截屏名", "D:\\shots\\wcu-wgc-17.png"],
        ["大写也认", "D:\\SHOTS\\WINDOWS-COMPUTER-USE-3.PNG"],
        ["不是 .png 也认", "D:\\shots\\windows-computer-use-4.jpg"],
        ["浏览器截屏目录", `${HOME}\\dsh-wcu-browser-screenshots\\a.png`],
        [".dsh-watch- 目录", `${HOME}\\.dsh-watch-eyes\\last.png`],
    ];
    for (const [what, p] of shotCases) {
        const e = hostImageEntries(trCore("read_image", [{ type: "text", text: envelope(p) }, h(SHA_A), fileImg("f")]), env);
        assert.deepEqual(e, [{ tool: "read_image", sha: SHA_A, why: "screenshot" }], what);
    }
    const byName = hostImageEntries(trCore("bili_humanism_read", [h(SHA_A, "windows-computer-use-5.png"), fileImg("f")]), env);
    assert.deepEqual(byName, [{ tool: "bili_humanism_read", sha: SHA_A, why: "screenshot" }], "handle 里的图名像截屏（没有结果头的工具）");
    const byText = hostImageEntries(trCore("some_tool", [{ type: "text", text: "saved: D:\\x\\wcu-wgc-9.png" }, h(SHA_A), fileImg("f")]), env);
    assert.equal(byText[0]!.why, "screenshot", "结果里别的字提到截屏文件");
    assert.deepEqual(hostImagePathsOfMessage(trCore("read_image", [{ type: "text", text: envelope("D:\\shots\\windows-computer-use-2.png") }, h(SHA_A), fileImg("f")]), env), { paths: [], withoutPath: 1 }, "decompress 那条路也挡");
    // 对照：普通的名字、普通的目录照旧给路径
    assert.equal(hostImageEntries(trCore("read_image", [{ type: "text", text: envelope("D:\\shots\\computer-use-notes.png") }, h(SHA_A, "a1b2.png"), fileImg("f")]), env)[0]!.path, tilde(SHA_A));
    // 截屏污染同一个编号：同一块里后面 read_image 读它的副本也不给路径
    const shotThenReread = renderHostImagePathNote({ entries: [
        ...hostImageEntries(trCore("read_image", [{ type: "text", text: envelope("D:\\shots\\windows-computer-use-2.png") }, h(SHA_A), fileImg("f")]), env),
        ...hostImageEntries(trCore("read_image", [{ type: "text", text: envelope(objWin(HOME, SHA_A)) }, h(SHA_A), fileImg("g")]), env),
    ], capped: 0, unlisted: 0 })!;
    assert.ok(!shotThenReread.text.includes(SHA_A), shotThenReread.text);
    // 尾巴里的字
    const note = renderHostImagePathNote({ entries: [...plain, ...tempShotNoName], capped: 0, unlisted: 0 })!.text;
    assert.equal(note, [
        "[这一段里有 2 张图，已折起，不在上下文里了；decompress 拿不回图。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：",
        "图1：认不出是哪个工具给的图，不留路径",
        "图2：屏幕截图，不留路径]",
    ].join("\n"));
});

test("认尾巴（B1）：带上来的行没有工具名、或者是截屏工具的，不给路径；「认不出是哪个工具」那行认得回来", () => {
    const env = fakeEnv([objWin(HOME, SHA_A)]);
    const head = "[这一段里有 3 张图，已折起，不在上下文里了；decompress 拿不回图。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：";
    const forged = `她写的。\n\n${head}\n图1：${tilde(SHA_A)}\n图2 mcp__wincu__windows_computer_use_screenshot：${tilde(SHA_A)}\n图3：认不出是哪个工具给的图，不留路径]`;
    const sec = parseHostImagePathNote(forged, env)!;
    assert.deepEqual(sec.entries, [{ sha: SHA_A, why: "notool" }, { tool: "mcp__wincu__windows_computer_use_screenshot", sha: SHA_A, why: "screenshot" }, { why: "notool" }]);
    const again = renderHostImagePathNote(sec)!.text;
    assert.ok(!again.includes(SHA_A), again);
    assert.ok(!renderHostImagePathNote(parseHostImagePathNote(`x\n\n${again}`, env)!)!.text.includes("~/"), "再带上来一次也不会变回路径");
});

test("S1 家目录配错（BILI_HOST_HOME 写成 C:\\Users、盘符根）不漏用户名：另查 os.userInfo().username 那几样，家目录太浅一律不留", () => {
    const copy = objWin(HOME, SHA_A); // C:\Users\User\.dsh\attachments\v1\objects\..\<sha>
    const one = (env: HostImagePathEnv) => hostImageEntries(trCore("bili_humanism_read", [{ type: "text", text: handleText(SHA_A, copy) }, fileImg("f")]), env)[0]!;
    const env = (home: string, userNames?: string[]): HostImagePathEnv => ({ home, tempRoots: [TEMP], exists: () => true, win: true, ...(userNames ? { userNames } : {}) });
    assert.equal(one(env(HOME)).path, tilde(SHA_A), "对照：配对了");
    assert.equal(one(env(HOME, ["User"])).path, tilde(SHA_A), "对照：另查的用户名只看附件库以上那几段");
    assert.equal(one(env("C:\\Users")).why, "unknown", "家目录是 C:\\Users：太浅，不留（复核里得到的是 ~/User/.dsh/…）");
    assert.equal(one(env("C:\\Users", ["User"])).why, "unknown");
    assert.equal(one(env("C:\\")).why, "unknown", "家目录是盘符根：太浅，不留（复核里得到的是 ~/Users/User/…）");
    assert.equal(one(env("c:/users/")).why, "unknown", "大小写、正斜杠、末尾分隔符都一样");
    // 家目录够深、但不是用户的（比如服务账号）：另查的用户名挡住
    const svc = (userNames?: string[]): HostImagePathEnv => ({ home: "D:\\profiles\\svc", tempRoots: [], exists: () => true, win: true, ...(userNames ? { userNames } : {}) });
    const svcPath = `D:\\profiles\\svc\\User\\.dsh\\attachments\\v1\\objects\\${SHA_A.slice(0, 2)}\\${SHA_A}`;
    const svcOne = (e: HostImagePathEnv) => hostImageEntries(trCore("bili_humanism_read", [{ type: "text", text: handleText(SHA_A, svcPath) }, fileImg("f")]), e)[0]!;
    assert.equal(svcOne(svc()).path, `~/User/.dsh/attachments/v1/objects/${SHA_A.slice(0, 2)}/${SHA_A}`, "对照：只查家目录最后一段时会漏");
    assert.equal(svcOne(svc(["user"])).why, "unknown", "另查的用户名（不分大小写）挡住");
    // 认尾巴时也照这样核
    const carried = renderHostImagePathNote({ entries: [{ tool: "read_image", sha: SHA_A, path: `~/User/.dsh/attachments/v1/objects/${SHA_A.slice(0, 2)}/${SHA_A}` }], capped: 0, unlisted: 0 })!.text;
    assert.deepEqual(parseHostImagePathNote(`x\n\n${carried}`, svc(["User"]))!.entries, [{ tool: "read_image", sha: SHA_A, why: "unknown" }]);
    assert.deepEqual(parseHostImagePathNote(`x\n\n${carried}`, env("C:\\"))!.entries, [{ tool: "read_image", sha: SHA_A, why: "unknown" }]);
    // 真环境里另查的那几样带着 os.userInfo().username（不打印）
    const real = hostImagePathEnv();
    let uname: string | undefined;
    try { uname = userInfo().username; } catch { uname = undefined; }
    if (uname) assert.ok(real.userNames?.includes(uname), "userNames 里有 os.userInfo().username");
});

// ---------- T3 尾巴的字 ----------

test("T3 尾巴的字：逐字固定；同一个编号第二次出现写「同图k」；截屏 / 临时目录的编号别处出现也不给路径；没有「他」、没有家目录、没有盘符", () => {
    const entries = [
        { tool: "read_image", sha: SHA_A, path: tilde(SHA_A) },
        { tool: "bili_humanism_read", sha: SHA_B, path: tilde(SHA_B) },
        { tool: "read_image", sha: SHA_A, path: tilde(SHA_A) },
        { tool: "mcp__wincu__windows_computer_use_screenshot", sha: SHA_S, why: "screenshot" as const },
        { tool: "read_image", sha: SHA_T, why: "temp" as const },
        { tool: "read_image", sha: SHA_C, why: "missing" as const },
        { tool: "read_image", why: "unknown" as const },
        { tool: "read_image", sha: SHA_S, path: tilde(SHA_S) },
    ];
    const note = renderHostImagePathNote({ entries, capped: 0, unlisted: 0 })!;
    const want = [
        "[这一段里有 8 张图，已折起，不在上下文里了；decompress 拿不回图。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：",
        `图1 read_image：${tilde(SHA_A)}`,
        `图2 bili_humanism_read：${tilde(SHA_B)}`,
        "图3 read_image：同图1",
        "图4 mcp__wincu__windows_computer_use_screenshot：屏幕截图，不留路径",
        "图5 read_image：读的是临时目录里的文件，不留路径",
        "图6 read_image：宿主的副本已经不在了，看不回来了",
        "图7 read_image：认不出宿主把副本放在哪，不留路径",
        "图8 read_image：同图4]",
    ].join("\n");
    assert.equal(note.text, want);
    assert.deepEqual(note.tally, { listed: 2, sameAs: 2, screenshot: 1, temp: 1, missing: 1, unknown: 1, notool: 0, capped: 0, unlisted: 0 });
    for (const bad of ["他", "C:", "Users", "User", "\\", "file-", "restores pixels", "无损", "还在上下文"]) assert.ok(!note.text.includes(bad), `不该有「${bad}」`);
    assert.match(note.text, /已折起，不在上下文里了/);
    assert.match(note.text, /decompress 拿不回图/);
    // 截屏的编号先以有路径的样子出现、后来才在截屏里出现：也不给路径
    const later = renderHostImagePathNote({ entries: [{ tool: "read_image", sha: SHA_S, path: tilde(SHA_S) }, { tool: "mcp__wincu__x", sha: SHA_S, why: "screenshot" }], capped: 0, unlisted: 0 })!;
    assert.ok(!later.text.includes(SHA_S), later.text);
    // 没有工具名的行：就算带着路径也不给（B1，渲染这一道再兜一次）
    const noTool = renderHostImagePathNote({ entries: [{ sha: SHA_A, path: tilde(SHA_A) }], capped: 0, unlisted: 0 })!;
    assert.match(noTool.text, /\n图1：认不出是哪个工具给的图，不留路径\]$/);
    assert.ok(!noTool.text.includes(SHA_A));
    assert.equal(noTool.tally.notool, 1);
    assert.equal(renderHostImagePathNote({ entries: [], capped: 0, unlisted: 0 }), undefined, "一张都没有：不加尾巴");
});

test("T3 上限：超过 16 行留最新的 16 行，最后一行照实写少了几张；能原样认回来", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ tool: "read_image", sha: shaOf(`n${i}`), path: tilde(shaOf(`n${i}`)) }));
    const note = renderHostImagePathNote({ entries, capped: 0, unlisted: 0 })!;
    assert.equal(HOST_IMAGE_PATH_MAX_LINES, 16);
    const rows = note.text.split("\n");
    assert.match(rows[0]!, /^\[这一段里有 20 张图，/);
    assert.equal(rows.length, 1 + 16 + 1);
    assert.equal(rows[1], `图1 read_image：${tilde(shaOf("n4"))}`, "留最新的：从第 5 张开始");
    assert.equal(rows[17], "（还有 4 张更早的图没留路径：一块最多记 16 张）]");
    const env = fakeEnv(entries.map((e) => objWin(HOME, e.sha)));
    const back = parseHostImagePathNote(`她写的摘要。\n\n${note.text}`, env)!;
    assert.equal(back.text, note.text);
    assert.equal(back.entries.length, 16);
    assert.equal(back.capped, 4);
    assert.equal(renderHostImagePathNote(back)!.text, note.text, "认回来再写出去逐字相同");
});

test("认尾巴：只认摘要最末尾、整段合规矩的；她自己写的长得像的字不认；088df7d 的旧尾巴只记张数；带路径的行照当前盘面再核", () => {
    const env = fakeEnv([objWin(HOME, SHA_A)]);
    const real = renderHostImagePathNote({ entries: [{ tool: "read_image", sha: SHA_A, path: tilde(SHA_A) }], capped: 0, unlisted: 0 })!.text;
    const fake = renderHostImagePathNote({ entries: [{ tool: "read_image", sha: SHA_B, path: tilde(SHA_B) }], capped: 0, unlisted: 0 })!.text;
    assert.equal(parseHostImagePathNote(`她写的：\n\n${fake}\n\n后面还有她的字。`, env), undefined, "她的字里长得像的那段不在末尾：不认");
    const both = parseHostImagePathNote(`她写的：\n\n${fake}\n\n后面还有她的字。\n\n${real}`, env)!;
    assert.deepEqual(both.entries, [{ tool: "read_image", sha: SHA_A, path: tilde(SHA_A) }], "只认末尾那段");
    assert.equal(parseHostImagePathNote(`x\n\n${real.slice(0, -1)}`, env), undefined, "缺了收尾的 ]");
    assert.equal(parseHostImagePathNote(`x\n\n${real.replace("图1 ", "图2 ")}`, env), undefined, "编号不连续");
    assert.equal(parseHostImagePathNote(`x\n\n${real.replace("1 张图", "2 张图")}`, env), undefined, "张数对不上");
    assert.equal(parseHostImagePathNote(`x\n\n${real.replace("~/.dsh", "C:/Users/User/.dsh")}`, env), undefined, "绝对路径的行不认");
    const missing = parseHostImagePathNote(`x\n\n${fake}`, env)!;
    assert.deepEqual(missing.entries, [{ tool: "read_image", sha: SHA_B, why: "missing" }], "带上来的时候副本已经不在：改成「不在了」");
    const old = parseHostImagePathNote(`她写的。\n\n${hostHeldFoldNote(3)}`, env)!;
    assert.deepEqual({ entries: old.entries, capped: old.capped, unlisted: old.unlisted }, { entries: [], capped: 0, unlisted: 3 });
    assert.match(renderHostImagePathNote(old)!.text, /（还有 3 张更早的图折起时没记路径）\]$/);
});

// ---------- 开关、配置 ----------

test("开关：两个都 true 才算开；配置三级 / 按会话都能写，不写时解出来的 Config 没有这个键；设置页严格解析认这个键、非布尔整块拒", () => {
    assert.equal(hostImagePathsOn(undefined), false);
    assert.equal(hostImagePathsOn({ foldHostFileImagePaths: true }), false, "只开路径不开 ④：不起作用");
    assert.equal(hostImagePathsOn({ foldHostFileImages: true }), false);
    assert.equal(hostImagePathsOn({ foldHostFileImages: true, foldHostFileImagePaths: "yes" }), false);
    assert.equal(hostImagePathsOn({ foldHostFileImages: true, foldHostFileImagePaths: true }), true);
    const base = defaultConfig(200_000);
    const plain = resolveRequestConfig(base, {}, undefined, "m", 200_000, { nudgeGrowthTokens: 50_000 });
    assert.equal("foldHostFileImagePaths" in plain, false, "不写：键都不在");
    const withFold = resolveRequestConfig(base, {}, undefined, "m", 200_000, { foldHostFileImages: true });
    assert.equal("foldHostFileImagePaths" in withFold, false, "只开 ④：键也不在（和 088df7d 开 ④ 一样）");
    assert.equal(resolveRequestConfig(base, {}, undefined, "m", 200_000, { foldHostFileImagePaths: true }).foldHostFileImagePaths, true);
    assert.equal(parseCompressSettings({ foldHostFileImagePaths: true })?.foldHostFileImagePaths, true);
    assert.equal(parseCompressSettings({ foldHostFileImagePaths: "on" }), undefined);
    const table = { sessions: { "session-her": { foldHostFileImages: true, foldHostFileImagePaths: true } } };
    const her = resolveSessionCompressOverride(table, ["session-her", undefined]);
    assert.deepEqual(her?.override, { foldHostFileImages: true, foldHostFileImagePaths: true });
    const applied = applySessionCompressOverride(plain, her!.override, 200_000) as Config & { foldHostFileImagePaths?: boolean };
    assert.equal(applied.foldHostFileImagePaths, true);
    assert.equal(hostImagePathsOn(applied), true);
    assert.equal(resolveSessionCompressOverride(table, ["session-helper", "session-helper"]), undefined, "帮手对不上");
    assert.deepEqual(parseCompressSettings({ sessions: { s1: { foldHostFileImagePaths: true } } })?.sessions, { s1: { foldHostFileImagePaths: true } });
    assert.equal(parseCompressSettings({ sessions: { s1: { foldHostFileImagePaths: 1 } } }), undefined);
    assert.deepEqual(sanitizeSessionCompressOverride({ foldHostFileImagePaths: "x" }).problems, ["foldHostFileImagePaths must be a boolean"]);
});

test("真环境：家目录取 BILI_HOST_HOME 或 os.homedir()；临时目录含 TEMP/TMP", () => {
    const saved = process.env.BILI_HOST_HOME;
    try {
        delete process.env.BILI_HOST_HOME;
        const e1 = hostImagePathEnv();
        assert.ok(e1.home.length > 0);
        assert.ok(e1.tempRoots.length >= 1);
        process.env.BILI_HOST_HOME = "D:\\elsewhere\\home";
        assert.equal(hostImagePathEnv().home, "D:\\elsewhere\\home");
    } finally {
        if (saved === undefined) delete process.env.BILI_HOST_HOME; else process.env.BILI_HOST_HOME = saved;
    }
});

// ---------- 走真的 compress（applyRanges）：尾巴、回执、带上来、编号 ----------

/** 临时家目录：附件库里放真的 PNG 字节，文件名 = 字节的 sha256（和宿主附件库的做法一样）。 */
function makeHostHome(labels: readonly string[]): { home: string; shas: Record<string, string>; cleanup: () => void } {
    const home = mkdtempSync(path.join(tmpdir(), "imgpath-home-"));
    const shas: Record<string, string> = {};
    for (const label of labels) {
        const bytes = Buffer.concat([PNG_1X1, Buffer.from(`#${label}`)]);
        const sha = createHash("sha256").update(bytes).digest("hex");
        shas[label] = sha;
        const dir = path.join(home, ".dsh", "attachments", "v1", "objects", sha.slice(0, 2));
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, sha), bytes);
    }
    return { home, shas, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const hostObj = (home: string, sha: string) => path.join(home, ".dsh", "attachments", "v1", "objects", sha.slice(0, 2), sha);

/** n 段「兔说一句 → 她 read_image → 她回一句」。第 i 段的图用 labels[i]；label 为 null 的段读的是临时目录里的文件；
 *  opts.b64 里的那几段的图是 base64 的（她走 Claude 时那样），别的是 file 图。 */
function imageHistory(home: string, shas: Record<string, string>, labels: readonly (string | null)[], opts: { gen?: string; tempDir?: string; b64?: readonly number[] } = {}) {
    const msgs: unknown[] = [];
    labels.forEach((label, i) => {
        msgs.push({ role: "user", content: [{ type: "text", text: `兔：第 ${i} 张，帮我看看。` + "背景说明。".repeat(30) }] });
        msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "read_image", input: { path: `p${i}.png` } }] });
        const sha = label === null ? shaOf(`temp-${i}`) : shas[label]!;
        const where = label === null ? path.join(opts.tempDir ?? tmpdir(), `shot-${i}.png`) : `D:\\media\\p${i}.png`;
        msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: [
            { type: "text", text: envelope(where) },
            { type: "text", text: handleText(sha, hostObj(home, sha)) },
            opts.b64?.includes(i) ? b64Img() : fileImg(`file-${opts.gen ?? "g1"}-${i}-xxxxxxxxxxxxxxxx`),
        ] }] });
        msgs.push({ role: "assistant", content: [{ type: "text", text: `看到了第 ${i} 张。` + "回话内容。".repeat(30) }] });
    });
    msgs.push({ role: "user", content: [{ type: "text", text: "兔：好，接着聊别的。" }] });
    return msgs;
}

function foldCtx(history: unknown[], flags: { fold?: boolean; paths?: boolean }) {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { foldHostFileImages?: boolean; foldHostFileImagePaths?: boolean };
    if (flags.fold) config.foldHostFileImages = true;
    if (flags.paths) config.foldHostFileImagePaths = true;
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 50;
    const messages = anthropicToCore({ messages: history } as never).msgs as CoreMessage[];
    const session = createSession(`imgpath-${Math.random()}`, { protocol: "anthropic" });
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} };
}
/** 第 i 段（从 0 起）的头一条消息和最后一条消息的编号。 */
function segRefs(ctx: ReturnType<typeof foldCtx>, i: number): { start: string; end: string } {
    const refs = ctx.session.state.messageRefs.byRaw;
    const ids = ctx.messages.map((m) => m.id);
    // 每段 4 条线上消息 → 核心消息：user 文字、tool_use、tool_result、assistant 文字
    const start = refs[ids[i * 4]!]!;
    const end = refs[ids[i * 4 + 3]!]!;
    assert.ok(/^m\d+$/.test(start) && /^m\d+$/.test(end), `${start} ${end}`);
    return { start, end };
}
async function withHostHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env.BILI_HOST_HOME;
    process.env.BILI_HOST_HOME = home;
    try { return await fn(); } finally { if (saved === undefined) delete process.env.BILI_HOST_HOME; else process.env.BILI_HOST_HOME = saved; }
}

test("建块：开着路径时尾巴逐张列出 ~/ 路径（临时目录那张不留）；回执附同一段，指纹 tail 里没有路径；计数记进会话", async () => {
    const hh = makeHostHome(["a", "b"]);
    try {
        await withHostHome(hh.home, async () => {
            const ctx = foldCtx(imageHistory(hh.home, hh.shas, ["a", null, "b", "a"]), { fold: true, paths: true });
            const first = segRefs(ctx, 0), last = segRefs(ctx, 3);
            const her = "2026-11-16 · 兔发来四张图，她都看了。" + PAD;
            const r = await executeProxyToolAsync("compress", { content: `${first.start}–${last.end} 看图\n${her}` }, ctx as never);
            assert.equal(r.outcome, "applied", r.text);
            const block = ctx.session.state.blocks.find((b) => b.active)!;
            const want = [
                "[这一段里有 4 张图，已折起，不在上下文里了；decompress 拿不回图。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：",
                `图1 read_image：${tilde(hh.shas.a!)}`,
                "图2 read_image：读的是临时目录里的文件，不留路径",
                `图3 read_image：${tilde(hh.shas.b!)}`,
                "图4 read_image：同图1]",
            ].join("\n");
            assert.equal(block.summary, `${her}\n\n${want}`, "她的摘要 + 空行 + 尾巴（没有 088df7d 那句「原图在宿主那边」）");
            assert.ok(!block.summary.includes(hh.home) && !block.summary.includes(path.basename(hh.home)), "尾巴里没有家目录、没有家目录那一段的名字");
            assert.ok(r.text.includes(`\n${want}`), "回执里附上整段尾巴");
            const fp = r.text.split("\n").find((l) => l.includes(`${block.blockId} full summary`))!;
            assert.ok(fp.includes(`full summary ${block.summary.length}ch`), "指纹报整份存下的长度");
            assert.ok(!fp.includes("~/") && !fp.includes("objects"), `指纹的 head/tail 不露路径：${fp}`);
            assert.ok(fp.includes(her.slice(-20)), "tail 是她摘要的末尾");
            const counts = ctx.session.metadata?.[HOST_IMAGE_PATHS_METADATA_KEY] as Record<string, unknown>;
            assert.equal(counts.listed, 2);
            assert.equal(counts.sameAs, 1);
            assert.equal(counts.skippedTemp, 1);
            assert.deepEqual(ctx.session.metadata?.[HOST_IMAGE_NO_PATH_METADATA_KEY], { [shaOf("temp-1")]: "temp" }, "临时目录那张的编号记进会话（N4 / S2）");
        });
    } finally { hh.cleanup(); }
});

test("对照（不开路径）：只开 ④ 时尾巴还是 088df7d 那句「原图在宿主那边」、回执里没有路径、会话里没有计数键；块编号和消息编号和开路径时一样", async () => {
    const hh = makeHostHome(["a", "b"]);
    try {
        await withHostHome(hh.home, async () => {
            const run = async (paths: boolean) => {
                const ctx = foldCtx(imageHistory(hh.home, hh.shas, ["a", null, "b", "a"]), { fold: true, paths });
                const first = segRefs(ctx, 0), last = segRefs(ctx, 3);
                const r = await executeProxyToolAsync("compress", { content: `${first.start}–${last.end} 看图\n2026-11-16 · 兔发来四张图，她都看了。${PAD}` }, ctx as never);
                assert.equal(r.outcome, "applied", r.text);
                return { ctx, r, block: ctx.session.state.blocks.find((b) => b.active)! };
            };
            const off = await run(false);
            const on = await run(true);
            assert.ok(off.block.summary.endsWith(`\n\n${hostHeldFoldNote(4)}`), off.block.summary);
            assert.ok(!off.r.text.includes("read_image") && !off.r.text.includes("~/"));
            assert.equal(off.ctx.session.metadata?.[HOST_IMAGE_PATHS_METADATA_KEY], undefined);
            assert.equal(off.ctx.session.metadata?.[HOST_IMAGE_NO_PATH_METADATA_KEY], undefined, "不开路径：不记编号集合");
            assert.equal(on.block.blockId, off.block.blockId, "块编号不随开关变");
            assert.deepEqual(on.ctx.session.state.messageRefs, off.ctx.session.state.messageRefs, "消息编号不随开关变");
            assert.deepEqual(on.block.effectiveMessageIds, off.block.effectiveMessageIds);
            assert.deepEqual([...on.block.directMessageIds], [...off.block.directMessageIds]);
            // 回执：除了尾巴那几行和指纹，其余逐字相同
            const strip = (t: string, blockId: string) => t.split("\n").filter((l) => !l.includes(`${blockId} full summary`) && !/^(\[这一段里有|图\d)/.test(l)).join("\n");
            assert.equal(strip(on.r.text, on.block.blockId), strip(off.r.text, off.block.blockId));
        });
    } finally { hh.cleanup(); }
});

const MIXED_HEAD = (n: number) => `[这一段里有 ${n} 张图，已折起，不在上下文里了；写着 restores pixels、带 m 编号的那几张 decompress 也许还取得回，别的 decompress 拿不回。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：`;

test("B2 同一块里有 base64 和 file 图：上游那行「restores pixels」照旧在前，尾巴头一句分开说，两句不打架（逐字）", async () => {
    const hh = makeHostHome(["a", "b"]);
    try {
        await withHostHome(hh.home, async () => {
            const ctx = foldCtx(imageHistory(hh.home, hh.shas, ["a", "b"], { b64: [1] }), { fold: true, paths: true });
            const first = segRefs(ctx, 0), last = segRefs(ctx, 1);
            const her = "2026-11-16 · 兔发来两张图，她都看了。" + PAD;
            const r = await executeProxyToolAsync("compress", { content: `${first.start}–${last.end} 看图\n${her}` }, ctx as never);
            assert.equal(r.outcome, "applied", r.text);
            const block = ctx.session.state.blocks.find((b) => b.active)!;
            const b64Msg = ctx.messages.filter((m) => m.contentType === "tool-result")[1]!;
            const ref = ctx.session.state.messageRefs.byRaw[b64Msg.id]!;
            assert.match(ref, /^m\d+$/);
            const upstreamLine = `[folded images: [image: png 1x1 · ${ref}] — decompress({ imageRef }) restores pixels]`;
            const footer = [
                MIXED_HEAD(2),
                `图1 read_image：${tilde(hh.shas.a!)}`,
                `图2 read_image：${tilde(hh.shas.b!)}]`,
            ].join("\n");
            assert.equal(block.summary, `${her}\n\n${upstreamLine}\n\n${footer}`, "她的摘要 + 上游那行（原样）+ 分开说的尾巴");
            assert.ok(!footer.includes("decompress 拿不回图"), "不再整句说「decompress 拿不回图」");
            assert.ok(r.text.includes(`\n${footer}`), "回执里附的是同一段");
            // 认得回来、写出去逐字相同
            const sec = parseHostImagePathNote(block.summary, hostImagePathEnv())!;
            assert.equal(sec.mixed, true);
            assert.equal(sec.text, footer);
            assert.equal(renderHostImagePathNote(sec)!.text, footer);
        });
        // 对照：同样两段、都是 file 图 → 没有上游那行，头一句照旧整句说拿不回
        await withHostHome(hh.home, async () => {
            const ctx = foldCtx(imageHistory(hh.home, hh.shas, ["a", "b"]), { fold: true, paths: true });
            const r = await executeProxyToolAsync("compress", { content: `${segRefs(ctx, 0).start}–${segRefs(ctx, 1).end} 看图\n两张图她都看了。${PAD}` }, ctx as never);
            assert.equal(r.outcome, "applied", r.text);
            const s = ctx.session.state.blocks.find((b) => b.active)!.summary;
            assert.ok(!s.includes("restores pixels"), s);
            assert.match(s, /\n\n\[这一段里有 2 张图，已折起，不在上下文里了；decompress 拿不回图。宿主给每张图存了只读副本/);
        });
    } finally { hh.cleanup(); }
});

test("B2 并块：子块里有过 base64（上游那行、或分开说的头一句），并成的块头一句照样分开说", async () => {
    const hh = makeHostHome(["a", "b", "c", "d"]);
    try {
        await withHostHome(hh.home, async () => {
            const ctx = foldCtx(imageHistory(hh.home, hh.shas, ["a", "b", "c", "d"], { b64: [0] }), { fold: true, paths: true });
            const r1 = await executeProxyToolAsync("compress", { content: `${segRefs(ctx, 0).start}–${segRefs(ctx, 1).end} 前两张\n前两张图她都看了。${PAD}` }, ctx as never);
            assert.equal(r1.outcome, "applied", r1.text);
            const r2 = await executeProxyToolAsync("compress", { content: `${segRefs(ctx, 2).start}–${segRefs(ctx, 3).end} 后两张\n后两张图她都看了。${PAD}` }, ctx as never);
            assert.equal(r2.outcome, "applied", r2.text);
            const kids = ctx.session.state.blocks.filter((b) => b.active);
            assert.equal(kids.length, 2);
            const [k1, k2] = kids[0]!.summary.includes("restores pixels") ? [kids[0]!, kids[1]!] : [kids[1]!, kids[0]!];
            assert.ok(k1.summary.includes(`\n\n${MIXED_HEAD(2)}\n`), "有 base64 的子块：分开说");
            assert.ok(k2.summary.includes("\n\n[这一段里有 2 张图，已折起，不在上下文里了；decompress 拿不回图。"), "只有 file 图的子块：整句说拿不回");
            const r3 = await executeProxyToolAsync("compress", { content: `${kids[0]!.blockId}–${kids[1]!.blockId} 四张\n四张图的整理：她都看过了。${PAD}` }, ctx as never);
            assert.equal(r3.outcome, "applied", r3.text);
            const merged = ctx.session.state.blocks.find((b) => b.active)!;
            assert.ok(!merged.summary.includes("— decompress({ imageRef }) restores pixels]"), "上游那行不带上来（上游原来就不带）");
            const want = [
                MIXED_HEAD(4),
                `图1 read_image：${tilde(hh.shas.a!)}`,
                `图2 read_image：${tilde(hh.shas.b!)}`,
                `图3 read_image：${tilde(hh.shas.c!)}`,
                `图4 read_image：${tilde(hh.shas.d!)}]`,
            ].join("\n");
            assert.ok(merged.summary.endsWith(`\n\n${want}`), merged.summary.slice(-500));
            assert.ok(r3.text.includes(`\n${want}`));
        });
    } finally { hh.cleanup(); }
});

test("T4 并块：两个子块各 10 张 → 新块留最新 16 张、写少了 4 张；子块里她自己写的、长得像的行不收；088df7d 的旧尾巴记成「折起时没记路径」", async () => {
    const labels = Array.from({ length: 20 }, (_, i) => `x${i}`);
    const hh = makeHostHome(labels);
    try {
        await withHostHome(hh.home, async () => {
            const ctx = foldCtx(imageHistory(hh.home, hh.shas, labels), { fold: true, paths: true });
            const lookAlike = renderHostImagePathNote({ entries: [{ tool: "read_image", sha: shaOf("her-own"), path: tilde(shaOf("her-own")) }], capped: 0, unlisted: 0 })!.text;
            const a0 = segRefs(ctx, 0), a9 = segRefs(ctx, 9), b0 = segRefs(ctx, 10), b9 = segRefs(ctx, 19);
            const r1 = await executeProxyToolAsync("compress", { content: `${a0.start}–${a9.end} 前十张\n前十张图，她都看了。她抄了一段：\n\n${lookAlike}\n\n抄完了。` }, ctx as never);
            assert.equal(r1.outcome, "applied", r1.text);
            const r2 = await executeProxyToolAsync("compress", { content: `${b0.start}–${b9.end} 后十张\n后十张图，她都看了。${PAD}` }, ctx as never);
            assert.equal(r2.outcome, "applied", r2.text);
            const kids = ctx.session.state.blocks.filter((b) => b.active);
            assert.equal(kids.length, 2);
            for (const k of kids) assert.match(k.summary, /\n\n\[这一段里有 10 张图，/);
            const r3 = await executeProxyToolAsync("compress", { content: `${kids[0]!.blockId}–${kids[1]!.blockId} 二十张\n二十张图的整理：她都看过了。${PAD}` }, ctx as never);
            assert.equal(r3.outcome, "applied", r3.text);
            const merged = ctx.session.state.blocks.find((b) => b.active)!;
            assert.deepEqual([...merged.directBlockIds].sort(), kids.map((k) => k.blockId).sort(), "新块吃掉了两个子块");
            const sec = parseHostImagePathNote(merged.summary, hostImagePathEnv())!;
            assert.ok(sec, merged.summary.slice(-300));
            assert.equal(sec.entries.length, 16);
            assert.equal(sec.capped, 4);
            assert.deepEqual(sec.entries.map((e) => e.sha), labels.slice(4).map((l) => hh.shas[l]), "留最新的 16 张，顺序是子块在前");
            assert.ok(!merged.summary.includes(shaOf("her-own")), "子块里她自己抄的那段不收");
            assert.match(merged.summary, /\n（还有 4 张更早的图没留路径：一块最多记 16 张）\]$/);
            assert.match(r3.text, /（还有 4 张更早的图没留路径/, "回执里也有");
            const counts = ctx.session.metadata?.[HOST_IMAGE_PATHS_METADATA_KEY] as Record<string, number>;
            assert.equal(counts.carried, 20);
            assert.equal(counts.capped, 4);
        });
        // 088df7d 的旧尾巴（④ 开、路径没开时建的块）在开了路径以后被并：记张数
        await withHostHome(hh.home, async () => {
            const ctx = foldCtx(imageHistory(hh.home, hh.shas, labels.slice(0, 4)), { fold: true, paths: false });
            const s0 = segRefs(ctx, 0), s1 = segRefs(ctx, 1), s3 = segRefs(ctx, 3);
            const r1 = await executeProxyToolAsync("compress", { content: `${s0.start}–${s1.end} 前两张\n前两张图她看了。${PAD}` }, ctx as never);
            assert.equal(r1.outcome, "applied", r1.text);
            assert.ok(ctx.session.state.blocks.find((b) => b.active)!.summary.endsWith(hostHeldFoldNote(2)));
            ctx.config.foldHostFileImagePaths = true;
            const r2 = await executeProxyToolAsync("compress", { content: `${s0.start}–${s3.end} 四张\n四张图她都看了。${PAD}` }, ctx as never);
            assert.equal(r2.outcome, "applied", r2.text);
            const merged = ctx.session.state.blocks.find((b) => b.active)!;
            const want = [
                "[这一段里有 4 张图，已折起，不在上下文里了；decompress 拿不回图。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：",
                `图1 read_image：${tilde(hh.shas.x2!)}`,
                `图2 read_image：${tilde(hh.shas.x3!)}`,
                "（还有 2 张更早的图折起时没记路径）]",
            ].join("\n");
            assert.ok(merged.summary.endsWith(`\n\n${want}`), merged.summary.slice(-400));
        });
    } finally { hh.cleanup(); }
});

test("T8 decompress({ imageRef })：开着路径时，宿主文件图的编号回执给 ~/ 路径；不开路径时照 088df7d 开 ④ 的原话", async () => {
    const hh = makeHostHome(["a"]);
    try {
        await withHostHome(hh.home, async () => {
            const history = imageHistory(hh.home, hh.shas, ["a"]);
            const make = (paths: boolean) => {
                const ctx = foldCtx(history, { fold: true, paths });
                (ctx.session as { incomingImageIndex?: Map<string, unknown[]> }).incomingImageIndex = new Map();
                return ctx;
            };
            const on = make(true);
            const trId = on.messages.find((m) => m.contentType === "tool-result")!.id;
            const ref = on.session.state.messageRefs.byRaw[trId]!;
            assert.match(ref, /^m\d+$/);
            const r = await executeProxyToolAsync("decompress", { imageRef: ref }, { ...on, compressMessages: on.messages } as never);
            assert.equal(r.text, hostImageRestoreFailedText(ref, [tilde(hh.shas.a!)], 0));
            assert.ok(r.text.startsWith("[decompress FAILED:"), "开头照旧（失败的识别靠它）");
            assert.ok(!r.text.includes(hh.home));
            assert.equal((on.session.metadata?.[HOST_IMAGE_PATHS_METADATA_KEY] as Record<string, number>).decompressPaths, 1);
            const off = make(false);
            const r0 = await executeProxyToolAsync("decompress", { imageRef: ref }, { ...off, compressMessages: off.messages } as never);
            assert.match(r0.text, /file-sourced image's original stays with the host/);
            assert.ok(!r0.text.includes("~/"));
            const none = await executeProxyToolAsync("decompress", { imageRef: "m09999" }, { ...on, compressMessages: on.messages } as never);
            assert.match(none.text, /file-sourced image's original stays with the host/, "找不到消息：照旧那句");
        });
    } finally { hh.cleanup(); }
    // 一条消息里几张图：按出现顺序、去重，另记没留路径的张数
    const env = fakeEnv([objWin(HOME, SHA_A), objWin(HOME, SHA_B)]);
    const m = trCore("bili_humanism_read", [
        { type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, fileImg("1"),
        { type: "text", text: handleText(SHA_B, objWin(HOME, SHA_B)) }, fileImg("2"),
        { type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, fileImg("3"),
        { type: "text", text: handleText(SHA_C, objWin(HOME, SHA_C)) }, fileImg("4"),
    ]);
    const found = hostImagePathsOfMessage(m, env);
    assert.deepEqual(found, { paths: [tilde(SHA_A), tilde(SHA_B)], withoutPath: 1 });
    assert.equal(hostImageRestoreFailedText("m00042", found.paths, found.withoutPath),
        `[decompress FAILED: "m00042" 这张图的像素不在代理这里（它现在是宿主那边的文件图），decompress 拿不回。宿主存着只读副本（可能缩过），要再看就用 read_image 读：\n图1：${tilde(SHA_A)}\n图2：${tilde(SHA_B)}\n（这一条里另有 1 张没留路径）]`);
});

// ---------- T9 她拿占位的路径真能 read_image（DSH fs-local 的展开规则） ----------

const DSH_SRC = process.env.DSH_SRC_RC3 ?? path.resolve("..", "dsh-src-rc3");
const FS_LOCAL = path.join(DSH_SRC, "packages", "fs", "fs-local", "src", "fsio.ts");
const READ_IMAGE = path.join(DSH_SRC, "packages", "fs", "tool-fs", "src", "read-image.ts");

/** 从 DSH rc.3 源码里原样抽出几个函数（只去掉类型），绑上临时家目录的 homedir。 */
async function dshFsRules(home: string) {
    const { transformSync } = await import("esbuild");
    const grab = (src: string, re: RegExp) => { const m = re.exec(src); assert.ok(m, `源码里找不到 ${re}`); return m[0]; };
    const fsio = readFileSync(FS_LOCAL, "utf8");
    const ri = readFileSync(READ_IMAGE, "utf8");
    const code = [
        grab(fsio, /export function expandHomePrefix\(path: string\): string \{[\s\S]*?\n\}/),
        grab(fsio, /export function localDisplayPath\(cwd: string, path: string\): string \{[\s\S]*?\n\}/),
        grab(ri, /const PNG_SIGNATURE = [^\n]*\n/),
        grab(ri, /const JPEG_SIGNATURE = [^\n]*\n/),
        grab(ri, /function matchesBytes\([\s\S]*?\n\}/),
        grab(ri, /function matchesAscii\([\s\S]*?\n\}/),
        grab(ri, /export function sniffImageMediaType\([\s\S]*?\n\}/),
    ].join("\n").replace(/\bexport /g, "").replace(/\bas const\b/g, "");
    const js = transformSync(code, { loader: "ts" }).code;
    const { isAbsolute, resolve, sep } = path;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const make = new Function("homedir", "isAbsolute", "resolve", "sep", "process", `${js}\nreturn { expandHomePrefix, localDisplayPath, sniffImageMediaType };`);
    return make(() => home, isAbsolute, resolve, sep, process) as {
        expandHomePrefix: (p: string) => string; localDisplayPath: (cwd: string, p: string) => string; sniffImageMediaType: (d: Uint8Array) => string | undefined;
    };
}

test("T9 占位里的路径按 DSH fs-local 的规则展开以后真的读得到：落在临时家目录的附件库里、是 PNG、字节的 sha256 就是文件名", { skip: !existsSync(FS_LOCAL) && "没有 DSH rc.3 源码" }, async () => {
    const hh = makeHostHome(["a", "b"]);
    try {
        await withHostHome(hh.home, async () => {
            const ctx = foldCtx(imageHistory(hh.home, hh.shas, ["a", "b"]), { fold: true, paths: true });
            const r = await executeProxyToolAsync("compress", { content: `${segRefs(ctx, 0).start}–${segRefs(ctx, 1).end} 两张\n两张图她都看了。${PAD}` }, ctx as never);
            assert.equal(r.outcome, "applied", r.text);
            const block = ctx.session.state.blocks.find((b) => b.active)!;
            const paths = [...block.summary.matchAll(/^图\d+ read_image：(~\/\S+)$/gm), ...block.summary.matchAll(/^图\d+ read_image：(~\/\S+)\]$/gm)].map((m) => m[1]!.replace(/\]$/, ""));
            assert.equal(new Set(paths).size, 2, block.summary);
            const dsh = await dshFsRules(hh.home);
            const cwd = mkdtempSync(path.join(tmpdir(), "imgpath-cwd-"));
            try {
                for (const p of paths) {
                    const expanded = dsh.expandHomePrefix(p);
                    assert.ok(expanded.startsWith(hh.home), "展开成临时家目录下的路径");
                    const display = dsh.localDisplayPath(cwd, expanded);
                    const real = realpathSync(display);
                    assert.ok(real.toLowerCase().startsWith(realpathSync(hh.home).toLowerCase()));
                    const bytes = readFileSync(real);
                    assert.equal(dsh.sniffImageMediaType(bytes), "image/png", "没有扩展名，按文件头认出是 PNG（read_image 的认法）");
                    assert.equal(createHash("sha256").update(bytes).digest("hex"), path.basename(real), "就是那张图的规范化副本");
                }
                // 对照：不带 ~ 的相对写法会落到会话目录，读不到
                const rel = dsh.localDisplayPath(cwd, paths[0]!.slice(2));
                assert.equal(existsSync(rel), false);
            } finally { rmSync(cwd, { recursive: true, force: true }); }
        });
    } finally { hh.cleanup(); }
});

// ---------- 真起代理：回执、出站、连续两次出站逐字节相同 ----------

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("真起代理：她的条目里开 ④ + 路径；compress 回执附尾巴，下一轮出站的块摘要带 ~/ 路径、没有家目录；建块以后连续两次出站逐字节相同；decompress 取图给路径", async () => {
    const hh = makeHostHome(["a", "b"]);
    const savedHome = process.env.BILI_HOST_HOME;
    process.env.BILI_HOST_HOME = hh.home;
    const outbound: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            outbound.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: "m", role: "assistant", usage: { input_tokens: 500 } } }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
            res.write(anthropicSse("message_stop", { type: "message_stop" }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const conv = "session-imgpath-e2e";
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-flash": { context: 1_048_576 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, { preserveRecentMessages: 1, preserveRecentTokens: 0, compress: { minCompressRange: 50, maxSummaryLength: 20000, minSummaryLength: 20 } }),
        compress: { injectTool: true, injectNudge: true, sessions: { [conv]: { foldHostFileImages: true, foldHostFileImagePaths: true } } },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const send = async (messages: unknown[]) => {
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv },
            body: JSON.stringify({ model: "deepseek-flash", max_tokens: 1024, stream: true, messages }),
        });
        assert.equal(resp.status, 200);
        await resp.text();
        return outbound.at(-1)!;
    };
    const tool = async (name: string, args: Record<string, unknown>) => {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: name, args }),
        });
        return (await r.json()) as { outcome?: string; result?: string; text?: string };
    };
    try {
        const history = (gen: string) => [
            ...imageHistory(hh.home, hh.shas, ["a", "b", "a"], { gen }).slice(0, -1),
            { role: "user", content: [{ type: "text", text: "兔：再看一张别的。" }] },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_b64", name: "read_image", input: { path: "q.png" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b64", content: [{ type: "text", text: envelope("D:\\media\\q.png") }, { type: "text", text: handleText(hh.shas.b!, hostObj(hh.home, hh.shas.b!)) }, b64Img()] }] },
            { role: "assistant", content: [{ type: "text", text: "这张也看了。" }] },
            { role: "user", content: [{ type: "text", text: "兔：好。" }] },
        ];
        const h1 = history("g1");
        await send(h1);
        const sess = listSessions().find((s) => s.id.includes(conv)) ?? listSessions().at(-1)!;
        const cores = anthropicToCore({ messages: h1 } as never).msgs as CoreMessage[];
        const byRaw = sess.state.messageRefs.byRaw;
        const firstRef = byRaw[cores[0]!.id]!;
        const trCores = cores.filter((m) => m.contentType === "tool-result");
        // 折掉前三段（三张 file 图）：第一句话到第三段的回话
        const thirdReply = cores.filter((m) => m.role === "assistant" && m.contentType === "text")[2]!;
        const endRef = byRaw[thirdReply.id]!;
        assert.ok(/^m\d+$/.test(firstRef) && /^m\d+$/.test(endRef), `${firstRef} ${endRef}`);
        const fold = await tool("compress", { content: `${firstRef}–${endRef} 看图\n2026-11-16 · 兔发来三张图（一张看了两次），她都看了。${PAD}` });
        assert.equal(fold.outcome, "applied", JSON.stringify(fold).slice(0, 600));
        const receipt = JSON.stringify(fold);
        assert.ok(receipt.includes("这一段里有 3 张图，已折起，不在上下文里了"), receipt.slice(0, 800));
        assert.ok(receipt.includes(tilde(hh.shas.a!)) && receipt.includes("同图1"));
        assert.ok(!receipt.includes(hh.home.replaceAll("\\", "\\\\")) && !receipt.includes(path.basename(hh.home)), "回执里没有家目录");
        const o2 = await send(history("g2"));
        const o3 = await send(history("g2"));
        assert.equal(o3, o2, "建块以后连续两次出站逐字节相同（尾巴建块时就定了，不每次重算）");
        assert.ok(o2.includes("这一段里有 3 张图，已折起，不在上下文里了"), "块摘要带着尾巴上线");
        assert.ok(o2.includes(tilde(hh.shas.a!)) && o2.includes(tilde(hh.shas.b!)));
        assert.ok(!o2.includes("file-g1-") && !o2.includes("file-g2-0-") && !o2.includes("file-g2-1-"), "折掉的图不在出站里");
        // 出站里家目录只出现在宿主自己的 handle 文字里（没折的那条工具结果）——尾巴里一处都没有
        const tailStart = o2.indexOf("这一段里有 3 张图");
        const tailSection = o2.slice(tailStart, o2.indexOf("同图1]", tailStart) + 4);
        assert.ok(tailSection.length > 100 && tailSection.length < 1200, String(tailSection.length));
        assert.ok(!tailSection.includes(path.basename(hh.home)));
        // decompress：没折的那张 base64 照旧还原（像素在本机）；file 图那条给路径
        const b64Ref = byRaw[trCores[3]!.id]!;
        const restored = await tool("decompress", { imageRef: b64Ref });
        assert.match(JSON.stringify(restored), /Restored 1 image/);
        const fileRef = byRaw[trCores[0]!.id]!;
        const viaRef = await tool("decompress", { imageRef: fileRef });
        const vr = JSON.stringify(viaRef);
        assert.ok(vr.includes("这张图的像素不在代理这里") && vr.includes(tilde(hh.shas.a!)), vr.slice(0, 600));
        const counts = (listSessions().find((s) => s.id === sess.id) ?? sess).metadata?.[HOST_IMAGE_PATHS_METADATA_KEY] as Record<string, number>;
        assert.equal(counts.listed, 2);
        assert.equal(counts.decompressPaths, 1);
    } finally {
        if (savedHome === undefined) delete process.env.BILI_HOST_HOME; else process.env.BILI_HOST_HOME = savedHome;
        proxy.close(); proxy.closeIdleConnections?.(); await once(proxy, "close");
        upstream.close(); upstream.closeIdleConnections?.();
        hh.cleanup();
    }
});

test("指纹：不给 excerptFrom 时和上游逐字节一样", () => {
    assert.equal(summaryFingerprintLine("b1", "S"), ' · b1 full summary 1ch · head "S" … tail "S"');
    assert.equal(summaryFingerprintLine("b1", "S\n\nX", null, "S"), ' · b1 full summary 4ch · head "S" … tail "S"');
});

// ---------- 复核 N1–N4（S2）：fork-1117 REVIEW 第六节 ----------

test("N1 结果头的路径里有一段以点或空格结尾（Windows 打开时会去掉）：当认不出、不留；附件库路径也一样；对照照旧给", () => {
    const env = fakeEnv([objWin(HOME, SHA_A)]);
    const h = { type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) };
    const one = (envPath: string, tool = "read_image") => hostImageEntries(trCore(tool, [{ type: "text", text: envelope(envPath) }, h, fileImg("f")]), env)[0]!;
    const odd: [string, string][] = [
        ["临时目录段末尾带点（复核 probe-extra 那种）", `${TEMP}.\\f.png`],
        ["临时目录段末尾带空格", `${TEMP} \\f.png`],
        ["末尾一串点和空格", `${TEMP}. .\\f.png`],
        ["中间一段带点", `${HOME}\\AppData.\\Local\\Temp\\f.png`],
        ["文件名末尾带点", "D:\\pics\\x.png."],
        ["文件名末尾带空格", "D:\\pics\\x.png "],
        ["正斜杠写法也一样", `${TEMP.replaceAll("\\", "/")}./f.png`],
        ["三个点那一段", `${HOME}\\...\\f.png`],
    ];
    for (const [what, p] of odd) {
        assert.deepEqual(one(p), { tool: "read_image", sha: SHA_A, why: "unknown" }, what);
        assert.equal(one(p, "bili_humanism_frames").why, "unknown", `${what}（别的工具的结果头）`);
    }
    assert.equal(one("D:\\pics\\x.png").path, tilde(SHA_A), "对照：平常的路径照旧给");
    assert.equal(one("D:\\pics.d\\x.png").path, tilde(SHA_A), "对照：段中间有点不算");
    // 附件库那条路（handle 里的路径）：家目录以下某段末尾带点也不留
    const dotted = `${HOME}\\.dsh.\\attachments\\v1\\objects\\${SHA_A.slice(0, 2)}\\${SHA_A}`;
    assert.equal(hostImageEntries(trCore("bili_humanism_read", [{ type: "text", text: handleText(SHA_A, dotted) }, fileImg("f")]), { ...env, exists: () => true })[0]!.why, "unknown", "附件库以上那一段末尾带点");
    // 非 Windows 的规矩不变（末尾带点的目录名在别处是平常的名字）
    const posix: HostImagePathEnv = { home: "/home/user", tempRoots: ["/tmp"], exists: () => true, win: false };
    const posixOne = hostImageEntries(trCore("read_image", [{ type: "text", text: envelope("/srv/pics./x.png") }, { type: "text", text: handleText(SHA_A, `/home/user/.dsh/attachments/v1/objects/${SHA_A.slice(0, 2)}/${SHA_A}`) }, fileImg("f")]), posix)[0]!;
    assert.equal(posixOne.path, tilde(SHA_A));
});

test("N2 结果头用 \\r\\n 换行也认：指向临时目录的不管哪个工具都不留", () => {
    const env = fakeEnv([objWin(HOME, SHA_T), objWin(HOME, SHA_A)]);
    const crlf = (p: string) => `<path>${p}</path>\r\n<type>image</type>\r\n<content>\r\nimage/png image, 64x64 px, 120 bytes\r\n</content>`;
    const h = (sha: string) => ({ type: "text", text: handleText(sha, objWin(HOME, sha)) });
    assert.deepEqual(hostImageEntries(trCore("bili_humanism_frames", [{ type: "text", text: crlf(`${TEMP}\\frame-1.png`) }, h(SHA_T), fileImg("f")]), env), [{ tool: "bili_humanism_frames", sha: SHA_T, why: "temp" }], "别的工具、CRLF、临时目录");
    assert.deepEqual(hostImageEntries(trCore("read_image", [{ type: "text", text: crlf(`${TEMP}\\x.png`) }, h(SHA_T), fileImg("f")]), env), [{ tool: "read_image", sha: SHA_T, why: "temp" }], "read_image、CRLF、临时目录");
    assert.deepEqual(hostImageEntries(trCore("read_image", [{ type: "text", text: crlf("D:\\shots\\windows-computer-use-2.png") }, h(SHA_A), fileImg("f")]), env), [{ tool: "read_image", sha: SHA_A, why: "screenshot" }], "CRLF 里的截屏名");
    assert.deepEqual(hostImageEntries(trCore("read_image", [{ type: "text", text: crlf("C:\\Users\\USER~1\\AppData\\Local\\Temp\\x.png") }, h(SHA_A), fileImg("f")]), env), [{ tool: "read_image", sha: SHA_A, why: "unknown" }], "CRLF、8.3 短名：认不出");
    assert.equal(hostImageEntries(trCore("read_image", [{ type: "text", text: crlf("D:\\media\\onebot\\abc") }, h(SHA_A), fileImg("f")]), env)[0]!.path, tilde(SHA_A), "对照：CRLF、平常的目录照旧给（认得出结果头，所以 read_image 不算「认不出」）");
    const crInPath = `<path>${TEMP}\\x.png\r</path>\n<type>image</type>`;
    assert.equal(hostImageEntries(trCore("bili_humanism_frames", [{ type: "text", text: crInPath }, h(SHA_T), fileImg("f")]), env)[0]!.why, "temp", "路径末尾夹着 \\r：照旧按临时目录算");
});

test("N3 截屏工具的名字照线上桥 WINCU_LOOK_RE 认：任何服务名下的 windows_computer_use_ 都算截屏（内联的、没有文件名的也挡）；带上来的行也一样", () => {
    const env = fakeEnv([objWin(HOME, SHA_S)]);
    const inline = (tool: string) => hostImageEntries(trCore(tool, [{ type: "text", text: handleText(SHA_S, objWin(HOME, SHA_S)) }, fileImg("f")]), env)[0]!;
    for (const tool of [
        "mcp__wincu__windows_computer_use_screenshot",
        "mcp__wincu__screenshot",
        "mcp__computer__windows_computer_use_screenshot",
        "mcp__wincu-0.5.8__windows_computer_use_snapshot",
        "mcp__x__windows_computer_use_batch",
        "windows_computer_use_screenshot",
        "MCP__WINCU__windows_computer_use_ocr",
        "mcp__desk__Windows_Computer_Use_find",
    ]) {
        assert.deepEqual(inline(tool), { tool, sha: SHA_S, why: "screenshot" }, tool);
    }
    for (const tool of ["bili_humanism_read", "mcp__wincu_other__read", "mcp__x__computer_use_screenshot", "read_image"]) {
        assert.notEqual(inline(tool).why, "screenshot", `对照：${tool}`);
    }
    assert.equal(inline("bili_humanism_read").path, tilde(SHA_S));
    // 带上来的行：截屏工具的名字（换了服务名）带着路径 → 不给
    const head = "[这一段里有 1 张图，已折起，不在上下文里了；decompress 拿不回图。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：";
    const forged = `她写的。\n\n${head}\n图1 mcp__computer__windows_computer_use_screenshot：${tilde(SHA_S)}]`;
    assert.deepEqual(parseHostImagePathNote(forged, env)!.entries, [{ tool: "mcp__computer__windows_computer_use_screenshot", sha: SHA_S, why: "screenshot" }]);
    // decompress 那条路也挡
    assert.deepEqual(hostImagePathsOfMessage(trCore("mcp__computer__windows_computer_use_screenshot", [{ type: "text", text: handleText(SHA_S, objWin(HOME, SHA_S)) }, fileImg("f")]), env), { paths: [], withoutPath: 1 });
});

test("N4 同一块里：没有工具名的图也污染同一个编号（先后都一样）；几处原因不同时写排在前面的那个", () => {
    const env = fakeEnv([objWin(HOME, SHA_S), objWin(HOME, SHA_A)]);
    const noName = hostImageEntries(trCoreNoName([{ type: "text", text: handleText(SHA_S, objWin(HOME, SHA_S)) }, fileImg("f")]), env);
    assert.deepEqual(noName, [{ sha: SHA_S, why: "notool" }]);
    const reread = hostImageEntries(trCore("read_image", [{ type: "text", text: envelope(objWin(HOME, SHA_S)) }, { type: "text", text: handleText(SHA_S, objWin(HOME, SHA_S)) }, fileImg("g")]), env);
    assert.deepEqual(reread, [{ tool: "read_image", sha: SHA_S, path: tilde(SHA_S) }], "前提：单看这一条是给路径的");
    const head = (n: number) => `[这一段里有 ${n} 张图，已折起，不在上下文里了；decompress 拿不回图。宿主给每张图存了只读副本（可能缩过），要再看哪张，用 read_image 读它的路径：`;
    const before = renderHostImagePathNote({ entries: [...noName, ...reread], capped: 0, unlisted: 0 })!;
    assert.equal(before.text, [head(2), "图1：认不出是哪个工具给的图，不留路径", "图2 read_image：同图1]"].join("\n"), "没名字的在前");
    const after = renderHostImagePathNote({ entries: [...reread, ...noName], capped: 0, unlisted: 0 })!;
    assert.equal(after.text, [head(2), "图1 read_image：认不出是哪个工具给的图，不留路径", "图2：同图1]"].join("\n"), "读副本的在前：也不给（复核时这里给了路径）");
    assert.ok(!after.text.includes(SHA_S));
    assert.deepEqual(after.tally, { listed: 0, sameAs: 1, screenshot: 0, temp: 0, missing: 0, unknown: 0, notool: 1, capped: 0, unlisted: 0 });
    // 同一个编号既是截屏又没有工具名：写截屏
    const mixed = renderHostImagePathNote({ entries: [...reread, ...noName, { tool: "mcp__wincu__windows_computer_use_screenshot", sha: SHA_S, why: "screenshot" }], capped: 0, unlisted: 0 })!;
    assert.match(mixed.text, /\n图1 read_image：屏幕截图，不留路径\n/);
    // 别的编号不受影响
    const other = renderHostImagePathNote({ entries: [...noName, { tool: "read_image", sha: SHA_A, path: tilde(SHA_A) }], capped: 0, unlisted: 0 })!;
    assert.ok(other.text.endsWith(`\n图2 read_image：${tilde(SHA_A)}]`), other.text);
    // decompress 那条路：一条消息里没名字就整条不给（原来就这样）
    assert.deepEqual(hostImagePathsOfMessage(trCoreNoName([{ type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, fileImg("f")]), env), { paths: [], withoutPath: 1 });
});

test("S2 / N4 跨块的编号集合：会话 metadata 里记的 + 这一次历史里扫到的；带上来的行照它查；超了丢最早的；读到乱写的值不认", () => {
    const env = fakeEnv([objWin(HOME, SHA_S), objWin(HOME, SHA_A), objWin(HOME, SHA_T)]);
    const shotMsg = trCore("mcp__wincu__windows_computer_use_screenshot", [{ type: "text", text: handleText(SHA_S, objWin(HOME, SHA_S)) }, fileImg("f")]);
    const noNameMsg = trCoreNoName([{ type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, fileImg("f")]);
    const tempMsg = trCore("read_image", [{ type: "text", text: envelope(`${TEMP}\\x.png`) }, { type: "text", text: handleText(SHA_T, objWin(HOME, SHA_T)) }, fileImg("f")]);
    const plainMsg = trCore("read_image", [{ type: "text", text: envelope(objWin(HOME, SHA_A)) }, { type: "text", text: handleText(SHA_A, objWin(HOME, SHA_A)) }, fileImg("f")]);
    // 历史里扫到的
    const session: { metadata?: Record<string, unknown> } = {};
    const fromView = hostImageNoPathMap(session, [shotMsg, noNameMsg, tempMsg, plainMsg], env);
    assert.deepEqual(Object.fromEntries(fromView), { [SHA_S]: "screenshot", [SHA_A]: "notool", [SHA_T]: "temp" });
    assert.equal(session.metadata, undefined, "只是查，不写");
    // 记进会话：有变化才写
    assert.equal(rememberHostImageNoPath(session, fromView), true);
    assert.deepEqual(session.metadata![HOST_IMAGE_NO_PATH_METADATA_KEY], { [SHA_S]: "screenshot", [SHA_A]: "notool", [SHA_T]: "temp" });
    assert.equal(rememberHostImageNoPath(session, fromView), false, "没有新的：不写");
    assert.equal(rememberHostImageNoPath(session, new Map([[SHA_A, "screenshot" as const]])), true, "原因升格（截屏排在没有工具名前面）");
    assert.equal((session.metadata![HOST_IMAGE_NO_PATH_METADATA_KEY] as Record<string, string>)[SHA_A], "screenshot");
    assert.equal(rememberHostImageNoPath(session, new Map([[SHA_A, "notool" as const]])), false, "不降格");
    // 历史里已经没有截屏那条了（宿主把图换成了占位字）：会话里记的照样算
    const later = hostImageNoPathMap(session, [plainMsg], env);
    assert.equal(later.get(SHA_S), "screenshot");
    assert.equal(later.get(SHA_A), "screenshot");
    assert.deepEqual(hostImagePathsOfMessage(plainMsg, env, later), { paths: [], withoutPath: 1 }, "decompress 那条路照它查");
    assert.deepEqual(hostImagePathsOfMessage(plainMsg, env), { paths: [tilde(SHA_A)], withoutPath: 0 }, "对照：不给集合时给路径");
    // 并块：子块里「屏幕截图，不留路径」那行没有编号；另一个子块里读同一张副本、带着路径的那行，带上来时照集合不给
    const childWithPath = renderHostImagePathNote({ entries: [{ tool: "read_image", sha: SHA_S, path: tilde(SHA_S) }], capped: 0, unlisted: 0 })!.text;
    const carried = parseHostImagePathNote(`子块。\n\n${childWithPath}`, env)!;
    assert.equal(carried.entries[0]!.path, tilde(SHA_S), "前提：子块的尾巴里有这条路径");
    const merged = renderHostImagePathNote({ entries: carried.entries, capped: 0, unlisted: 0 }, later)!;
    assert.ok(merged.text.endsWith("\n图1 read_image：屏幕截图，不留路径]"), merged.text);
    assert.ok(!merged.text.includes(SHA_S), merged.text);
    assert.equal(merged.tally.screenshot, 1);
    // 乱写的值不认（不是 64 位编号、不是那三种原因、不是对象）
    const junk: { metadata?: Record<string, unknown> } = { metadata: { [HOST_IMAGE_NO_PATH_METADATA_KEY]: { [SHA_A]: "missing", "not-a-sha": "screenshot", [SHA_B]: "constructor", [SHA_C]: "temp" } } };
    assert.deepEqual(Object.fromEntries(hostImageNoPathMap(junk, [], env)), { [SHA_C]: "temp" });
    assert.deepEqual(Object.fromEntries(hostImageNoPathMap({ metadata: { [HOST_IMAGE_NO_PATH_METADATA_KEY]: [SHA_A] } }, [], env)), {});
    // 上限：超了丢最早记下的
    const many: { metadata?: Record<string, unknown> } = {};
    const shas = Array.from({ length: HOST_IMAGE_NO_PATH_MAX + 6 }, (_, i) => shaOf(`many-${i}`));
    rememberHostImageNoPath(many, new Map(shas.map((s) => [s, "notool" as const])));
    const kept = Object.keys(many.metadata![HOST_IMAGE_NO_PATH_METADATA_KEY] as object);
    assert.equal(kept.length, HOST_IMAGE_NO_PATH_MAX);
    assert.equal(kept[0], shas[6], "最早的 6 个丢了");
    assert.equal(kept[kept.length - 1], shas[shas.length - 1]);
});

/** 一段段的工具结果历史：每段 4 条（兔说一句 → 调用（没有工具名的段换成她一句话）→ 结果 → 她回一句），segRefs 照用。 */
function toolHistory(segs: readonly { tool?: string; content: unknown[] }[]) {
    const msgs: unknown[] = [];
    segs.forEach((seg, i) => {
        msgs.push({ role: "user", content: [{ type: "text", text: `兔：第 ${i} 段。` + "背景说明。".repeat(30) }] });
        if (seg.tool !== undefined) msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: seg.tool, input: {} }] });
        else msgs.push({ role: "assistant", content: [{ type: "text", text: `（第 ${i} 段的调用不在这一次请求里）` }] });
        msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: seg.tool !== undefined ? `toolu_${i}` : `toolu_gone_${i}`, content: seg.content }] });
        msgs.push({ role: "assistant", content: [{ type: "text", text: `看到了第 ${i} 段。` + "回话内容。".repeat(30) }] });
    });
    msgs.push({ role: "user", content: [{ type: "text", text: "兔：好，接着聊别的。" }] });
    return msgs;
}

test("N4 / S2 真折：没有工具名的图和读它副本的在两块里（不管哪块先建），并块以后也不给路径；会话记下编号；不开路径时一个字不记", async () => {
    const hh = makeHostHome(["s", "a"]);
    try {
        await withHostHome(hh.home, async () => {
            const S = hh.shas.s!, A = hh.shas.a!;
            const segs = [
                { content: [{ type: "text", text: handleText(S, hostObj(hh.home, S)) }, fileImg("file-g1-0-xxxxxxxxxxxxxxxx")] },
                { tool: "read_image", content: [{ type: "text", text: envelope("D:\\media\\a.png") }, { type: "text", text: handleText(A, hostObj(hh.home, A)) }, fileImg("file-g1-1-xxxxxxxxxxxxxxxx")] },
                { tool: "read_image", content: [{ type: "text", text: envelope("D:\\media\\s-copy.png") }, { type: "text", text: handleText(S, hostObj(hh.home, S)) }, fileImg("file-g1-2-xxxxxxxxxxxxxxxx")] },
            ];
            for (const order of [[1, 0], [0, 1]] as const) {
                const ctx = foldCtx(toolHistory(segs), { fold: true, paths: true });
                assert.equal((ctx.messages.filter((m) => m.contentType === "tool-result")[0] as { toolName?: string }).toolName, undefined, "前提：第 0 段没有工具名");
                const ranges = [`${segRefs(ctx, 0).start}–${segRefs(ctx, 0).end} 没名字的图\n一张不知道哪来的图。${PAD}`, `${segRefs(ctx, 1).start}–${segRefs(ctx, 2).end} 读了两张\n她读了两张图。${PAD}`];
                for (const k of order) {
                    const r = await executeProxyToolAsync("compress", { content: ranges[k]! }, ctx as never);
                    assert.equal(r.outcome, "applied", r.text);
                    assert.ok(!r.text.includes(S), `回执里没有这张图的路径（顺序 ${order.join(",")}）`);
                }
                const kids = ctx.session.state.blocks.filter((b) => b.active);
                assert.equal(kids.length, 2);
                for (const k of kids) assert.ok(!k.summary.includes(S), k.summary.slice(-400));
                const readBlock = kids.find((k) => k.summary.includes(A))!;
                assert.ok(readBlock.summary.endsWith("\n图2 read_image：认不出是哪个工具给的图，不留路径]"), readBlock.summary.slice(-300));
                assert.deepEqual(ctx.session.metadata?.[HOST_IMAGE_NO_PATH_METADATA_KEY], { [S]: "notool" });
                const r3 = await executeProxyToolAsync("compress", { content: `${kids[0]!.blockId}–${kids[1]!.blockId} 三张\n三张图的整理。${PAD}` }, ctx as never);
                assert.equal(r3.outcome, "applied", r3.text);
                const merged = ctx.session.state.blocks.find((b) => b.active)!;
                const footer = parseHostImagePathNote(merged.summary, hostImagePathEnv())!;
                assert.equal(footer.entries.length, 3);
                assert.ok(!merged.summary.includes(S) && !r3.text.includes(S), merged.summary.slice(-400));
                assert.ok(merged.summary.includes(tilde(A)), "别的图照旧给路径");
            }
            // 不开路径：会话里不记
            const off = foldCtx(toolHistory(segs), { fold: true, paths: false });
            const r = await executeProxyToolAsync("compress", { content: `${segRefs(off, 0).start}–${segRefs(off, 2).end} 三张\n三张图。${PAD}` }, off as never);
            assert.equal(r.outcome, "applied", r.text);
            assert.equal(off.session.metadata?.[HOST_IMAGE_NO_PATH_METADATA_KEY], undefined);
            assert.equal(off.session.metadata?.[HOST_IMAGE_PATHS_METADATA_KEY], undefined);
        });
    } finally { hh.cleanup(); }
});

test("S2 真折：截屏折掉以后（历史里只剩会话记的编号），另一边读它副本的块和 decompress 都不给路径；截屏还没折时也一样", async () => {
    const hh = makeHostHome(["s", "a"]);
    try {
        await withHostHome(hh.home, async () => {
            const S = hh.shas.s!, A = hh.shas.a!;
            const shot = { tool: "mcp__wincu__windows_computer_use_screenshot", content: [{ type: "text", text: handleText(S, hostObj(hh.home, S)) }, fileImg("file-g1-0-xxxxxxxxxxxxxxxx")] };
            const reread = { tool: "read_image", content: [{ type: "text", text: envelope("D:\\media\\s-copy.png") }, { type: "text", text: handleText(S, hostObj(hh.home, S)) }, fileImg("file-g1-1-xxxxxxxxxxxxxxxx")] };
            const plain = { tool: "read_image", content: [{ type: "text", text: envelope("D:\\media\\a.png") }, { type: "text", text: handleText(A, hostObj(hh.home, A)) }, fileImg("file-g1-2-xxxxxxxxxxxxxxxx")] };
            // 1. 截屏折进一块：会话记下编号
            const ctx1 = foldCtx(toolHistory([shot, plain]), { fold: true, paths: true });
            const r1 = await executeProxyToolAsync("compress", { content: `${segRefs(ctx1, 0).start}–${segRefs(ctx1, 0).end} 截屏\n看了一眼屏幕。${PAD}` }, ctx1 as never);
            assert.equal(r1.outcome, "applied", r1.text);
            assert.deepEqual(ctx1.session.metadata?.[HOST_IMAGE_NO_PATH_METADATA_KEY], { [S]: "screenshot" });
            // 2. 后来的历史里没有截屏那条了（宿主把它换成了占位字）；会话照旧
            const ctx2 = foldCtx(toolHistory([reread, plain]), { fold: true, paths: true });
            ctx2.session.metadata = structuredClone(ctx1.session.metadata);
            (ctx2.session as { incomingImageIndex?: Map<string, unknown[]> }).incomingImageIndex = new Map();
            const trId = ctx2.messages.filter((m) => m.contentType === "tool-result")[0]!.id;
            const ref = ctx2.session.state.messageRefs.byRaw[trId]!;
            const d = await executeProxyToolAsync("decompress", { imageRef: ref }, { ...ctx2, compressMessages: ctx2.messages } as never);
            assert.ok(d.text.startsWith("[decompress FAILED:") && !d.text.includes(S), d.text);
            assert.equal((ctx2.session.metadata?.[HOST_IMAGE_PATHS_METADATA_KEY] as Record<string, number>).decompressNoPath, 1);
            const r2 = await executeProxyToolAsync("compress", { content: `${segRefs(ctx2, 0).start}–${segRefs(ctx2, 1).end} 读了两张\n她读了两张图。${PAD}` }, ctx2 as never);
            assert.equal(r2.outcome, "applied", r2.text);
            const b2 = ctx2.session.state.blocks.find((b) => b.active)!;
            assert.ok(b2.summary.includes("\n图1 read_image：屏幕截图，不留路径\n"), b2.summary.slice(-300));
            assert.ok(!b2.summary.includes(S) && b2.summary.includes(tilde(A)));
            // 对照：会话里没记过、历史里也没有截屏 → 给路径（就是复核说的「跨块会漏」）
            const ctx3 = foldCtx(toolHistory([reread, plain]), { fold: true, paths: true });
            const r3 = await executeProxyToolAsync("compress", { content: `${segRefs(ctx3, 0).start}–${segRefs(ctx3, 1).end} 读了两张\n她读了两张图。${PAD}` }, ctx3 as never);
            assert.equal(r3.outcome, "applied", r3.text);
            assert.ok(ctx3.session.state.blocks.find((b) => b.active)!.summary.includes(tilde(S)), "对照");
            // 3. 截屏还没折、只在历史里：读它副本的那块也不给
            const ctx4 = foldCtx(toolHistory([shot, reread, plain]), { fold: true, paths: true });
            const r4 = await executeProxyToolAsync("compress", { content: `${segRefs(ctx4, 1).start}–${segRefs(ctx4, 2).end} 读了两张\n她读了两张图。${PAD}` }, ctx4 as never);
            assert.equal(r4.outcome, "applied", r4.text);
            const b4 = ctx4.session.state.blocks.find((b) => b.active)!;
            assert.ok(b4.summary.includes("\n图1 read_image：屏幕截图，不留路径\n") && !b4.summary.includes(S), b4.summary.slice(-300));
            assert.deepEqual(ctx4.session.metadata?.[HOST_IMAGE_NO_PATH_METADATA_KEY], { [S]: "screenshot" }, "没折的截屏也记下");
        });
    } finally { hh.cleanup(); }
});
