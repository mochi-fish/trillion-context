// fork search v2 (11-20) — regressions for the review round (fixes.md):
// words with hub / stop / question chars inside (熊兔, 成都, 小时候 …),
// near names (王小明 vs 王小红), a missing latin word next to a present
// Chinese one, digits written in Chinese, full-width input, symbols, a small
// corpus, onebot lead-ins, the recent-group block, the desk follow-up, the
// reply after a question, topic shown once, half emoji, İ, unknown around
// refs, the yield inside a huge block, the no-change fast path, and the
// request-time check of a broken search block. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyRow, compileSettings, clearSearchCorpora, ensureCorpus, type Corpus, type RowSource } from "../src/search-cjk/corpus.ts";
import { markFirst } from "../src/search-cjk/excerpt.ts";
import { foldSameLength, queryUnits } from "../src/search-cjk/tokenize.ts";
import { resolveSearchV2Settings, searchV2AroundOn, searchV2RawUsable, type SearchV2Raw } from "../src/search-cjk/settings.ts";
import { executeSearchAround, renderSearch } from "../src/search-v2.ts";
import type { SearchRow } from "../src/storage/store.ts";
import { ZH_SETTINGS } from "./helpers/search-zh-fixture.ts";

const OWNER = "10001";
const PRIV = `qq:private:${OWNER}`;
const GRP = "qq:group:20002";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

class World {
    rows: SearchRow[] = [];
    byRaw: Record<string, string> = {};
    blocks: Array<Record<string, unknown>> = [];
    private seq = 0;
    private ref = 0;
    private cur: string[] = [];
    add(role: string, kind: string, body: Record<string, unknown>): number {
        this.ref++;
        const id = `raw-${this.ref}`;
        this.byRaw[id] = `m${String(this.ref).padStart(5, "0")}`;
        this.rows.push({ seq: this.seq++, refNum: this.ref, role, kind, retired: false, content: JSON.stringify({ id, role, contentType: kind, ...body }) });
        this.cur.push(id);
        return this.ref;
    }
    hh(n: number): string {
        return `${String(10 + (n % 12)).padStart(2, "0")}:${String((n * 7) % 60).padStart(2, "0")}`;
    }
    /** onebot 0.10.0 private format: `[HH:MM] ` before the envelope */
    owner(t: string, n = 0): number {
        return this.add("user", "text", { text: `（QQ 私聊 · 兔 · ${PRIV}）\n[${this.hh(n)}] <user_message qq="${OWNER}" nickname="晴" mid="${n}">\n${t}\n</user_message>` });
    }
    her(t: string, chat = PRIV): number {
        return this.add("assistant", "tool-call", { toolName: "im_send", toolCallId: `c${this.seq}`, text: JSON.stringify({ chat, text: t }) });
    }
    /** onebot 0.10.0 group format (optionally a restricted user) */
    grpAt(who: string, qq: string, t: string, n = 0, restricted = false): number {
        const lead = `${restricted ? "[受限用户:仅问答] " : ""}[${this.hh(n)} ${who}(${qq})·成员][@我] `;
        return this.add("user", "text", { text: `（QQ 群 20002 · 有人 @ 你 · ${GRP}）\n${lead}<user_message qq="${qq}" nickname="${who}" mid="${n}">\n${t}\n</user_message>` });
    }
    grpRecent(lines: string[]): number {
        return this.add("user", "text", { text: `（QQ 群 20002 · 群聊 · ${GRP}）\n<group_recent>\n${lines.join("\n")}\n</group_recent>` });
    }
    desk(t: string): number {
        return this.add("user", "text", { text: `（桌面 · 兔直接打的，写在这里兔看得到）\n${t}` });
    }
    herText(t: string): number {
        return this.add("assistant", "text", { text: t });
    }
    tool(name: string, t: string): number {
        return this.add("tool", "tool-result", { toolName: name, toolCallId: `t${this.seq}`, text: t });
    }
    close(topic: string, summary: string): void {
        this.blocks.push({ blockId: `b${this.blocks.length + 1}`, tier: 1, topic, summary, active: false, effectiveMessageIds: this.cur, directBlockIds: [] });
        this.cur = [];
    }
    get state() {
        return { blocks: this.blocks, messageRefs: { byRaw: this.byRaw } } as never;
    }
    source(counter?: { pages: number }): RowSource {
        return {
            page: (_id, after, limit) => {
                if (counter) counter.pages++;
                return this.rows.filter((r) => r.seq > after).slice(0, limit);
            },
            byRefRange: (_id, lo, hi) => this.rows.filter((r) => r.refNum !== null && r.refNum >= lo && r.refNum <= hi),
        };
    }
}

// common chars everywhere (成、首、贴、熊、粮、都、京、咖、酒、吧、时、虫), 现在 in most windows
const FILL = [
    "现在都几点了，早点睡吧", "首先把作业写完再说", "那个熊孩子又在群里刷屏", "小熊饼干还剩两包", "粮食涨价了，菜也贵",
    "成绩出来了吗，现在好紧张", "首页推荐全是广告", "贴纸到了，贴在电脑上", "都市传说那期视频挺吓人", "现在去北京的票不好买",
    "早上喝了一杯咖啡", "昨晚喝酒喝多了，好吧下次少喝", "等了两个小时才排到", "院子里好多小虫子", "现在下雨了，记得带伞",
    "任务完成了，挺成功的", "现在有点困", "好吧，那就明天再说",
];

function buildMain(): World {
    const w = new World();
    let n = 0;
    for (let b = 0; b < 40; b++) {
        for (let k = 0; k < 6; k++) {
            w.owner(FILL[(b * 7 + k) % FILL.length]!, n++);
            w.her(FILL[(b * 5 + k + 3) % FILL.length]!);
        }
        w.close(`日常 ${b}`, `兔和你随便聊了聊，${FILL[b % FILL.length]}`);
    }
    w.owner("下个月想去成都看看", n++);
    w.her("成都的火锅很出名");
    w.owner("熊兔基地要早点去，下午熊兔都在睡", n++);
    w.close("旅行", "兔想去旅行。");
    w.owner("我想买点兔粮，你帮我记一下牌子", n++);
    w.her("记下了：渴望，六种鱼那款");
    w.owner("世界和平最重要", n++);
    w.owner("今天好冷，穿暖和点", n++);
    w.her("我的存在感好低啊");
    w.owner("我了解你的意思", n++);
    w.close("杂事", "兔让你记兔粮牌子。");
    w.tool("bili_humanism_read", "视频《哪吒》的弹幕好多，大家都在刷经典台词");
    w.owner("在贴吧看到一个帖子，讲怎么养多肉", n++);
    w.owner("你好呀，今天怎么样", n++);
    w.owner("小时候我住在海边，每天去捡贝壳", n++);
    w.tool("bili_humanism_read", "视频《咖波兔兔虫的一天》UP 主：某某。弹幕最多的一句：太可爱了");
    w.close("看视频", "你看了几个视频。");
    w.owner("王小红今天请我喝了奶茶", n++);
    w.owner("晚上吃了麻辣香锅，好辣", n++);
    w.tool("mc", "挖到了三颗钻石，赶紧做了一把镐");
    w.owner("书架终于装好了，花了一下午", n++);
    w.close("周末", "兔周末装了书架。");
    // a long message: the number sits far into the window (RC-8)
    w.owner(`${"今天的流水账：上班、开会、吃饭、回家，路上看了会儿书，晚上又看了会儿剧。".repeat(14)}半夜开始发烧到三十八度五，赶紧吃了药`, n++);
    w.owner("我在 ＶＲＣｈａｔ 里遇到一个会弹琴的人", n++);
    w.owner("１２月要考试了，好慌", n++);
    w.close("生病", "兔半夜发烧了。");
    // question → answer (H-2), group lead-ins (H-3), recent block (H-5), desk follow-up (H-6)
    w.owner("我们周六去吃的那家火锅店叫什么来着？", n++);
    w.her("老码头呀，你还说毛肚好吃");
    w.grpAt("阿树", "123456789", "@大肥鱼 你去过三亚吗", n++);
    w.grpAt("路人甲", "987654321", "@大肥鱼 推荐一个滑板牌子", n++, true);
    w.grpRecent(["20:12 阿树：烤肉店新开了一家", "20:13 你：真的吗", "20:14 七七：周末一起去吧"]);
    w.desk("明天记得提醒我拿快递，取件码 3527");
    w.herText("好的，明天早上提醒你拿快递，取件码我记下了：3527。");
    w.close("周末和火锅", "兔问了周六那家火锅店；你记下了快递取件码。");
    w.add("user", "text", { text: "（Claude（帮兔打理插件的那个 AI，不是兔） · ai:desk）\n说个事：芝士蛋糕的做法换了。" });
    w.grpAt("abcdefghijklmnopqrs😀尾巴", "555666", "@大肥鱼 早", n++);
    w.close("abcdefghijklmnopqrstuvwxyz123😀尾巴", "说了芝士蛋糕。");
    return w;
}

const S = resolveSearchV2Settings({ ...ZH_SETTINGS, laneLabels: { ...ZH_SETTINGS.laneLabels, "qq:group:": "QQ 群 {id}" } }, "deepseek-flash");
let W: World;
let C: Corpus;

const items = (out: string): Array<{ head: string; text: string }> => {
    const res: Array<{ head: string; text: string }> = [];
    for (const line of out.split("\n")) {
        if (/^\[\d+\] /.test(line)) res.push({ head: line, text: "" });
        else if (res.length > 0 && line.startsWith("  ")) res[res.length - 1]!.text += line.slice(2).replace(/[【】]/g, "") + "\n";
    }
    return res;
};

test("setup: the synthetic world builds", async () => {
    clearSearchCorpora();
    W = buildMain();
    C = (await ensureCorpus("fixes", W.state, S, { rows: W.source() }))!;
    assert.ok(C.windows.length > 40, `windows ${C.windows.length}`);
});

test("H-1 / RC-1: words with a hub, stop char or question word inside are found whole", () => {
    for (const word of ["成都", "熊兔", "兔粮", "和平", "暖和", "存在", "了解", "哪吒", "贴吧", "你好", "我们", "小时候", "兔兔虫"]) {
        const out = renderSearch(word, 5, C, W.state, S, { aroundOn: true }).out;
        assert.match(out, /找到 \d+ 处原话/, `${word}: found\n${out}`);
        const its = items(out);
        assert.ok(its.length > 0, `${word}: items`);
        for (const it of its) assert.ok(it.text.includes(word), `${word}: every hit has the word\n${out}`);
        assert.ok(out.includes(`【${word}】`) || word === "我们", `${word}: marked whole\n${out}`);
    }
    // a sentence-final particle and a second keyword
    const both = renderSearch("去过 成都吗", 5, C, W.state, S).out;
    assert.match(both, /成都/);
});

test("H-1: words that are not there say so (no hits made of their common chars)", () => {
    for (const word of ["京都", "兔咖", "酒吧", "首都"]) {
        const r = renderSearch(word, 5, C, W.state, S);
        assert.equal(r.hits, 0, `${word}: no hits\n${r.out}`);
        assert.equal(r.summaries, 0, `${word}: no summaries\n${r.out}`);
        assert.match(r.out, /在折起来的旧对话里没找到/, word);
        assert.match(r.out, new RegExp(`「${word}」一处都没有`), word);
    }
});

test("H-1: a word everywhere is 太宽, not 没找到; hubs only is 太宽", () => {
    const r = renderSearch("现在", 5, C, W.state, S).out;
    assert.match(r, /太宽/);
    assert.ok(!r.includes("在折起来的旧对话里没找到"), r);
    assert.match(renderSearch("兔 你 我", 5, C, W.state, S).out, /太宽/);
});

test("RC-2: a name with one char off is a near match, never 「找到」", async () => {
    const a = renderSearch("王小明", 5, C, W.state, S).out;
    assert.ok(!/找到 \d+ 处原话/.test(a), a);
    assert.match(a, /没有原样对上的/);
    assert.match(a, /「明」没对上/);
    const b = renderSearch("麻辣烫", 5, C, W.state, S).out;
    assert.ok(!/找到 \d+ 处原话/.test(b), b);
    assert.match(b, /「烫」没对上/);
    // 火锅好吃 vs 火锅很好吃: every char is covered → a real hit (position coverage)
    const w2 = new World();
    for (let i = 0; i < 30; i++) { w2.owner(FILL[i % FILL.length]!, i); w2.close(`t${i}`, "s"); }
    w2.owner("火锅很好吃，下次还去", 99);
    w2.close("火锅", "s");
    const cp = await ensureCorpus("fixes-cover", w2.state, S, { rows: w2.source() });
    assert.match(renderSearch("火锅好吃", 5, cp!, w2.state, S).out, /找到 1 处原话/);
});

test("RC-3: a latin word that occurs nowhere does not sink the Chinese part", () => {
    const a = renderSearch("diamond 钻石", 5, C, W.state, S).out;
    assert.match(a, /找到 \d+ 处原话/, a);
    assert.match(a, /「diamond」一处都没有/);
    assert.match(renderSearch("IKEA 书架", 5, C, W.state, S).out, /找到 \d+ 处原话/);
});

test("RC-8: an Arabic number finds and marks the Chinese spelling; the tip never has an empty query", () => {
    const out = renderSearch("38", 5, C, W.state, S, { aroundOn: true }).out;
    assert.match(out, /【三十八】/, out);
    assert.ok(!out.includes('query: ""'), out);
    assert.ok(queryUnits("38")[0]!.surfaces.includes("三十八"));
    assert.ok(queryUnits("2")[0]!.surfaces.includes("两"));
});

test("RC-12: full-width input meets ASCII text both ways; symbols say they cannot be searched", () => {
    assert.equal(foldSameLength("ＶＲＣｈａｔ　１２月"), "vrchat 12月");
    assert.match(renderSearch("VRChat", 5, C, W.state, S).out, /找到 \d+ 处原话/);
    assert.match(renderSearch("ＶＲＣｈａｔ", 5, C, W.state, S).out, /找到 \d+ 处原话/);
    assert.match(renderSearch("12月 考试", 5, C, W.state, S).out, /找到 \d+ 处原话/);
    assert.match(renderSearch("😂", 5, C, W.state, S).out, /符号找不了/);
});

test("RC-9: a small corpus (9 windows) still finds a word that is there once", async () => {
    const w = new World();
    for (let i = 0; i < 9; i++) { w.owner(i === 4 ? "楼下的橘兔叫麻薯" : FILL[i]!, i); w.close(`t${i}`, "s"); }
    const cp = (await ensureCorpus("fixes-small", w.state, S, { rows: w.source() }))!;
    assert.equal(cp.windows.length, 9);
    const out = renderSearch("麻薯", 5, cp, w.state, S).out;
    assert.match(out, /找到 1 处原话/, out);
    assert.ok(!out.includes("到处都有"));
});

test("H-3: onebot lead-ins and QQ numbers never become lines", () => {
    const all = C.windows.map((x) => x.text).join("\n");
    for (const bad of ["·成员", "[@我]", "受限用户", "123456789", "987654321"]) assert.ok(!all.includes(bad), `corpus has ${bad}`);
    assert.ok(!/^\[\d{1,2}:\d{2}/m.test(all), "no [HH:MM] line");
    const ref = W.rows.find((r) => r.content.includes("我了解你的意思"))!.refNum!;
    const a = executeSearchAround({ around: `m${String(ref).padStart(5, "0")}` }, { id: "fixes", state: W.state, metadata: {} } as never, S, W.source())!;
    assert.ok(!/m\d{5} \[\d{1,2}:\d{2}\]/.test(a.text), a.text);
});

test("H-5: the recent-group block keeps one line per message; a {id} label tells groups apart", () => {
    const c = compileSettings(S);
    const r = W.rows.find((x) => x.content.includes("group_recent"))!;
    const msg = classifyRow(r, S, c, new Map())!;
    assert.deepEqual(msg.lines.map((l) => l.text), ["20:12 阿树：烤肉店新开了一家", "20:13 你：真的吗", "20:14 七七：周末一起去吧"]);
    assert.equal(msg.laneLabel, "QQ 群 20002");
    const plain = resolveSearchV2Settings(ZH_SETTINGS, undefined);
    assert.equal(classifyRow(r, plain, compileSettings(plain), new Map())!.laneLabel, "QQ 群", "no {id}: as configured");
});

test("H-6: her visible text right after a desk message joins the desk lane (search and around)", () => {
    const win = C.windows.find((x) => x.text.includes("取件码我记下了"))!;
    assert.equal(win.laneLabel, "桌面");
    assert.ok(win.text.includes("明天记得提醒我拿快递"), "the desk message and her reply share a window");
    const deskRef = W.rows.find((r) => r.content.includes("取件码 3527"))!.refNum!;
    const a = executeSearchAround({ around: `m${String(deskRef).padStart(5, "0")}` }, { id: "fixes", state: W.state, metadata: {} } as never, S, W.source())!;
    assert.match(a.text, /前后（桌面/);
    assert.match(a.text, /你：好的，明天早上提醒你拿快递/);
    // her text elsewhere is not 「主会话」
    assert.ok(!C.windows.some((x) => x.laneLabel === "主会话"));
});

test("H-7 / RC-10: a long label keeps 「不是兔」; names and topics are never cut inside an emoji", () => {
    assert.ok(C.windows.some((x) => x.laneLabel === "Claude（…不是兔）"), C.windows.map((x) => x.laneLabel).filter((l) => l.startsWith("Claude")).join("|"));
    for (const x of C.windows) assert.ok(!LONE_SURROGATE.test(x.text) && !LONE_SURROGATE.test(x.laneLabel), x.text);
    const out = renderSearch("芝士蛋糕", 5, C, W.state, S).out;
    assert.match(out, /芝士蛋糕/);
    assert.ok(!LONE_SURROGATE.test(out), out);
});

test("H-2: the leftover budget shows the reply right after a hit", () => {
    const out = renderSearch("火锅店", 5, C, W.state, S).out;
    assert.match(out, /【火锅店】叫什么来着/);
    assert.match(out, /你：老码头呀/, out);
});

test("H-8: a summary line shows its topic once", () => {
    const out = renderSearch("取件码", 5, C, W.state, S).out;
    const line = out.split("\n").find((l) => l.startsWith("- ") && l.includes("周末和火锅"));
    assert.ok(line, out);
    assert.equal(line!.split("周末和火锅").length - 1, 1, line);
});

test("a pathological query (one 300,000-letter word) does not overflow the stack", () => {
    const r = renderSearch(`${"x".repeat(300_000)} 钻石`, 5, C, W.state, S);
    assert.equal(typeof r.out, "string");
});

test("RC-11: the 【】 mark lands on the matched chars after İ", () => {
    assert.equal(markFirst("İİİ后面才是麻薯这个词", "麻薯"), "İİİ后面才是【麻薯】这个词");
});

test("RC-13: around with a number that is not there says so", () => {
    const sess = { id: "fixes", state: W.state, metadata: {} } as never;
    for (const ref of ["m99999", "m0"]) assert.match(executeSearchAround({ around: ref }, sess, S, W.source())!.text, /没有 m\d{5} 这个编号/);
});

test("RC-7: nothing changed → one page probe, no rebuild", async () => {
    const first = await ensureCorpus("fixes", W.state, S, { rows: W.source() });
    const counter = { pages: 0 };
    const again = await ensureCorpus("fixes", W.state, S, { rows: W.source(counter) });
    assert.equal(again, first);
    assert.equal(counter.pages, 1);
});

test("RC-4: one huge block yields to the event loop inside the block", async () => {
    clearSearchCorpora();
    const w = new World();
    const line = "今天的流水账：上班、开会、吃饭、回家，路上看了会儿书，晚上又看了会儿剧，还给植物浇了水，想了想明天的事。";
    for (let i = 0; i < 12000; i++) w.owner(`${i} ${line}${line}`, i);
    w.close("一大块", "一大块流水账");
    let last = Date.now();
    let maxGap = 0;
    let ticks = 0;
    let stop = false;
    const tick = (): void => {
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
        if (!stop) setImmediate(tick);
    };
    setImmediate(tick);
    const cp = await ensureCorpus("fixes-big", w.state, S, { rows: w.source() });
    stop = true;
    console.log(`[rc4] windows=${cp?.windows.length} ticks=${ticks} maxGap=${maxGap}ms builtMs=${cp?.builtMs}`);
    assert.ok(cp && cp.windows.length >= 1600, `windows ${cp?.windows.length}`);
    assert.ok(ticks >= 4, `ticks ${ticks}`);
    assert.ok(maxGap < 100, `longest stretch without yielding: ${maxGap} ms`);
    clearSearchCorpora();
});

test("F5: a broken search block turns the engine and around off at request time", () => {
    const good: SearchV2Raw = { engine: "cjk", around: true, hubs: ["兔"] };
    assert.ok(searchV2RawUsable(good));
    assert.ok(searchV2AroundOn(good));
    for (const bad of [{ engine: "cjk", hubs: [1, 2] }, { engine: "cjk", budget: "lots" }, { engine: "cjk", headPatterns: ["(unclosed"] }, { engine: "cjk", around: true, laneLabels: { a: 1 } }]) {
        assert.equal(searchV2RawUsable(bad), false, JSON.stringify(bad));
        assert.equal(searchV2AroundOn(bad), false, JSON.stringify(bad));
    }
    assert.equal(searchV2RawUsable(undefined), false);
    assert.equal(searchV2AroundOn({ planAware: true }), false);
});

// G2 终审 I1：around 只给看得到的编号——有活行的，或被某个块盖住的（decompress 够得着的）。
// 只剩旧一代、又没有块盖住的行（会话已经不带它们）不出现在前后里，填它的编号也只答「没有这个编号」。
test("G2 终审 I1: around never shows a retired row no block covers, and its number reads as missing", () => {
    const w = new World();
    const cur = (): string[] => (w as unknown as { cur: string[] }).cur;
    const live1 = w.owner("周六去吃火锅吧", 1);
    const live2 = w.her("好呀，老码头");
    w.close("火锅", "约了火锅。");
    // an older generation no block covers (dropped from the session): retired, never folded
    const gone = w.owner("这一句已经被拿掉了，口令是 zq7Hx2Kp9", 2);
    w.rows.at(-1)!.retired = true;
    cur().length = 0;
    // an older generation a block covers: retired but folded (decompress reaches it)
    const folded = w.owner("旧一代里被块盖住的那句，羊肉串", 3);
    w.rows.at(-1)!.retired = true;
    w.close("旧", "旧一代。");
    // still in the session, not folded yet
    const recent = w.owner("还在眼前的一句，明天见", 4);
    const sess = { id: "i1", state: w.state, metadata: {} } as never;
    const mr = (n: number): string => `m${String(n).padStart(5, "0")}`;
    const out = executeSearchAround({ around: mr(live1) }, sess, S, w.source())!.text;
    for (const n of [live1, live2, folded, recent]) assert.ok(out.includes(mr(n)), `${mr(n)} shows`);
    assert.ok(!out.includes(mr(gone)), "the uncovered retired ref is not listed");
    assert.ok(!out.includes("被拿掉") && !out.includes("zq7Hx2Kp9"), "its text is not shown");
    const asked = executeSearchAround({ around: mr(gone) }, sess, S, w.source())!.text;
    assert.match(asked, /没有 m\d{5} 这个编号/);
    assert.equal(asked, executeSearchAround({ around: "m99999" }, sess, S, w.source())!.text.replace("m99999", mr(gone)), "same answer as a number that never existed");
    // the covered retired one is a fine centre
    assert.ok(executeSearchAround({ around: mr(folded) }, sess, S, w.source())!.text.includes("羊肉串"));
});
