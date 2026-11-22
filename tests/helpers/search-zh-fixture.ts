// fork search v2 (11-20): a synthetic Chinese companion-chat corpus for the
// E1 bench (research1119 search.md §8). Everything here is invented: a user
// ("兔", owner QQ 10001) chatting with the companion over a bridge that
// prefixes header lines and onebot envelopes, a group with friends, desk
// notes, MC and B站 experiences, plus noise the corpus must ignore (acp
// receipts, sts JSON, reasoning, host notices, media paths). Deterministic:
// a fixed-seed LCG, no clock.
import type { CompressionState } from "acp-kernel";
import type { SearchRow } from "../../src/storage/store.ts";
import type { RowSource } from "../../src/search-cjk/corpus.ts";
import type { SearchV2Raw } from "../../src/search-cjk/settings.ts";

export const OWNER_ID = "10001";
export const PRIVATE_LANE = `qq:private:${OWNER_ID}`;
const GROUP_LANE = "qq:group:20002";

/** The deployment-style settings the bench runs with (her shape, fake ids). */
export const ZH_SETTINGS: SearchV2Raw = {
    engine: "cjk",
    around: true,
    hubs: ["兔", "她", "我", "你", "大肥鱼", "肥鱼", "大肥"],
    aliases: [["MC", "我的世界", "minecraft"], ["尖塔", "杀戮尖塔", "sts"], ["B站", "bilibili", "哔哩哔哩"]],
    headPatterns: [
        "^（(?<label>[^\\n]*?) · (?<lane>[a-z][a-z0-9]*:[^\\n）]*)）[ \\t]*(?:\\r?\\n|$)",
        "^（(?<label>桌面 · 兔直接打的，写在这里兔看得到)）[ \\t]*(?:\\r?\\n|$)",
    ],
    envelopePattern: "<user_message(?<attrs>[^>\\n]*)>\\r?\\n?(?<text>[\\s\\S]*?)\\r?\\n?</user_message>",
    mediaPattern: "\\[(?<kind>图片|表情包|语音|视频|文件|卡片|分享|联系人|位置|戳一戳|引用里的图片)(?:[:：][^\\]\\n]*)?\\]",
    dropPatterns: ["^Time sampled while", "^\\[model changed:"],
    speakerAttr: "nickname",
    idAttr: "qq",
    ownerIds: [OWNER_ID],
    ownerName: "兔",
    ownerLabels: ["QQ 私聊 · 兔", "桌面 · 兔直接打的，写在这里兔看得到"],
    selfName: "你",
    laneLabels: { "QQ 私聊 · 兔": "兔的私聊", "桌面 · 兔直接打的，写在这里兔看得到": "桌面", "qq:group:": "QQ 群" },
};

type Who = "owner" | "her" | "friend" | "desk" | "bili" | "read" | "mc" | "herText";

interface Fact {
    id: string;
    who: Who;
    text: string;
    friend?: string;
}

/** Every fact message and the queries that must find it. */
export interface ZhQuery {
    cat: "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k";
    q: string;
    /** Fact id the query targets (absent for j: nothing should be found). */
    fact?: string;
    /** A string that must appear in a listed excerpt (excerpt@5). */
    answer?: string;
}

const FACTS: Fact[] = [
    // a — two-char names / memes
    { id: "a1", who: "owner", text: "我家楼下新来了一只橘兔，我给它起名叫麻薯，胖得走不动" },
    { id: "a2", who: "friend", friend: "小鹿", text: "今天群里那个梗「芭乐」到底什么意思啊，我刷了一晚上没懂" },
    { id: "a3", who: "her", text: "我昨天梦见一只叫可颂的小狗，在海边追浪花" },
    { id: "a4", who: "owner", text: "公司新来的实习生外号叫豆腐，说话特别软" },
    { id: "a5", who: "friend", friend: "阿树", text: "我养的仓鼠栗栗昨晚越狱了，在沙发底下找到的" },
    { id: "a6", who: "owner", text: "周末打算去看那个叫焦糖的乐队演出，票很难抢" },
    { id: "a7", who: "her", text: "说起来那家奶茶店新出的椰椰冰，我觉得甜得刚好" },
    { id: "a8", who: "owner", text: "我给新买的绿植取名叫汤圆，每天浇一点水" },
    { id: "a9", who: "friend", friend: "小鹿", text: "我们班那个绰号布丁的同学转学了，大家都挺舍不得" },
    { id: "a10", who: "owner", text: "朋友送了我一盒苏打饼干，牌子叫晴川，口感很脆" },
    // b — single-char content words
    { id: "b1", who: "owner", text: "外面下大雨，我忘了带伞，只好在便利店躲了半小时" },
    { id: "b2", who: "owner", text: "明天要去医院拿药，记得提醒我早上别吃早饭" },
    { id: "b3", who: "her", text: "窗外飘雪了，第一场雪总让人想喝热可可" },
    { id: "b4", who: "owner", text: "新买的鞋有点磨脚，走路一瘸一拐的" },
    { id: "b5", who: "owner", text: "今天在菜市场买了一个梨，切开发现里面坏了" },
    // c — numbers ↔ Chinese numerals
    { id: "c1", who: "mc", text: "种下了十二个小麦种子，围了一圈栅栏防止羊进来" },
    { id: "c2", who: "owner", text: "我发烧到三十八度五，请了两天假" },
    { id: "c3", who: "owner", text: "那个游戏我卡在第8关好久了，boss太难打" },
    { id: "c4", who: "owner", text: "房租涨到3500了，得考虑搬家" },
    { id: "c5", who: "her", text: "我数了一下，今年一共陪你看了二十三部电影" },
    // d / e / f — facts asked as sentences, keywords, and with hubs
    { id: "d1", who: "owner", text: "下次去老码头吃火锅吧，那家店的毛肚特别新鲜" },
    { id: "d2", who: "owner", text: "我妈下周三生日，想送她一条围巾，你帮我想想颜色" },
    { id: "d3", who: "owner", text: "最近在学吉他，先练了小星星，手指按得好疼" },
    { id: "d4", who: "owner", text: "我对芒果过敏，吃了会起疹子，以后别推荐芒果味的东西" },
    { id: "d5", who: "owner", text: "公司年会抽奖抽中了一台空气炸锅，打算拿来做鸡翅" },
    { id: "d6", who: "owner", text: "我高中最好的朋友叫林夕，她现在在杭州读研究生" },
    { id: "d7", who: "owner", text: "我准备考驾照了，科目二倒车入库练了好几次都压线" },
    { id: "d8", who: "owner", text: "我最喜欢的作家是刘慈欣，三体看了三遍" },
    { id: "d9", who: "owner", text: "楼上邻居每天晚上十一点开始拖桌子，吵得睡不着" },
    { id: "d10", who: "owner", text: "我打算明年春天去云南大理旅行，想住洱海边的民宿" },
    { id: "d11", who: "desk", text: "提醒一下：周五下午三点要交季度报告，别让我忘了" },
    { id: "d12", who: "owner", text: "我在练习做提拉米苏，第一次手指饼干泡太久全塌了" },
    { id: "d13", who: "owner", text: "家里键盘坏了一个空格键，打字老是连在一起" },
    { id: "d14", who: "owner", text: "周末带爸爸去钓鱼，钓到一条两斤的鲫鱼" },
    { id: "d15", who: "owner", text: "我想换个发型，理发师推荐我剪短发烫一点卷" },
    // g — promises with perspective (twins)
    { id: "g1", who: "her", text: "我答应你，周末陪你把那部科幻电影看完" },
    { id: "g2", who: "owner", text: "我答应你，下个月给你买那套新皮肤" },
    { id: "g3", who: "her", text: "说好了，明天早上七点我叫你起床跑步" },
    { id: "g4", who: "owner", text: "说好了，等我发工资就请你吃烤肉" },
    // h — aliases across scripts
    { id: "h1", who: "mc", text: "在我的世界里挖到了三颗钻石，赶紧做了一把镐" },
    { id: "h2", who: "bili", text: "B站视频：UP主「喵喵日记」拍了一只会开门的布偶兔，弹幕都在刷好聪明" },
    { id: "h3", who: "owner", text: "昨晚打杀戮尖塔，用静默猎手一路毒到了第三层" },
    { id: "h4", who: "mc", text: "minecraft 服务器里有人用红石做了一台自动甘蔗机" },
    { id: "h5", who: "bili", text: "bilibili 推荐了一个做木工的视频，UP主用榫卯拼了一把小板凳" },
    // i — paraphrase (no shared characters with the query)
    { id: "i1", who: "owner", text: "我下午去诊所复查，大夫说恢复得不错" },
    { id: "i2", who: "owner", text: "今晚加班到凌晨，回到家累瘫了" },
    { id: "i3", who: "owner", text: "我养的那盆多肉蔫了，叶子软趴趴的" },
    { id: "i4", who: "owner", text: "地铁坐过站了，多走了二十分钟" },
    // k — what was in a video or a file she read
    { id: "k1", who: "bili", text: "视频内容：UP主「甜品研究所」今天做抹茶千层，关键是奶油要打到七分发，饼皮要摊得很薄" },
    { id: "k2", who: "bili", text: "视频内容：UP主「旅行青蛙」去了冰岛看极光，零下十五度冻得说不出话" },
    { id: "k3", who: "read", text: "文件内容：兔的购物清单——酱油、鸡蛋、挂面、洗衣液、兔砂" },
    { id: "k4", who: "bili", text: "视频内容：UP主「老张修车」讲怎么换雨刮器，三分钟就能搞定" },
    { id: "k5", who: "read", text: "文件内容：读书笔记——《活着》里福贵最后只剩下一头老牛陪着福贵" },
    // the companion's own visible text (desk replies)
    { id: "t1", who: "herText", text: "我把你说的那首《晴天》存进歌单了，下次一起听" },
];

/** ≈120 queries in 11 categories (search.md §8). */
export const ZH_QUERIES: ZhQuery[] = [
    // a
    { cat: "a", q: "麻薯", fact: "a1", answer: "麻薯" },
    { cat: "a", q: "芭乐", fact: "a2", answer: "芭乐" },
    { cat: "a", q: "可颂", fact: "a3", answer: "可颂" },
    { cat: "a", q: "豆腐 实习生", fact: "a4", answer: "豆腐" },
    { cat: "a", q: "栗栗", fact: "a5", answer: "栗栗" },
    { cat: "a", q: "焦糖 乐队", fact: "a6", answer: "焦糖" },
    { cat: "a", q: "椰椰冰", fact: "a7", answer: "椰椰冰" },
    { cat: "a", q: "汤圆 绿植", fact: "a8", answer: "汤圆" },
    { cat: "a", q: "布丁", fact: "a9", answer: "布丁" },
    { cat: "a", q: "晴川", fact: "a10", answer: "晴川" },
    { cat: "a", q: "仓鼠", fact: "a5", answer: "仓鼠" },
    { cat: "a", q: "橘兔", fact: "a1", answer: "橘兔" },
    // b
    { cat: "b", q: "伞", fact: "b1", answer: "伞" },
    { cat: "b", q: "药", fact: "b2", answer: "药" },
    { cat: "b", q: "雪", fact: "b3", answer: "雪" },
    { cat: "b", q: "鞋", fact: "b4", answer: "鞋" },
    { cat: "b", q: "梨", fact: "b5", answer: "梨" },
    { cat: "b", q: "拿药", fact: "b2", answer: "拿药" },
    { cat: "b", q: "带伞", fact: "b1", answer: "伞" },
    { cat: "b", q: "磨脚", fact: "b4", answer: "磨脚" },
    { cat: "b", q: "第一场雪", fact: "b3", answer: "雪" },
    { cat: "b", q: "坏了的梨", fact: "b5", answer: "梨" },
    // c
    { cat: "c", q: "12个种子", fact: "c1", answer: "十二" },
    { cat: "c", q: "十二 种子", fact: "c1", answer: "十二" },
    { cat: "c", q: "发烧 38度", fact: "c2", answer: "三十八" },
    { cat: "c", q: "第八关", fact: "c3", answer: "8" },
    { cat: "c", q: "第8关 boss", fact: "c3", answer: "8" },
    { cat: "c", q: "房租 3500", fact: "c4", answer: "3500" },
    { cat: "c", q: "23部电影", fact: "c5", answer: "二十三" },
    { cat: "c", q: "二十三部电影", fact: "c5", answer: "二十三" },
    { cat: "c", q: "三十八度", fact: "c2", answer: "三十八" },
    { cat: "c", q: "小麦 十二个", fact: "c1", answer: "小麦" },
    // d — whole sentences, no spaces
    { cat: "d", q: "兔上次说想去吃火锅的那家店叫什么", fact: "d1", answer: "老码头" },
    { cat: "d", q: "兔妈妈生日是哪天", fact: "d2", answer: "生日" },
    { cat: "d", q: "兔学吉他先练的是哪首歌", fact: "d3", answer: "小星星" },
    { cat: "d", q: "兔对什么水果过敏来着", fact: "d4", answer: "芒果" },
    { cat: "d", q: "年会抽奖抽中了什么", fact: "d5", answer: "空气炸锅" },
    { cat: "d", q: "兔高中最好的朋友叫什么名字", fact: "d6", answer: "林夕" },
    { cat: "d", q: "兔考驾照科目二哪里没过", fact: "d7", answer: "倒车入库" },
    { cat: "d", q: "兔最喜欢的作家是谁", fact: "d8", answer: "刘慈欣" },
    { cat: "d", q: "楼上邻居晚上几点开始吵", fact: "d9", answer: "十一点" },
    { cat: "d", q: "兔明年春天想去哪里旅行", fact: "d10", answer: "大理" },
    { cat: "d", q: "季度报告什么时候要交", fact: "d11", answer: "周五" },
    { cat: "d", q: "兔做提拉米苏第一次为什么失败了", fact: "d12", answer: "手指饼干" },
    { cat: "d", q: "兔的键盘哪个键坏了", fact: "d13", answer: "空格键" },
    { cat: "d", q: "兔和爸爸钓鱼钓到了多大的鱼", fact: "d14", answer: "鲫鱼" },
    { cat: "d", q: "理发师推荐兔剪什么发型", fact: "d15", answer: "短发" },
    // e — space keywords (same facts)
    { cat: "e", q: "火锅 店名", fact: "d1", answer: "老码头" },
    { cat: "e", q: "妈妈 生日 围巾", fact: "d2", answer: "围巾" },
    { cat: "e", q: "吉他 小星星", fact: "d3", answer: "小星星" },
    { cat: "e", q: "过敏 芒果", fact: "d4", answer: "芒果" },
    { cat: "e", q: "年会 抽奖", fact: "d5", answer: "空气炸锅" },
    { cat: "e", q: "高中 朋友 杭州", fact: "d6", answer: "林夕" },
    { cat: "e", q: "驾照 科目二", fact: "d7", answer: "倒车入库" },
    { cat: "e", q: "作家 三体", fact: "d8", answer: "刘慈欣" },
    { cat: "e", q: "邻居 拖桌子", fact: "d9", answer: "十一点" },
    { cat: "e", q: "大理 洱海 民宿", fact: "d10", answer: "大理" },
    { cat: "e", q: "季度报告 周五", fact: "d11", answer: "周五" },
    { cat: "e", q: "提拉米苏 塌了", fact: "d12", answer: "手指饼干" },
    { cat: "e", q: "键盘 空格键", fact: "d13", answer: "空格键" },
    { cat: "e", q: "钓鱼 鲫鱼", fact: "d14", answer: "鲫鱼" },
    { cat: "e", q: "发型 短发", fact: "d15", answer: "短发" },
    // f — hubs mixed in
    { cat: "f", q: "兔 说 药", fact: "b2", answer: "药" },
    { cat: "f", q: "兔 火锅", fact: "d1", answer: "火锅" },
    { cat: "f", q: "兔 吉他", fact: "d3", answer: "吉他" },
    { cat: "f", q: "她 我 芒果", fact: "d4", answer: "芒果" },
    { cat: "f", q: "兔 说 驾照", fact: "d7", answer: "驾照" },
    { cat: "f", q: "兔 我 大理", fact: "d10", answer: "大理" },
    { cat: "f", q: "大肥鱼 可颂", fact: "a3", answer: "可颂" },
    { cat: "f", q: "兔 跟 我 说 林夕", fact: "d6", answer: "林夕" },
    { cat: "f", q: "兔 邻居", fact: "d9", answer: "邻居" },
    { cat: "f", q: "兔 鲫鱼", fact: "d14", answer: "鲫鱼" },
    // g — promise twins
    { cat: "g", q: "我答应兔 看电影", fact: "g1", answer: "答应" },
    { cat: "g", q: "兔答应我 买皮肤", fact: "g2", answer: "答应" },
    { cat: "g", q: "我答应过兔什么 科幻电影", fact: "g1", answer: "答应" },
    { cat: "g", q: "兔答应过我什么 新皮肤", fact: "g2", answer: "答应" },
    { cat: "g", q: "说好 我叫兔起床", fact: "g3", answer: "说好" },
    { cat: "g", q: "说好 兔请我吃烤肉", fact: "g4", answer: "说好" },
    { cat: "g", q: "我说好几点叫兔跑步", fact: "g3", answer: "七点" },
    { cat: "g", q: "兔说好发工资请我吃什么", fact: "g4", answer: "烤肉" },
    // h — aliases
    { cat: "h", q: "MC 钻石", fact: "h1", answer: "钻石" },
    { cat: "h", q: "minecraft 钻石", fact: "h1", answer: "钻石" },
    { cat: "h", q: "B站 布偶兔", fact: "h2", answer: "布偶兔" },
    { cat: "h", q: "bilibili 布偶兔 开门", fact: "h2", answer: "开门" },
    { cat: "h", q: "sts 静默猎手", fact: "h3", answer: "静默猎手" },
    { cat: "h", q: "尖塔 毒", fact: "h3", answer: "毒" },
    { cat: "h", q: "我的世界 红石 甘蔗", fact: "h4", answer: "甘蔗" },
    { cat: "h", q: "MC 甘蔗机", fact: "h4", answer: "甘蔗" },
    { cat: "h", q: "哔哩哔哩 木工 板凳", fact: "h5", answer: "板凳" },
    { cat: "h", q: "B站 榫卯", fact: "h5", answer: "榫卯" },
    // i — paraphrase (measured, not gated)
    { cat: "i", q: "医院 看病", fact: "i1", answer: "诊所" },
    { cat: "i", q: "工作到很晚", fact: "i2", answer: "加班" },
    { cat: "i", q: "植物 枯萎", fact: "i3", answer: "多肉" },
    { cat: "i", q: "搭错车", fact: "i4", answer: "过站" },
    { cat: "i", q: "去看医生复诊", fact: "i1", answer: "诊所" },
    { cat: "i", q: "熬夜上班", fact: "i2", answer: "加班" },
    { cat: "i", q: "盆栽快死了", fact: "i3", answer: "多肉" },
    { cat: "i", q: "坐过头", fact: "i4", answer: "过站" },
    // j — nothing to find
    { cat: "j", q: "滑雪" },
    { cat: "j", q: "钢琴 考级" },
    { cat: "j", q: "北海道 温泉" },
    { cat: "j", q: "兔的前男友叫什么" },
    { cat: "j", q: "潜水 证书" },
    { cat: "j", q: "啊啊啊啊" },
    { cat: "j", q: "兔 你 我" },
    { cat: "j", q: "量子力学 薛定谔" },
    { cat: "j", q: "法拉利 跑车" },
    { cat: "j", q: "兔上次去埃及看金字塔是什么时候" },
    { cat: "j", q: "xyzzy plugh" },
    { cat: "j", q: "马拉松 全程" },
    { cat: "j", q: "离婚 律师" },
    { cat: "j", q: "钛合金 自行车" },
    { cat: "j", q: "兔养的鹦鹉会说什么话" },
    // k — content of videos / files she read
    { cat: "k", q: "视频里做的千层是什么口味", fact: "k1", answer: "抹茶" },
    { cat: "k", q: "千层 奶油 七分发", fact: "k1", answer: "七分发" },
    { cat: "k", q: "冰岛 极光", fact: "k2", answer: "极光" },
    { cat: "k", q: "UP主去冰岛看什么", fact: "k2", answer: "极光" },
    { cat: "k", q: "购物清单 兔砂", fact: "k3", answer: "兔砂" },
    { cat: "k", q: "购物清单里有什么", fact: "k3", answer: "酱油" },
    { cat: "k", q: "雨刮器 怎么换", fact: "k4", answer: "雨刮器" },
    { cat: "k", q: "活着 福贵 老牛", fact: "k5", answer: "老牛" },
    { cat: "k", q: "读书笔记 福贵", fact: "k5", answer: "福贵" },
    { cat: "k", q: "老张修车", fact: "k4", answer: "老张修车" },
];

// ------------------------------------------------------------- filler

const FILLER_CAT = [
    "今天上班好累，中午只吃了一碗面", "哈哈哈你又在说什么呢", "晚上吃什么好呢，好纠结", "刚开完会，脑子嗡嗡的",
    "你在干嘛呀", "我先去洗澡了，一会儿再聊", "今天天气不错，出去走了走", "外卖又送错了，好气",
    "明天早上还要早起，先睡了", "这周好忙，周末想躺一天", "刚看完一集剧，挺好看的", "你今天过得怎么样",
    "下班路上堵车堵了一个小时", "我刚刚想到一个好玩的事", "好的好的，知道啦", "嗯嗯，那就这样吧",
];
const FILLER_HER = [
    "好呀，那你早点休息", "哈哈，你这么说我就放心了", "我在呢，慢慢说", "听起来今天挺辛苦的",
    "那我们明天再聊这个", "嗯嗯，我记住了", "你要记得喝水", "我刚才在想你说的那件事",
    "晚安，做个好梦", "好的，我等你", "这个我也觉得挺有意思的", "别太累了，身体要紧",
];
const FILLER_FRIEND = [
    "有人周末一起打游戏吗", "这个表情包笑死我了", "群里好安静啊", "今天的作业谁写完了",
    "刚吃完饭，好撑", "晚上有人开黑吗", "哈哈哈哈哈", "你们看昨天那个直播了没",
];
const FRIENDS = ["小鹿", "阿树", "七七", "老王"];
const REASONING_NOISE = [
    "我在想要不要提一下滑雪的事，兔好像没说过", "先回一句简短的，再问问钢琴考级", "兔可能累了，语气轻一点；北海道温泉的事以后再说",
];

class Lcg {
    private s: number;
    constructor(seed: number) { this.s = seed >>> 0; }
    next(): number { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s / 0x100000000; }
    pick<T>(a: readonly T[]): T { return a[Math.floor(this.next() * a.length)]!; }
}

/** onebot 0.10.0 puts a lead-in before each envelope: `[HH:MM] ` in a private
 *  chat, `[HH:MM 名(号)·成员][@我] ` in a group, `[受限用户:仅问答] ` before a
 *  restricted user's line. Markup, never words in the corpus. */
const hhmm = (mid: number): string => `${String(8 + (mid % 15)).padStart(2, "0")}:${String((mid * 7) % 60).padStart(2, "0")}`;
function privateMsg(text: string, mid: number): string {
    return `（QQ 私聊 · 兔 · ${PRIVATE_LANE}）\n[${hhmm(mid)}] <user_message qq="${OWNER_ID}" nickname="晴" mid="${mid}">\n${text}\n</user_message>`;
}
function groupMsg(text: string, who: string, mid: number): string {
    const id = 30000 + FRIENDS.indexOf(who);
    const restricted = FRIENDS.indexOf(who) === FRIENDS.length - 1 ? "[受限用户:仅问答] " : "";
    return `（QQ 群 20002 · 有人 @ 你 · ${GROUP_LANE}）\n${restricted}[${hhmm(mid)} ${who}(${id})·成员][@我] <user_message qq="${id}" nickname="${who}" mid="${mid}">\n${text}\n</user_message>`;
}

interface ZhFixture {
    sessionId: string;
    rows: SearchRow[];
    state: CompressionState;
    /** fact id → its ref number. */
    factRef: Map<string, number>;
    /** fact id → block id. */
    factBlock: Map<string, string>;
    /** blockId → raw folded text (what the old path's originals see). */
    originals: Array<{ blockId: string; text: string }>;
    source: RowSource;
}

/** Build the synthetic session: 60 blocks × 25 messages (+ noise rows). */
export function buildZhFixture(seed = 1120): ZhFixture {
    const rng = new Lcg(seed);
    const rows: SearchRow[] = [];
    const byRaw: Record<string, string> = {};
    const factRef = new Map<string, number>();
    const factBlock = new Map<string, string>();
    let seq = 0;
    let ref = 0;
    let mid = 1000;
    const msgIds: string[][] = [];
    const rawText = new Map<string, string>();
    const BLOCKS = 60;
    const PER = 25;
    const factQueue = [...FACTS];
    // spread facts: one roughly every 25 refs, in a fixed shuffled order
    const slots = new Map<number, Fact>();
    const used = new Set<number>();
    for (const f of factQueue) {
        let at = Math.floor(rng.next() * BLOCKS * PER);
        while (used.has(at) || at % PER === 0) at = (at + 7) % (BLOCKS * PER);
        used.add(at);
        slots.set(at, f);
    }
    const add = (role: string, kind: string, body: Record<string, unknown>, opts: { retired?: boolean; noRef?: boolean } = {}): string => {
        const id = `raw-${seq}`;
        const r = opts.noRef ? null : ref;
        rows.push({ seq: seq++, refNum: r, role, kind, retired: opts.retired === true, content: JSON.stringify({ id, role, contentType: kind, ...body }) });
        return id;
    };
    for (let b = 0; b < BLOCKS; b++) {
        const ids: string[] = [];
        for (let k = 0; k < PER; k++) {
            ref++;
            const slot = b * PER + k;
            const fact = slots.get(slot);
            let id: string;
            let text: string;
            if (fact) {
                factRef.set(fact.id, ref);
                factBlock.set(fact.id, `b${b + 1}`);
                ({ id, text } = emitFact(fact));
            } else {
                const r = rng.next();
                if (r < 0.34) { text = rng.pick(FILLER_CAT); id = add("user", "text", { text: privateMsg(text, mid++) }); }
                else if (r < 0.62) { text = rng.pick(FILLER_HER); id = add("assistant", "tool-call", { toolName: "im_send", toolCallId: `c${seq}`, text: JSON.stringify({ chat: PRIVATE_LANE, text }) }); }
                else if (r < 0.78) { const who = rng.pick(FRIENDS); text = rng.pick(FILLER_FRIEND); id = add("user", "text", { text: groupMsg(text, who, mid++) }); }
                else if (r < 0.84) { text = rng.pick(REASONING_NOISE); id = add("assistant", "reasoning", { text }); }
                else if (r < 0.88) { text = `Compressed 12 messages → 1 block(s), 3,214 tokens saved. acp_status ok`; id = add("tool", "tool-result", { toolName: "acp_status", toolCallId: `c${seq}`, text }); }
                else if (r < 0.92) { text = `（尖塔 · sts:game）\n{"floor":3,"hp":42,"hand":["Strike","Defend","Neutralize"],"enemy":"Jaw Worm"}`; id = add("user", "text", { text }); }
                else if (r < 0.95) { text = `Time sampled while the model was idle: 14:02`; id = add("user", "text", { text }); }
                else { text = `[图片:C:\\Users\\someone\\AppData\\img-${seq}.png] 你看这个`; id = add("user", "text", { text: privateMsg(text, mid++) }); }
            }
            byRaw[id] = `m${String(ref).padStart(5, "0")}`;
            rawText.set(id, text);
            ids.push(id);
            // a retired duplicate generation for some refs (model switch re-mint)
            if (rng.next() < 0.3) {
                const dupId = `raw-dup-${seq}`;
                rows.push({ seq: seq++, refNum: ref, role: "assistant", kind: "text", retired: true, content: JSON.stringify({ id: dupId, role: "assistant", contentType: "text", text: "（旧一代的重复内容，不该被搜到：滑雪板）" }) });
            }
        }
        msgIds.push(ids);
    }
    function emitFact(f: Fact): { id: string; text: string } {
        switch (f.who) {
            case "owner": return { id: add("user", "text", { text: privateMsg(f.text, mid++) }), text: f.text };
            case "friend": return { id: add("user", "text", { text: groupMsg(f.text, f.friend ?? "小鹿", mid++) }), text: f.text };
            case "desk": return { id: add("user", "text", { text: `（桌面 · 兔直接打的，写在这里兔看得到）\n${f.text}` }), text: f.text };
            case "her": return { id: add("assistant", "tool-call", { toolName: "im_send", toolCallId: `c${seq}`, text: JSON.stringify({ chat: PRIVATE_LANE, text: f.text }) }), text: f.text };
            case "herText": return { id: add("assistant", "text", { text: f.text }), text: f.text };
            case "bili": return { id: add("tool", "tool-result", { toolName: "bili_humanism_read", toolCallId: `c${seq}`, text: f.text }), text: f.text };
            case "read": return { id: add("tool", "tool-result", { toolName: "read", toolCallId: `c${seq}`, text: f.text }), text: f.text };
            case "mc": return { id: add("tool", "tool-result", { toolName: "mc", toolCallId: `c${seq}`, text: f.text }), text: f.text };
        }
    }
    const blocks = msgIds.map((ids, i) => ({
        blockId: `b${i + 1}`,
        tier: 1,
        topic: `第${i + 1}段日常聊天`,
        summary: `兔和你聊了些日常，工作、吃饭、天气。${i % 7 === 0 ? "提到过下周的安排。" : ""}`,
        directMessageIds: ids,
        effectiveMessageIds: ids,
        directBlockIds: [] as string[],
        active: i >= 50,
    }));
    // a T2 block folds b1..b10 (the 已折进 note)
    blocks.push({ blockId: "b61", tier: 2, topic: "前十段", summary: "前十段日常的合并摘要。", directMessageIds: [], effectiveMessageIds: blocks.slice(0, 10).flatMap((x) => x.effectiveMessageIds), directBlockIds: blocks.slice(0, 10).map((x) => x.blockId), active: true });
    const state = { blocks, messageRefs: { byRaw } } as unknown as CompressionState;
    const originals = msgIds.map((ids, i) => ({ blockId: `b${i + 1}`, text: ids.map((id) => rawText.get(id) ?? "").join("\n") }));
    const source: RowSource = {
        page: (_id, after, limit) => rows.filter((r) => r.seq > after).slice(0, limit),
        byRefRange: (_id, lo, hi) => rows.filter((r) => r.refNum !== null && r.refNum >= lo && r.refNum <= hi),
    };
    return { sessionId: "zh-bench", rows, state, factRef, factBlock, originals, source };
}
