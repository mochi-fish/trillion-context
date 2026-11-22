// fork（养成向）：Anthropic 线上 source.type="file" 的图可以折（compress.foldHostFileImages）。
//
// 背景：她走 DeepSeek 的 Anthropic 接口时，宿主把图传到 DeepSeek Files API，请求里
// 只带 {type:"file", file_id}。上游 0.1.213 把这类图当成「没有字节、没有可靠句柄」，
// 连同所在的工具结果一起钉住，永远折不掉。file_id 7 天过期，宿主到期前自己重传、
// 换新 id。开关打开后这类图可以折，但要守住四条：
//   ① 发给上游的图片块只能是这一次宿主送来的：出站里的 file_id 必须都在这次入站里；
//      不在的（账本、快照里的旧 id）换成占位字。
//   ② 摘要里不把 file_id 当成「能取回」的句柄写进去（MEDIA REFS 只认网址），
//      写的是「这里有图，已折起，原图在宿主那边」。
//   ③ 图在 base64 和 file 两种来源之间来回换时，可不可折不翻；身份里不含 file_id。
//   ④ 折掉以后像素不在了，decompress 拿不回图，说明里不说「能还原像素」。
// 不开开关时一切和上游一样（file 图钉住）。
// 审查后（2026-11-15 夜）：开关只放工具结果里的 file 图，顶层 file 图照旧钉住（身份
// 只靠位置，盖错图 / 换来源后露出来）；占位字、decompress 的回执都只在开关开着时
// 换，不开时逐字节同上游；占位字改成中性的「[图片（原图在宿主那边）]」，「已折起」
// 只留在折叠尾巴里。
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

const { createCore, defaultConfig, hasUnrecoverableMediaPayload, extractMediaRefs, isHostHeldFileSource, mediaFoldOptions } = await import("acp-kernel");
type Config = import("acp-kernel").Config;
type CoreMessage = import("acp-kernel").CoreMessage;
const { anthropicToCore } = await import("acp-kernel/wire");
const { HOST_HELD_IMAGE_PLACEHOLDER, IMAGE_PLACEHOLDER, hostHeldFoldNote, imageNoteOptions, imagePlaceholders, imagePlaceholdersForSummary, partitionFoldedImageNotes } = await import("../src/image-note.ts");
const { collectAnthropicFileIds, replaceForeignFileImages } = await import("../src/host-file-images.ts");
const { executeProxyToolAsync } = await import("../src/loop/core.ts");
const { resolveDecompress } = await import("../src/decompress-shared.ts");
const { createSession } = await import("../src/session.ts");
const { parseCompressSettings } = await import("../src/config.ts");
const { applySessionCompressOverride, resolveRequestConfig, resolveSessionCompressOverride } = await import("../src/compress-settings.ts");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
type ProxyOptions = import("../src/config.ts").ProxyOptions;

const FILE_A = "file-aaaaaaaaaaaaaaaaaaaaaaaa";
const FILE_B = "file-bbbbbbbbbbbbbbbbbbbbbbbb";
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const fileImg = (id: string) => ({ type: "image", source: { type: "file", file_id: id } });
const b64Img = () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } });

function toolResultCore(img: unknown, text = "图片 att-17 已读取，路径 C:/fake/att-17.png"): CoreMessage {
    const body = { messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_image", input: { id: "att-17" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text }, img] }] },
    ] };
    const msgs = anthropicToCore(body as never).msgs;
    const tr = msgs.find((m) => m.contentType === "tool-result");
    assert.ok(tr);
    return tr as CoreMessage;
}
function topLevelImageCore(img: unknown): CoreMessage {
    const msgs = anthropicToCore({ messages: [{ role: "user", content: [img, { type: "text", text: "看看这张" }] }] } as never).msgs;
    const m = msgs.find((x) => (x as { imagePart?: boolean }).imagePart === true);
    assert.ok(m);
    return m as CoreMessage;
}

// ---------- 钉不钉（③ 可不可折不翻） ----------

test("钉不钉：不开开关 file 图照上游钉住；开了以后工具结果里的 file 图和 base64 一样可折（来回换来源不翻）；顶层 file 图开了也钉住", () => {
    const on = { foldHostFileImages: true };
    const trFile = toolResultCore(fileImg(FILE_A));
    assert.equal(hasUnrecoverableMediaPayload(trFile), true, "工具结果里的图：不开开关 = 上游行为，钉住");
    assert.equal(hasUnrecoverableMediaPayload(trFile, on), false, "工具结果里的图：开了开关，file 来源可折");
    assert.equal(hasUnrecoverableMediaPayload(toolResultCore(b64Img())), false, "base64 本来就可折");
    assert.equal(hasUnrecoverableMediaPayload(toolResultCore(b64Img()), on), false);
    const topFile = topLevelImageCore(fileImg(FILE_A));
    assert.equal(hasUnrecoverableMediaPayload(topFile), true, "顶层图：不开开关钉住");
    assert.equal(hasUnrecoverableMediaPayload(topFile, on), true, "顶层图：开了开关也钉住（身份只靠位置，放开会盖错图、换来源后露出来）");
    assert.equal(hasUnrecoverableMediaPayload(topLevelImageCore(b64Img()), on), false, "对照：顶层 base64 照旧可折（按字节编身份）");
    assert.deepEqual(mediaFoldOptions(undefined), undefined);
    assert.deepEqual(mediaFoldOptions({ foldHostFileImages: false }), undefined);
    assert.deepEqual(mediaFoldOptions({ foldHostFileImages: true }), { foldHostFileImages: true });
});

test("钉不钉：开关只放 file 图；同一条工具结果里还有认不出的块（document）照样钉住；带签名的网址照样钉住", () => {
    const on = { foldHostFileImages: true };
    const mixed = toolResultCore({ type: "document", source: { type: "file", file_id: FILE_A } });
    assert.equal(hasUnrecoverableMediaPayload(mixed, on), true, "document 不是图，开关不管它");
    const signed = toolResultCore({ type: "image", source: { type: "url", url: "https://cdn.example/x.png?X-Amz-Signature=abc&X-Amz-Expires=60" } });
    assert.equal(hasUnrecoverableMediaPayload(signed, on), true, "会过期的网址照旧钉住");
    assert.equal(isHostHeldFileSource({ type: "file", file_id: "" }), false);
    assert.equal(isHostHeldFileSource({ type: "file" }), false);
    assert.equal(isHostHeldFileSource({ type: "file", file_id: FILE_A }), true);
});

test("身份（③）：消息 id 里没有 file_id——宿主重传换 id、工具结果在 base64/file 之间换，id 都不变", () => {
    assert.equal(toolResultCore(fileImg(FILE_A)).id, toolResultCore(fileImg(FILE_B)).id, "工具结果：换 file_id 不换身份");
    assert.equal(toolResultCore(fileImg(FILE_A)).id, toolResultCore(b64Img()).id, "工具结果：base64 ↔ file 不换身份（身份只看工具名和文字）");
    assert.equal(topLevelImageCore(fileImg(FILE_A)).id, topLevelImageCore(fileImg(FILE_B)).id, "顶层图：换 file_id 不换身份");
    assert.ok(!toolResultCore(fileImg(FILE_A)).id.includes(FILE_A) && !topLevelImageCore(fileImg(FILE_A)).id.includes(FILE_A));
    // 顶层图在 base64 ↔ file 之间换时 id 会变（base64 按字节编，file 没有字节可编）——
    // 这是上游就有的，对账认不回来（审查 t4：换来源后折掉的顶层图露出来、以后一直露着）。
    // 所以顶层 file 图开了开关也钉住（见上面「钉不钉」那条），不进块。
    assert.notEqual(topLevelImageCore(fileImg(FILE_A)).id, topLevelImageCore(b64Img()).id);
});

// ---------- ② 摘要里不写 file_id ----------

test("句柄（②）：file_id 从不当成能取回的句柄（开不开开关都一样，MEDIA REFS 只认网址）", () => {
    assert.deepEqual(extractMediaRefs(toolResultCore(fileImg(FILE_A))), []);
    assert.deepEqual(extractMediaRefs(topLevelImageCore(fileImg(FILE_A))), []);
    assert.deepEqual(extractMediaRefs(toolResultCore({ type: "image", source: { type: "url", url: "https://example.com/a.png" } })), ["https://example.com/a.png"], "对照：网址照旧记");
});

test("占位字（审查 M1）：不开开关时逐字节同上游——工具结果里的 file 图是「[media: image ~NKB]」、顶层的是「[image]」，取图编号照上游挂", () => {
    const tr = toolResultCore(fileImg(FILE_A));
    assert.equal(imageNoteOptions(undefined), undefined);
    assert.equal(imageNoteOptions({ foldHostFileImages: false }), undefined);
    assert.deepEqual(imageNoteOptions({ foldHostFileImages: true }), { hostFileImages: true });
    const off = imagePlaceholders(tr);
    assert.equal(off.length, 1);
    assert.match(off[0]!, /^\[media: image ~\d+KB\]$/, off[0]);
    assert.deepEqual(imagePlaceholders(tr, imageNoteOptions({})), off);
    assert.deepEqual(imagePlaceholders(topLevelImageCore(fileImg(FILE_A))), [IMAGE_PLACEHOLDER]);
    assert.deepEqual(imagePlaceholders(topLevelImageCore(fileImg(FILE_A)), { hostFileImages: true }), [IMAGE_PLACEHOLDER], "顶层 file 图钉着、不进块，开了开关也照上游");
    for (const s of [...off, ...imagePlaceholders(topLevelImageCore(fileImg(FILE_A)))]) assert.ok(!s.includes("已折起") && !s.includes("宿主"), s);
});

test("占位字（②④）：开了开关，工具结果里 file 图的占位不带 file_id、不带 decompress 的取图编号、不说「已折起」；折叠尾巴写「原图在宿主那边」，不写「能还原像素」", () => {
    const tr = toolResultCore(fileImg(FILE_A));
    const on = { hostFileImages: true };
    assert.equal(HOST_HELD_IMAGE_PLACEHOLDER, "[图片（原图在宿主那边）]");
    assert.ok(!HOST_HELD_IMAGE_PLACEHOLDER.includes("已折起"), "占位字是中性的：外部摘要、出口闸那里看到的图不一定折了");
    assert.deepEqual(imagePlaceholders(tr, on), [HOST_HELD_IMAGE_PLACEHOLDER]);
    assert.deepEqual(imagePlaceholdersForSummary(tr, "m00042", on), [HOST_HELD_IMAGE_PLACEHOLDER], "不挂 m00042：decompress({imageRef}) 拿不回它");
    assert.deepEqual(imagePlaceholdersForSummary(toolResultCore(b64Img()), "m00042"), ["[image: png 1x1 · m00042]"], "对照：base64 的照旧挂编号（像素存在本机）");
    const part = partitionFoldedImageNotes([HOST_HELD_IMAGE_PLACEHOLDER, "[image: png 1x1 · m00042]", HOST_HELD_IMAGE_PLACEHOLDER]);
    assert.deepEqual(part, { restorable: ["[image: png 1x1 · m00042]"], hostHeld: 2 });
    const note = hostHeldFoldNote(2);
    assert.match(note, /已折起/);
    assert.match(note, /原图在宿主那边/);
    assert.match(note, /decompress 拿不回图/);
    assert.doesNotMatch(note, /file-|restores pixels|无损/);
});

// ---------- 她自己 compress 一段带 file 图的历史（走真正的 applyRanges） ----------

function foldContext(foldHostFileImages: boolean | undefined) {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { foldHostFileImages?: boolean };
    if (foldHostFileImages !== undefined) config.foldHostFileImages = foldHostFileImages;
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 50;
    const body = { messages: [
        { role: "user", content: [{ type: "text", text: "兔：帮我看看这张图。" + "背景说明。".repeat(60) }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "read_image", input: { id: "att-17" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_img", content: [{ type: "text", text: "图片 att-17 已读取。" + "说明文字。".repeat(60) }, fileImg(FILE_A)] }] },
        { role: "assistant", content: [{ type: "text", text: "看到了，是一只兔在晒太阳。" + "回话内容。".repeat(60) }] },
        { role: "user", content: [{ type: "text", text: "兔：现在接着聊别的。" }] },
    ] };
    const messages = anthropicToCore(body as never).msgs as CoreMessage[];
    const session = createSession(`host-file-${Math.random()}`, { protocol: "anthropic" });
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} };
}

test("折叠（②④）：开了开关，她能把带 file 图的工具结果折进块里；摘要尾巴写「原图在宿主那边」，不含 file_id；decompress 也拿不出 file_id", async () => {
    const ctx = foldContext(true);
    const refs = ctx.session.state.messageRefs.byRaw;
    const ids = ctx.messages.map((m) => m.id);
    const trId = ctx.messages.find((m) => m.contentType === "tool-result")!.id;
    assert.ok(refs[trId] && refs[trId] !== "BLOCKED", `工具结果拿到了可折的编号（${refs[trId]}）`);
    const start = refs[ids[0]!]!;
    const end = refs[ids[3]!]!;
    const her = "2026-11-15 下午 · 兔发来一张图（att-17），她看了，是一只兔在晒太阳；之后聊了几句别的，没有要接着办的事。";
    const result = await executeProxyToolAsync("compress", { content: `${start}–${end} 看图\n${her}` }, ctx as never);
    assert.equal(result.outcome, "applied", result.text);
    const block = ctx.session.state.blocks.find((b) => b.active)!;
    assert.ok(block.effectiveMessageIds.includes(trId), "带图的工具结果折进去了");
    assert.ok(block.summary.startsWith(her), "开头是她自己写的");
    assert.ok(block.summary.includes(hostHeldFoldNote(1)), block.summary);
    assert.ok(!block.summary.includes(FILE_A), "摘要里没有 file_id");
    assert.ok(!block.summary.includes("MEDIA REFS"), "没有「可取回句柄」那一节");
    assert.ok(!block.summary.includes("restores pixels"), "没有「能还原像素」的话");
    const restored = resolveDecompress({ blockId: block.blockId, full: true }, ctx as never);
    assert.ok(!restored.text.includes(FILE_A), "decompress 的结果里也没有 file_id（取回的是文字，不是图）");
    assert.ok(!/"type":\s*"image"/.test(restored.text));
});

test("折叠（对照）：不开开关时带 file 图的工具结果照旧钉住（BLOCKED，不进块）", async () => {
    const ctx = foldContext(undefined);
    const trId = ctx.messages.find((m) => m.contentType === "tool-result")!.id;
    assert.equal(ctx.session.state.messageRefs.byRaw[trId], "BLOCKED");
});

test("decompress 取图失败的回执（审查 M1）：不开开关逐字节同上游；开了才说「file 来源的原图在宿主那边」", () => {
    const UPSTREAM = '[decompress FAILED: no restorable image for ref "m09999" (it carries no image, is URL-sourced with no stored bytes, or is not in this request\'s history). Call decompress({ imageRef: "list" }) to see what is available.]';
    const ctxFor = (config: Record<string, unknown>) => {
        const session = createSession(`img-receipt-${Math.random()}`, { protocol: "anthropic" });
        (session as { incomingImageIndex?: Map<string, unknown[]> }).incomingImageIndex = new Map();
        return { core: createCore(), config, messages: [], session, log: () => {} };
    };
    const off = resolveDecompress({ imageRef: "m09999" }, ctxFor(defaultConfig(200_000) as never) as never);
    assert.equal(off.text, UPSTREAM);
    const offExplicit = resolveDecompress({ imageRef: "m09999" }, ctxFor({ ...defaultConfig(200_000), foldHostFileImages: false }) as never);
    assert.equal(offExplicit.text, UPSTREAM);
    const on = resolveDecompress({ imageRef: "m09999" }, ctxFor({ ...defaultConfig(200_000), foldHostFileImages: true }) as never);
    assert.notEqual(on.text, UPSTREAM);
    assert.match(on.text, /file-sourced image's original stays with the host/);
});

// ---------- ① 出口闸 ----------

test("出口闸（①）：出站里不在这次入站里的 file_id 换成占位字；在的原样；没东西可换时原数组原样返回", () => {
    const inbound = [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x" }, fileImg(FILE_B)] }] },
    ];
    assert.deepEqual([...collectAnthropicFileIds(inbound)], [FILE_B]);
    const outbound = [
        { role: "user", content: [fileImg(FILE_A), { type: "text", text: "hi" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x" }, fileImg(FILE_B), fileImg(FILE_A)] }] },
        { role: "assistant", content: "plain" },
    ];
    const g = replaceForeignFileImages(outbound, collectAnthropicFileIds(inbound));
    assert.equal(g.replaced, 2);
    const s = JSON.stringify(g.messages);
    assert.ok(!s.includes(FILE_A), "旧 id 一个都没出去");
    assert.ok(s.includes(FILE_B), "这次宿主送来的原样出去");
    assert.equal((g.messages[2] as unknown), outbound[2], "没动的消息原样（同一个对象）");
    const clean = replaceForeignFileImages(inbound, collectAnthropicFileIds(inbound));
    assert.equal(clean.replaced, 0);
    assert.equal(clean.messages, inbound, "没东西可换：同一个数组");
});

test("配置：foldHostFileImages 三级都能写，不写时解出来的 Config 没有这个键；也能按会话写（只给她，帮手不跟着放开）", () => {
    const base = defaultConfig(200_000);
    const plain = resolveRequestConfig(base, {}, undefined, "m", 200_000, { nudgeGrowthTokens: 50_000 });
    assert.equal("foldHostFileImages" in plain, false);
    assert.equal(resolveRequestConfig(base, {}, undefined, "m", 200_000, { foldHostFileImages: true }).foldHostFileImages, true);
    assert.equal(parseCompressSettings({ foldHostFileImages: true })?.foldHostFileImages, true);
    assert.equal(parseCompressSettings({ foldHostFileImages: "on" }), undefined);
    const table = { sessions: { "session-her": { foldHostFileImages: true } } };
    const her = resolveSessionCompressOverride(table, ["session-her", undefined]);
    assert.deepEqual(her?.override, { foldHostFileImages: true });
    assert.equal(resolveSessionCompressOverride(table, ["session-helper", "session-helper"]), undefined, "帮手对不上，不放开");
    assert.equal((applySessionCompressOverride(plain, her!.override, 200_000) as { foldHostFileImages?: boolean }).foldHostFileImages, true);
    assert.equal(applySessionCompressOverride(plain, undefined, 200_000), plain);
    assert.deepEqual(parseCompressSettings({ sessions: { s1: { foldHostFileImages: true } } })?.sessions, { s1: { foldHostFileImages: true } });
    assert.equal(parseCompressSettings({ sessions: { s1: { foldHostFileImages: "yes" } } }), undefined);
});

// ---------- 真起代理：出站的 file_id 永远是这一次入站的子集 ----------

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("真起代理（①②）：她折掉带图的那段以后，宿主重传换了 file_id，出站里既没有旧 id 也没有被折的图；没折的图带的是这次的新 id", async () => {
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
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-flash": { context: 1_048_576 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, { preserveRecentMessages: 1, preserveRecentTokens: 0, compress: { minCompressRange: 50, maxSummaryLength: 20000, minSummaryLength: 20 } }),
        compress: { injectTool: true, injectNudge: true, foldHostFileImages: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
        autoUpdate: false, compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
        autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const conv = "session-host-file-e2e";
    // 两张图：一张在会被她折掉的那段里（att-17），一张在后面不折（att-18）
    const history = (idOld: string, idKeep: string) => [
        { role: "user", content: [{ type: "text", text: "兔：帮我看看这张图。" + "背景说明。".repeat(80) }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "read_image", input: { id: "att-17" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_img", content: [{ type: "text", text: "图片 att-17 已读取。" + "说明文字。".repeat(80) }, fileImg(idOld)] }] },
        { role: "assistant", content: [{ type: "text", text: "看到了，是一只兔在晒太阳。" + "回话内容。".repeat(80) }] },
        { role: "user", content: [{ type: "text", text: "兔：再看这张。" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_img2", name: "read_image", input: { id: "att-18" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_img2", content: [{ type: "text", text: "图片 att-18 已读取。" }, fileImg(idKeep)] }] },
        { role: "assistant", content: [{ type: "text", text: "这张也看到了。" }] },
        { role: "user", content: [{ type: "text", text: "兔：好。" }] },
    ];
    const send = async (messages: unknown[]) => {
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv },
            body: JSON.stringify({ model: "deepseek-flash", max_tokens: 1024, stream: true, messages }),
        });
        assert.equal(resp.status, 200);
        await resp.text();
        return JSON.parse(outbound.at(-1)!) as { messages: unknown[] };
    };
    const assertSubset = (out: { messages: unknown[] }, inbound: unknown[], label: string) => {
        const outIds = collectAnthropicFileIds(out.messages);
        const inIds = collectAnthropicFileIds(inbound);
        for (const id of outIds) assert.ok(inIds.has(id), `${label}：出站的 ${id} 必须是这次入站里的`);
    };
    try {
        const OLD_17 = "file-old-17-xxxxxxxxxxxxxxxxx", OLD_18 = "file-old-18-xxxxxxxxxxxxxxxxx";
        const NEW_17 = "file-new-17-xxxxxxxxxxxxxxxxx", NEW_18 = "file-new-18-xxxxxxxxxxxxxxxxx";
        const turn1 = history(OLD_17, OLD_18);
        const out1 = await send(turn1);
        assertSubset(out1, turn1, "第 1 轮");
        assert.ok(JSON.stringify(out1).includes(OLD_17), "第 1 轮还没折，图照发");
        // 从出站里认出编号，照她那样折掉第一段（含 att-17 那张图）。编号只挂在
        // user / tool 消息上：refs[0] 是第一句话，refs[1] 是 att-17 的工具结果，
        // 它后面那条助手回话的编号是 refs[1] + 1。
        const refs = [...JSON.stringify(out1).matchAll(/>\s*(m\d{5})\s*</g)].map((m) => m[1]!);
        assert.ok(refs.length >= 3, `出站里有编号（${refs.length}）`);
        const foldEnd = `m${String(Number(refs[1]!.slice(1)) + 1).padStart(5, "0")}`;
        const fold = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: `${refs[0]}–${foldEnd} 看图\n2026-11-15 下午 · 兔发来一张图（att-17），她看了，是一只兔在晒太阳，聊了几句。` } }),
        });
        const foldBody = (await fold.json()) as { ok?: boolean; outcome?: string; result?: string };
        assert.equal(foldBody.outcome, "applied", JSON.stringify(foldBody).slice(0, 400));
        // 宿主到期前重传：两张图都换了新 id
        const turn2 = history(NEW_17, NEW_18);
        const out2 = await send(turn2);
        const s2 = JSON.stringify(out2);
        assertSubset(out2, turn2, "第 2 轮");
        assert.ok(!s2.includes(OLD_17) && !s2.includes(OLD_18), "旧 id 一个都没出去");
        assert.ok(!s2.includes(NEW_17), "被折掉的那张图不在出站里（像素离开视图）");
        assert.ok(s2.includes(NEW_18), "没折的那张带的是这次宿主送来的新 id");
        assert.ok(s2.includes("原图在宿主那边"), "折叠块里写着图已折起、原图在宿主那边");
    } finally {
        proxy.close(); proxy.closeIdleConnections?.(); await once(proxy, "close");
        upstream.close(); upstream.closeIdleConnections?.();
    }
});
