// fork（养成向）：中文催压——只走配置（fish 规则包 0.2.0），不改代码。
//
// 她的 fish 包（~/.config/billion-context/packs/fish.json）原来只换了读摘要那一节和
// 二三层的引导；催压的抬头（efficiencyNote「This is an efficiency nudge…」、
// emergencyHeader「⚠️ Context limit reached — compress now…」）和 compress /
// decompress / search_context 三个工具的说明还是英文。内核早就留了这几格
// （packs.ts 的 nudgeSections、toolPrompts），这一版包把它们填成中文，只改说法、
// 不改意思。tests/fixtures/fish-pack-zh/ 是工作区 sessionless/w/fish-pack-zh/
// build-pack-zh.mjs 拼出来的那份（逐字节相同），compress-block.json 是线上
// compress 块的拷贝（只为核对两个抬头里抄进来的「道理」和它逐字相同）。
//
// 这份测试守住：
//   1. 包文件不带 BOM（包文件不去 BOM，带了就静默退回 default）、经真正的包解析链
//      认得出、每一格都没被丢掉。
//   2. 平常、紧急、二层三种催压都是中文抬头，英文原句一个都不剩，道理正好出现一次、
//      和 compress.prompts.compressPhilosophy 逐字相同。
//   3. 插件清单（DSH 注册工具用的就是它）里三个工具的说明和参数说明都换成中文，
//      别的（参数类型、必填项、第四个工具 acp_status）不变。
// 审查后（2026-11-15 夜）加两条：
//   4. compress 说明里「换行写成 \n」是字面的反斜杠 + n（原来 JSON 里写成 \n，
//      解出来是真换行，她看到的是「换行写成 ⏎；」）。
//   5. 分层（二、三层）的紧急催压：包给了 emergencyHeader 时用它当抬头，不再是
//      「不是说已经满了……」的平常抬头紧跟英文 EMERGENCY 行（内核 nudge-text.ts
//      一处小改，只在包给了这一格时生效；不给包时逐字节同上游）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";

const { createDirPackSource, defaultConfig, renderNudgeText, sanitizePackSurface } = await import("acp-kernel");
const { resolveCompressPrompts, resolveCompressSurfaceDetailed } = await import("../src/compress-settings.ts");
const { handlePluginManifest } = await import("../src/plugin.ts");

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fish-pack-zh");
const packRaw = readFileSync(path.join(FX, "fish.json"));
const pack = JSON.parse(packRaw.toString("utf8")) as {
    version: string;
    nudgeSections: Record<string, string>;
    promptSections: Record<string, string>;
    toolPrompts: Record<string, { description: string; paramDescriptions: Record<string, string> }>;
};
const compressBlock = JSON.parse(readFileSync(path.join(FX, "compress-block.json"), "utf8")) as { acknowledgePromptsRisk: boolean; promptPack: string; prompts: Record<string, string> };

const ENGLISH = [
    "This is an efficiency nudge",
    "Context limit reached — compress now",
    "Prioritize consumed tool outputs",
    "A separate, stronger alert",
];

function decision(over: Record<string, unknown>) {
    return {
        shouldInject: true,
        reason: "test",
        compressibleRanges: [{ startRef: "m00010", endRef: "m00040", count: 30, tokens: 12000, toolPct: 60, textPct: 40 }],
        protectedRanges: [],
        contextUsage: 0.8,
        tier: null,
        breakdown: { usage: 0.8, growth: 0, growthReference: 0, effectiveThreshold: 0, nudgeGrowthTokens: 0, growthFloor: 0 },
        ...over,
    } as never;
}

test("包文件：不带 BOM；经真正的包解析链认得出（名字 fish、版本 0.2.0）；每一格都在", () => {
    assert.notEqual(packRaw[0], 0xef, "包文件不去 BOM，带了就静默退回 default");
    const resolved = createDirPackSource("user", FX).resolve("fish");
    assert.ok(resolved, "resolver 认得出");
    assert.equal(resolved!.version, "0.2.0");
    const surface = sanitizePackSurface(pack as never);
    assert.deepEqual(Object.keys(surface.nudgeSections ?? {}).sort(), ["efficiencyNote", "emergencyHeader", "t2Guidance", "t3Guidance"]);
    assert.deepEqual(Object.keys(surface.promptSections ?? {}), ["summariesInContext"]);
    assert.deepEqual(Object.keys(surface.toolPrompts ?? {}).sort(), ["compress", "decompress", "search_context"]);
    for (const [name, tp] of Object.entries(pack.toolPrompts)) {
        assert.deepEqual(surface.toolPrompts![name], tp, `${name}：说明和每个参数说明都原样保留`);
    }
    const viaSettings = resolveCompressSurfaceDetailed({ promptPack: "fish" }, { projectDir: path.join(FX, "no-such-dir"), userDirs: [FX] });
    assert.equal(viaSettings.packName, "fish");
    assert.equal(viaSettings.packVersion, "0.2.0");
});

test("两个抬头里的「道理」和 compress.prompts.compressPhilosophy 逐字相同（这两格一覆盖内核就不再自动接道理）", () => {
    const philosophy = compressBlock.prompts.compressPhilosophy;
    assert.ok(philosophy.length > 50);
    for (const key of ["efficiencyNote", "emergencyHeader"]) {
        const v = pack.nudgeSections[key]!;
        assert.ok(v.endsWith(`\n\n${philosophy}`), `${key} 以道理全文结尾`);
        assert.equal(v.split(philosophy).length - 1, 1, `${key} 里道理正好一次`);
    }
});

test("催压：平常、紧急、二层三种都是中文抬头，英文原句一个都不剩，道理正好一次", () => {
    const prompts = resolveCompressPrompts(compressBlock as never);
    const sections = sanitizePackSurface(pack as never).nudgeSections;
    const philosophy = compressBlock.prompts.compressPhilosophy;
    const cases: Array<[string, unknown, RegExp]> = [
        ["平常", decision({}), /^这是一条提醒你早点整理/],
        ["紧急", decision({ breakdown: { usage: 1.2, growth: 0, growthReference: 0, effectiveThreshold: 0, nudgeGrowthTokens: 0, growthFloor: 0, emergencyOverride: 1 } }), /^⚠️ 上下文到上限了，现在就整理。先压已经用完的工具输出。/],
        ["二层", decision({ tier: 2, tierTargetBlocks: [{ blockId: "b1", tier: 1, summary: "x", effectiveMessageIds: ["a"], compressedTokens: 100 }, { blockId: "b2", tier: 1, summary: "y", effectiveMessageIds: ["b"], compressedTokens: 100 }] }), /^这是一条提醒你早点整理/],
    ];
    for (const [label, d, head] of cases) {
        const r = renderNudgeText(d as never, prompts, sections, "anthropic");
        assert.match(r.text, head, `${label}：中文抬头`);
        for (const en of ENGLISH) assert.ok(!r.text.includes(en), `${label}：没有「${en}」`);
        assert.equal(r.text.split(philosophy).length - 1, 1, `${label}：道理正好一次`);
    }
    // 对照：不带包时还是英文（证明上面测的确实是包在起作用）
    const plain = renderNudgeText(decision({}) as never, prompts, {}, "anthropic");
    assert.ok(plain.text.includes("This is an efficiency nudge"));
});

test("分层紧急催压（审查 S5）：包给了 emergencyHeader 时用中文紧急抬头，不再说「不是说已经满了」；不给包时和上游一样", () => {
    const prompts = resolveCompressPrompts(compressBlock as never);
    const sections = sanitizePackSurface(pack as never).nudgeSections;
    const philosophy = compressBlock.prompts.compressPhilosophy;
    const blocks = [{ blockId: "b1", tier: 1, summary: "x", effectiveMessageIds: ["a"], compressedTokens: 100 }, { blockId: "b2", tier: 1, summary: "y", effectiveMessageIds: ["b"], compressedTokens: 100 }];
    const emergencyBreakdown = { usage: 1.2, growth: 0, growthReference: 0, effectiveThreshold: 0, nudgeGrowthTokens: 0, growthFloor: 0, emergencyOverride: 1 };
    for (const tier of [2, 3]) {
        const d = decision({ tier, tierTargetBlocks: blocks, breakdown: emergencyBreakdown });
        const r = renderNudgeText(d as never, prompts, sections, "anthropic");
        assert.equal(r.voice, "emergency");
        assert.match(r.text, /^⚠️ 上下文到上限了，现在就整理。/, `二/三层（${tier}）紧急：中文紧急抬头`);
        assert.ok(!r.text.includes("不是说已经满了"), `${tier}：不再自相矛盾`);
        assert.ok(r.text.includes(`[EMERGENCY — TIER ${tier}`), `${tier}：分层触发行还在（写死的英文，包没有这一格）`);
        assert.equal(r.text.split(philosophy).length - 1, 1, `${tier}：道理正好一次`);
        // 不紧急的分层催压照旧用平常抬头
        const gentle = renderNudgeText(decision({ tier, tierTargetBlocks: blocks }) as never, prompts, sections, "anthropic");
        assert.match(gentle.text, /^这是一条提醒你早点整理/);
        // 不给包：和上游一样（平常抬头 + EMERGENCY 行）
        const plain = renderNudgeText(d as never, prompts, {}, "anthropic");
        assert.ok(plain.text.startsWith("This is an efficiency nudge"), `${tier}：不给包时逐字节同上游`);
    }
});

test("compress 说明（审查 S4）：「换行写成」后面是字面的反斜杠 + n，不是真换行；引号那处是反斜杠 + 引号", () => {
    for (const [label, s] of [["说明", pack.toolPrompts.compress!.description], ["content 参数说明", pack.toolPrompts.compress!.paramDescriptions.content!]] as const) {
        const i = s.indexOf("换行写成 ");
        assert.ok(i >= 0, label);
        assert.equal(s.slice(i + 5, i + 7), "\\n", `${label}：反斜杠 + n`);
        const q = s.indexOf("写成 \\\"");
        assert.ok(q >= 0, `${label}：引号写成 \\"`);
    }
    const zh = manifestTools(pack.toolPrompts).find((t) => t.name === "compress")!;
    assert.ok(zh.description.includes("换行写成 \\n；"), "清单里（DSH 注册用的）也是反斜杠 + n");
    assert.ok(zh.input_schema.properties.content!.description!.includes("换行写成 \\n；"));
});

function manifestTools(toolPrompts?: unknown): Array<{ name: string; description: string; input_schema: { properties: Record<string, { type?: string; description?: string }>; required?: string[] } }> {
    let body = "";
    const res = { writeHead: () => undefined, end: (v: unknown) => { body = String(v); } } as never;
    handlePluginManifest(res, defaultConfig(400_000), toolPrompts as never);
    return (JSON.parse(body) as { tools: { anthropic: never[] } }).tools.anthropic;
}

test("插件清单（DSH 注册工具用它）：三个工具的说明和参数说明换成中文，类型、必填、acp_status 都不变", () => {
    const zh = manifestTools(pack.toolPrompts);
    const en = manifestTools(undefined);
    assert.deepEqual(zh.map((t) => t.name), en.map((t) => t.name), "工具一个不多一个不少，顺序不变");
    for (const name of ["compress", "decompress", "search_context"]) {
        const z = zh.find((t) => t.name === name)!;
        const e = en.find((t) => t.name === name)!;
        assert.ok(z.description.startsWith(pack.toolPrompts[name]!.description), `${name}：说明以包里的中文开头`);
        assert.deepEqual(Object.keys(z.input_schema.properties), Object.keys(e.input_schema.properties), `${name}：参数不变`);
        assert.deepEqual(z.input_schema.required, e.input_schema.required, `${name}：必填不变`);
        for (const [p, spec] of Object.entries(z.input_schema.properties)) {
            assert.equal(spec.type, e.input_schema.properties[p]!.type, `${name}.${p}：类型不变`);
            assert.equal(spec.description, pack.toolPrompts[name]!.paramDescriptions[p], `${name}.${p}：参数说明是包里的中文`);
        }
    }
    const status = zh.find((t) => t.name === "acp_status")!;
    assert.deepEqual(status, en.find((t) => t.name === "acp_status"), "acp_status 原样");
});
