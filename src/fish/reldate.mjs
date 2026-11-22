// reldate.mjs — 相对日期内联注记（正本，RELDATE_VERSION '2'）
//
// 做什么：在「翻旧话」的结果里，给「下周三」「大后天」这类说法后面补一个括号，写出按那句话说出的那天算好的日期，
// 例如「下周三（=2026-11-25）」。设计见 research1119/plan-1119/dates.md（第三到第七节）和 PLAN.md 的 RD 包。
//
// 一份源、三处用：这个文件是正本（sessionless/reldate/），桥和 fork 各放一份逐字节相同的拷贝，加载时核 sha256
// （reldate.sha256），对不上整条不启用；用例 reldate-cases.json 三处都跑。改语法就升 RELDATE_VERSION。
//
// 不变量（test-reldate.mjs 都查）：
//   1. 纯：同样的（正文、锚点、选项）→ 同样的字节。不读 Date.now()、进程时区、语言环境、文件、网络，不用 Intl、
//      不用 toLocale*、不用 new Date()（日历换算是下面的整数算法），没有随机。
//   2. 幂等：标过的再标一次不变（先把本模块的注记剥掉再判，判完认「后面已经跟着注记」的那几处）。
//   3. 能去掉：stripRelDates(annotateText(x).text) === stripRelDates(x)。stripRelDates 只删本模块写法的「（=…）」。
//   4. 偏移是 UTF-16 下标；注记只插在匹配的末尾（都是汉字或数字），不会切开代理对。
//   5. 线性：分句起止、引号、屏蔽区、转述 / 习惯 / 惯用语的位置都一次算好，每个候选只做二分查找；
//      前后最多看 200 字；一次调用最多标 maxHits 处（默认 64）。
//   6. 只在工具执行时、P2/P4/P5 拼装时调；桥的 llm/stream 钩子、fork 的 render-refs、宿主落盘的消息都不调。
//
// 周从周一算（ISO）。半夜（当地 0:00 到 nightEndHour 点前，默认 5 点）里，跟「哪一天」有关的说法不标：
// 日子类一律不标；周类只在周一凌晨不标；月类只在 1 号凌晨不标；年类只在 1 月 1 日凌晨不标（dates.md 2.3）。
// 当地时间只用固定偏移 tzOffsetMin（东京 540），调用方给。
//
// 结构（版本 2，复核 RD2）：一条消息里嵌着别的时刻说的话、别人的名字，不能都按外层那一刻标：
//   - 桥拼的 <group_recent> 块（只认第一个 <user_message 之前的那块；块里每行「HH:MM 名字（回X）：正文」）：
//     「HH:MM 名字（回X）：」整段算屏蔽区；正文按 pinClock(外层锚点, HH, MM) 换成这一行自己的锚点再判，钉不住就不标；
//   - onebot 信封里的引用：以「[引用]」开头的行有两行以上时，最后一行是正文（onebot 的正文以占位「[引用]」开头），
//     前面那些行（被引用的原话，连多行的、[引用里的图片:…]）都算屏蔽区；只有一行、后面还有行时，那一行算屏蔽区；
//   - 合并转发：「[合并转发 id=…]」那一行到信封结尾（没有信封就到全文结尾）都算屏蔽区（节点行是别人在别的时刻说的）；
//   - 10-30 到 11-04 的旧桥写过的「这个群里大家常这么说（看着用，不用照搬）：」和它下面的「- …」行，算屏蔽区。
// 媒体、CQ、[[reply:…]] 这几种方括号标签改成线性扫描（复核 RD3：原来的正则在一行很多只开不关的「[图片:」上是平方的）。
//
// 来源（都是 MIT，原文在 THIRD-PARTY-NOTICES；这里没有拷任何一行代码，语法和锚点模型是自己写的）：
//   - dsh-dot-life 0.24.0 src/memory/when.js（Copyright (c) 2026 Kevinwu901113，提交 a914665）：
//     转述 / 假设词表的起点；「天(?![气空])」「一(?![直起下样…])」这类前后看的写法；「后面紧跟具体日期就不标」。
//   - 灵枢 dsh-memory md_cg/reldate.py（Copyright (c) 2026 FuRongJun-1999）：「N 天前 / 后」左边界不让数字粘连、
//     范围上限、幂等的写法。
//   - dsh-rofm engine/relative-time.js（Copyright (c) 2026 dsh-rofm contributors）：只借了反例（拆词组、1970、
//     退回 createdAt、UTC 日期），没有借代码。
//   不读、不借任何 PolyForm 许可的仓库。

export const RELDATE_VERSION = '2'

/** 图例行（给她看的字；一个结果里至少有一处注记时，调用方在结尾加这一行） */
export const RELDATE_LEGEND = '（带「=」的括号是工具按那句话说出的那天算出来的日期，不是原话。）'

/** 计数键（dates.md 3.2 的顺序；cut 是 annotateWindow 专有：候选跨了窗口边） */
export const RELDATE_SKIP_KEYS = Object.freeze(['no-anchor', 'meta', 'quoted', 'reported', 'habit', 'idiom', 'already', 'explicit-date', 'approx', 'invalid-date', 'too-far', 'bad-number', 'bare-late', 'night', 'cap', 'cut'])

/** 认的 12 类 */
export const RELDATE_CLASSES = Object.freeze(['day', 'weekDay', 'weekend', 'week', 'month', 'monthEdge', 'bareMonthEnd', 'relMonthDay', 'year', 'yearEdge', 'yearMonth', 'nDays'])

// ───────────────────────── 日历（纯整数，不碰 Date） ─────────────────────────

const DAY_MS = 86400000
const MIN_MS = 60000
// 锚点的合理范围：2000-01-01 到 2200-01-01（UTC）。挡住秒当毫秒、0、1970 这类坏锚点（ROFM 的反例）。
const ANCHOR_MIN_MS = 946684800000
const ANCHOR_MAX_MS = 7258118400000

const fdiv = (a, b) => Math.floor(a / b)

/** 公历 (y, m, d) → 从 1970-01-01 起的日序号 */
function daysFromCivil (y, m, d) {
  const yy = m <= 2 ? y - 1 : y
  const era = fdiv(yy, 400)
  const yoe = yy - era * 400
  const doy = fdiv(153 * ((m + 9) % 12) + 2, 5) + d - 1
  const doe = yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy
  return era * 146097 + doe - 719468
}

/** 日序号 → 公历 { y, m, d } */
function civilFromDays (n) {
  const z = n + 719468
  const era = fdiv(z, 146097)
  const doe = z - era * 146097
  const yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365)
  const doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100))
  const mp = fdiv(5 * doy + 2, 153)
  const d = doy - fdiv(153 * mp + 2, 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d }
}

const weekdayOf = (n) => (((n + 4) % 7) + 7) % 7 // 0 = 周日（1970-01-01 是周四）
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const lastDayOf = (y, m) => (m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31)
const p2 = (n) => String(n).padStart(2, '0')
const WD_CHAR = '日一二三四五六'
const ymdOf = (n) => { const c = civilFromDays(n); return `${c.y}-${p2(c.m)}-${p2(c.d)}` }
const addMonths = (y, m, k) => { const t = y * 12 + (m - 1) + k; return [fdiv(t, 12), (t - fdiv(t, 12) * 12) + 1] }
const validTz = (tz) => Number.isInteger(tz) && tz >= -720 && tz <= 840

/**
 * 当地日历分量。tzOffsetMin 必填（东京 540，整数分钟，[-720, 840]）。
 * @returns {{ y, m, d, wd, hh, mi, dayNo } | null} wd：0 = 周日；dayNo：当地日序号（1970-01-01 为 0）。参数不对 → null
 */
export function localParts (ms, tzOffsetMin) {
  if (!Number.isFinite(ms) || !validTz(tzOffsetMin)) return null
  const t = Math.floor(ms) + tzOffsetMin * MIN_MS
  const dayNo = fdiv(t, DAY_MS)
  const rem = t - dayNo * DAY_MS
  const c = civilFromDays(dayNo)
  return { y: c.y, m: c.m, d: c.d, wd: weekdayOf(dayNo), hh: fdiv(rem, 3600000), mi: fdiv(rem - fdiv(rem, 3600000) * 3600000, MIN_MS), dayNo }
}

/**
 * 锚点：{ at } 或 { lo, hi }（毫秒）。区间两端不在同一个当地日子 → null；锚点不在 2000–2200 年 → null。
 * @returns {{ y, m, d, wd, hh, mi, dayNo, night } | null} night：区间任一端落在当地 0:00 到 nightEndHour 点之前
 */
export function resolveAnchor (anchor, tzOffsetMin, nightEndHour = 5) {
  if (!anchor || typeof anchor !== 'object' || !validTz(tzOffsetMin)) return null
  const hasAt = anchor.at !== undefined && anchor.at !== null
  const lo = hasAt ? anchor.at : anchor.lo
  const hi = hasAt ? anchor.at : anchor.hi
  if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isFinite(lo) || !Number.isFinite(hi)) return null
  if (hi < lo || lo < ANCHOR_MIN_MS || hi >= ANCHOR_MAX_MS) return null
  const neh = Number.isInteger(nightEndHour) && nightEndHour >= 0 && nightEndHour <= 12 ? nightEndHour : 5
  const a = localParts(lo, tzOffsetMin)
  const b = localParts(hi, tzOffsetMin)
  if (a.dayNo !== b.dayNo) return null
  return { ...a, night: a.hh < neh || b.hh < neh }
}

/**
 * 按 HH:MM 把一行钉到 refMs 之前最近的那一刻（容 1 分钟的钟差）；往回超过 maxBackMin 分钟、或参数不对 → null。
 * 例：参考 11-20 00:02，钟点 23:58 → 11-19 23:58。
 * 限度：只有钟点、没有日子，真实时刻比 refMs 早一天以上、又正好落在钟点之后 maxBackMin 以内时会钉错整一天（复核 RD5）。
 */
export function pinClock (refMs, hh, mm, tzOffsetMin, maxBackMin = 360) {
  if (!Number.isFinite(refMs) || !validTz(tzOffsetMin)) return null
  if (!Number.isInteger(hh) || hh < 0 || hh > 23 || !Number.isInteger(mm) || mm < 0 || mm > 59) return null
  const r = localParts(refMs, tzOffsetMin)
  let cand = (r.dayNo * 1440 + hh * 60 + mm) * MIN_MS - tzOffsetMin * MIN_MS
  if (cand > refMs + MIN_MS) cand -= DAY_MS
  const back = Number.isFinite(maxBackMin) && maxBackMin >= 0 ? maxBackMin : 360
  return refMs - cand <= back * MIN_MS ? cand : null
}

// ───────────────────────── 数字 ─────────────────────────

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const D1 = '[一二三四五六七八九]'
const RE_CN_TENS = new RegExp(`^(${D1})?十(${D1})?$`)
const RE_CN_HUND = new RegExp(`^([一二两三四五六七八九])百(?:零(${D1})|(${D1})十(${D1})?)?$`)
const RE_CN_APPROX = /^[一二两三四五六七八九]{2}$/ // 三四、五六：约数

/** '120' / '十五' / '一百二十' → 数；'三四' 这类约数 → 'approx'；认不出 → null */
function parseNum (s) {
  if (/^\d{1,3}$/.test(s)) return Number(s)
  if (RE_CN_APPROX.test(s)) return 'approx'
  if (/^[一二两三四五六七八九]$/.test(s)) return CN_DIGIT[s]
  let m = RE_CN_TENS.exec(s)
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0)
  m = RE_CN_HUND.exec(s)
  if (m) return CN_DIGIT[m[1]] * 100 + (m[2] ? CN_DIGIT[m[2]] : m[3] ? CN_DIGIT[m[3]] * 10 + (m[4] ? CN_DIGIT[m[4]] : 0) : 0)
  return null
}

// ───────────────────────── 认什么（dates.md 3.1；词边界 3.2 末尾） ─────────────────────────

const N = '(?:\\d{1,3}|[零一二两三四五六七八九十百]{1,5})'
// 数字前面紧挨着别的数字时不认（「120天前」不会被认成「20天前」）
const NUM_LB = '(?<![\\d零一二两三四五六七八九十百千万几多来半数第])'
// 上 / 下 / 这 / 本 前面是这些字时不认：「晚上周日」「看一下周三」「日本周…」「以上」「地下」「底下」「眼下周末」「副本周三」
const P_LB = '(?<![上下每以一晚早马路网身加之楼线桌跟赶爱遇碰头手台地底天乡留剩私日资基根成版课剧书账样文标脚眼副])'
// 「约上周末」：约上 = 叫上（只挡周那几类的「上」，「约下周三」照标）
const P = '(?:(?<!约)上上|下下|这个?|本|下个?|(?<!约)上个?)'
const WEEK_UNIT = '(?:周|星期|礼拜)'
// 周几的数字后面跟数量就不是周几：「下周一两天」「上周三四次」「这周五天班」「上周一口气」（复核 RD4）
const WD_NUMQ = '\\d零一二两三四五六七八九十百千天次口顿整'
const WD = `(?:一(?![${WD_NUMQ}直起样些共切定般律旦生半点个]|下子)|二(?![${WD_NUMQ}点个])|三(?![${WD_NUMQ}点个])|四(?![${WD_NUMQ}点个])|五(?![${WD_NUMQ}点个])|六(?![${WD_NUMQ}点个])|日(?![程子常记志报历期出落语本元剧服料文系式漫产区币籍企])|天(?![气空天下冷热晴黑亮凉阴]))`
// 「明」前面是这些字时是别的词（聪明、光明、证明、文明……）
const MING_LB = '(?<![的聪光清证表透文发鲜分声黎简英高精神失照开昌申阐查注标载指写挑点摆])'
const JIN_LB = '(?<![的如至现当而迄古])'
// 前年、后年：前面是年、节（「年前年后」「节前年货」），或后面是货会终前后（「随后年会」「今后年终」）时是别的词（复核 RD4）
const YEAR_WORD = `(?:${JIN_LB}今年|${MING_LB}明年|(?<![过回失除的])去年|(?<![大提之以从目眼面向往当生空事门跟的年节])前年(?![货会终前后])|(?<![大然之以最落午背前的年节])后年(?![货会终前后])|(?<![大的])大前年|(?<![大的])大后年)`
// 前天、后天前面是「N天 / N周 / N个月 / N年 / N小时 / N分钟」（「三天后天就晴了」「两周后天冷了」）时不认
const UNIT_LB = '(?<!(?:[\\d零一二两三四五六七八九十百千几半多个](?:天|周|月|年|日|星期|礼拜)|小时|钟头|分钟|秒钟|秒))'
// 「X后天…」「X前天…」里 X后 / X前 是一个词（下班后、雨后、饭后、睡前、年前……）。只收不会和「X 后天」连读的（「我会后天到」「比赛后天开始」「这门课后天考」照标）
const X_AFTER_LB = '(?<!(?:下班|上班|加班|值班|放学|下课|[饭雨醒酒餐婚产战年完]))'
const X_BEFORE_LB = '(?<!(?:上班|下班|加班|上课|[睡饭年婚产战]))'
// 前天、后天后面跟「天」（天气、天空除外）：「饭后天天」「睡前天天」
const DAY_TIAN_LA = '天(?![气空])'
const YEAR3 = `(?:${JIN_LB}今年|${MING_LB}明年|(?<![过回失除的])去年)`
const EDGE = '(?:底(?![气线层片部牌细子下])|末(?![日尾期梢端])|初(?![中恋心步级次始稿衷版赛见]))'
const END_EDGE = '(?:底(?![气线层片部牌细子下])|末(?![日尾期梢端]))'

const RULES = [
  ['yearMonth', `${YEAR_WORD}的?${N}月份?(?:${N}[日号])?`],
  ['relMonthDay', `${P_LB}(?:这个?|本|下个?|上个?)月${N}[日号]`],
  ['monthEdge', `${P_LB}(?:这个?|本|下个?|上个?)月${EDGE}`],
  ['yearEdge', `${YEAR3}(?:的?年)?${EDGE}`],
  // 「次月底」「元月底」「几月底」「该月底」「当月底」……不是这个月的月底（复核 RD4）
  ['bareMonthEnd', `(?<![每个本上下这半岁年日正腊冬满次元几该当同隔某那\\d零一二两三四五六七八九十])月${END_EDGE}`],
  ['month', `${P_LB}(?:这个?|本|下个?|上个?)月(?![份初底末中旬\\d零一二两三四五六七八九十亮光饼球票色季嫂薪经子牙台刊])`],
  ['year', `${YEAR_WORD}(?![度级龄纪轻代初底末])`],
  ['weekend', `${P_LB}${P}${WEEK_UNIT}末`],
  ['weekDay', `${P_LB}${P}${WEEK_UNIT}${WD}`],
  // 「下周目」「上周目」（游戏的几周目）不是周（复核 RD4）
  ['week', `${P_LB}(?:(?<!约)上上|下下|(?<!约)上一|下一|这一|这个?|本|下个?|(?<!约)上个?)${WEEK_UNIT}(?![一二三四五六七日天末期年边围到转折刊报全密岁长目])`],
  // 「两天前天气很好」：前 / 后后面跟「天气 / 天空」照认（复核 RD4 顺带）
  ['nDays', `${NUM_LB}${N}(?:个月|个?(?:天|周|星期|礼拜|年))(?:以|之)?[前后](?![后前]|${DAY_TIAN_LA})`],
  ['day', `(?<![大的])大前天|(?<![大的])大后天|(?<![大昨的面眼跟之以从目提向往当生空事门])${X_BEFORE_LB}${UNIT_LB}前天(?![空色堂使]|${DAY_TIAN_LA})|(?<!先天)(?<![先明大今昨前的然之以最落午背])${X_AFTER_LB}${UNIT_LB}后天(?![性生养形培努因获环条]|${DAY_TIAN_LA})|(?<![今的])昨(?:天|日|儿|晚|夜)|${JIN_LB}今(?:天|日(?!头条)|儿|早|晨|晚|夜)|${MING_LB}明(?:天|日(?!方舟|香|之后)|儿|早|晨|晚)`],
]
const BIG = new RegExp(RULES.map(([, src], i) => `(?<c${i}>${src})`).join('|'), 'g')
const GROUP_NAMES = RULES.map((_, i) => `c${i}`)

// 每一类匹配到的字的拆法（不带前后看，只拆已经认出来的整词）
const PX_RE = /^(上上|下下|上一|下一|这一|这个|这|本|下个|下|上个|上)/
const RE_YM = new RegExp(`^(今年|明年|去年|前年|后年|大前年|大后年)的?(${N})月份?(?:(${N})[日号])?$`)
const RE_RMD = new RegExp(`^(这个?|本|下个?|上个?)月(${N})[日号]$`)
const RE_ND = new RegExp(`^(${N})(个月|个?(?:天|周|星期|礼拜|年))(?:以|之)?([前后])$`)
const YEAR_OFF = { 今年: 0, 明年: 1, 去年: -1, 前年: -2, 后年: 2, 大前年: -3, 大后年: 3 }
const DAY_OFF = { 大前天: -3, 前天: -2, 昨天: -1, 昨日: -1, 昨儿: -1, 昨晚: -1, 昨夜: -1, 今天: 0, 今日: 0, 今儿: 0, 今早: 0, 今晨: 0, 今晚: 0, 今夜: 0, 明天: 1, 明日: 1, 明儿: 1, 明早: 1, 明晨: 1, 明晚: 1, 后天: 2, 大后天: 3 }
const WD_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
const prefixOff = (p) => (p === '上上' ? -2 : p === '下下' ? 2 : p[0] === '下' ? 1 : p[0] === '上' ? -1 : 0)
const mondayOf = (a) => a.dayNo - ((a.wd + 6) % 7)
const dayHit = (n, withWd) => ({ kind: 'day', value: ymdOf(n), display: withWd ? `${ymdOf(n)} 周${WD_CHAR[weekdayOf(n)]}` : ymdOf(n) })
function spanHit (n1, n2) {
  const a = civilFromDays(n1)
  const b = civilFromDays(n2)
  return { kind: 'span', value: `${ymdOf(n1)}~${ymdOf(n2)}`, display: a.y === b.y ? `${ymdOf(n1)}~${p2(b.m)}-${p2(b.d)}` : `${ymdOf(n1)}~${ymdOf(n2)}` }
}
const monthHit = (y, m, edge) => ({ kind: 'month', value: `${y}-${p2(m)}`, display: edge ? `${y}-${p2(m)} ${edge}` : `${y}-${p2(m)}`, ...(edge ? { edge } : {}) })
const yearHit = (y, edge) => ({ kind: 'year', value: `${y}`, display: edge ? `${y} ${edge}` : `${y}`, ...(edge ? { edge } : {}) })

/** 认出来的词 + 锚点 → { kind, value, display, sens } 或 { skip } */
function resolveWord (cls, t, a) {
  switch (cls) {
    case 'day': {
      const off = DAY_OFF[t]
      if (off === undefined) return { skip: 'bad-number' }
      return { ...dayHit(a.dayNo + off, true), sens: 'day' }
    }
    case 'weekDay': {
      const px = PX_RE.exec(t)[1]
      const w = WD_NUM[t[t.length - 1]]
      return { ...dayHit(mondayOf(a) + prefixOff(px) * 7 + w - 1, false), sens: 'monday' }
    }
    case 'weekend': {
      const mon = mondayOf(a) + prefixOff(PX_RE.exec(t)[1]) * 7
      return { ...spanHit(mon + 5, mon + 6), sens: 'monday' }
    }
    case 'week': {
      const px = PX_RE.exec(t)[1].replace(/一$/, '')
      const mon = mondayOf(a) + prefixOff(px) * 7
      return { ...spanHit(mon, mon + 6), sens: 'monday' }
    }
    case 'month': {
      const [y, m] = addMonths(a.y, a.m, prefixOff(PX_RE.exec(t)[1]))
      return { ...monthHit(y, m), sens: 'first' }
    }
    case 'monthEdge': {
      const [y, m] = addMonths(a.y, a.m, prefixOff(PX_RE.exec(t)[1]))
      return { ...monthHit(y, m, t.endsWith('初') ? '月初' : '月底'), sens: 'first' }
    }
    case 'bareMonthEnd': {
      if (a.d >= lastDayOf(a.y, a.m) - 5) return { skip: 'bare-late' } // 月末 6 天内分不清是这个月还是下个月
      return { ...monthHit(a.y, a.m, '月底'), sens: 'first' }
    }
    case 'relMonthDay': {
      const mm = RE_RMD.exec(t)
      const d = parseNum(mm[2])
      if (d === 'approx') return { skip: 'approx' }
      const [y, m] = addMonths(a.y, a.m, prefixOff(mm[1]))
      if (!Number.isInteger(d) || d < 1 || d > lastDayOf(y, m)) return { skip: 'invalid-date' }
      return { ...dayHit(daysFromCivil(y, m, d), false), sens: 'first' }
    }
    case 'year': return { ...yearHit(a.y + YEAR_OFF[t]), sens: 'newyear' }
    case 'yearEdge': {
      const y = a.y + YEAR_OFF[t.slice(0, 2)]
      return { ...yearHit(y, t.endsWith('初') ? '年初' : '年底'), sens: 'newyear' }
    }
    case 'yearMonth': {
      const mm = RE_YM.exec(t)
      const y = a.y + YEAR_OFF[mm[1]]
      const m = parseNum(mm[2])
      if (m === 'approx') return { skip: 'approx' }
      if (!Number.isInteger(m) || m < 1 || m > 12) return { skip: 'invalid-date' }
      if (mm[3] === undefined) return { ...monthHit(y, m), sens: 'newyear' }
      const d = parseNum(mm[3])
      if (d === 'approx') return { skip: 'approx' }
      if (!Number.isInteger(d) || d < 1 || d > lastDayOf(y, m)) return { skip: 'invalid-date' }
      return { ...dayHit(daysFromCivil(y, m, d), false), sens: 'newyear' }
    }
    case 'nDays': {
      const mm = RE_ND.exec(t)
      const k = parseNum(mm[1])
      if (k === 'approx') return { skip: 'approx' }
      if (!Number.isInteger(k) || k < 1) return { skip: 'bad-number' }
      const sg = mm[3] === '前' ? -1 : 1
      const unit = mm[2].replace(/^个/, '')
      if (unit === '天') return k > 366 ? { skip: 'too-far' } : { ...dayHit(a.dayNo + sg * k, true), sens: 'day' }
      if (unit === '周' || unit === '星期' || unit === '礼拜') return k > 52 ? { skip: 'too-far' } : { ...dayHit(a.dayNo + sg * 7 * k, true), sens: 'day' }
      if (unit === '月') {
        if (k > 24) return { skip: 'too-far' }
        const [y, m] = addMonths(a.y, a.m, sg * k)
        return { ...monthHit(y, m), sens: 'first' }
      }
      return k > 10 ? { skip: 'too-far' } : { ...yearHit(a.y + sg * k), sens: 'newyear' }
    }
  }
  return { skip: 'bad-number' }
}

// ───────────────────────── 不认什么（dates.md 3.2、3.5） ─────────────────────────

// 本模块写的注记（只认这几种写法；stripRelDates 只删它们）
const OWN_NOTE_SRC = '（=\\d{4}(?:-\\d{2}){0,2}(?: 周[一二三四五六日])?(?:~(?:\\d{4}-)?\\d{2}-\\d{2})?(?: (?:月初|月底|年初|年底))?）'
const OWN_NOTE_G = new RegExp(OWN_NOTE_SRC, 'g')

const QUOTE_PAIRS = { '“': '”', '「': '」', '『': '』', '"': '"', '‘': '’', '《': '》', '〈': '〉', '`': '`', '﹁': '﹂', '﹃': '﹄' }
const isClauseEnd = (c) => c === '，' || c === '。' || c === '！' || c === '？' || c === '；' || c === ',' || c === '.' || c === '!' || c === '?' || c === ';' || c === '\n' || c === '…'
const CTX = 200 // 分句太长（没有标点的一大段）只看前后 200 字

// 转述、假设（同一分句里，前后都看）。「我说」「再说」不算（「明天再说」是改天再办，不是转述）
const RE_REPORTED = /(?<![我再])说(?!实话|真的|起来|不定)|讲|听说|据说|告诉|问我|问他|问她|写着|提到|传说|以为|如果|假如|假使|倘若|要是|万一|假设|梦到|梦见|做梦|想象|的话/g
// 习惯（只看前面）
const RE_HABIT = /每|通常|一般|总是|老是|经常|往往|平时/g
// 惯用语（分句里出现就不标）
const RE_IDIOM = /明天会更好|没有明天|美好的明天|为了明天/g
// 屏蔽区（里面的字不认）
const SHIELDS = [
  /^（[^\n]{0,300} · [a-z][a-z0-9]{0,40}:[^\n]{0,300}）[ \t]*$/gm, // 桥的抬头行（MEM_BRIDGE_HEAD 那种；各段限长，免得病态长行回溯）
  /<acp\s[^<>]*>[^<]*<\/acp>/g, // <acp …>…</acp> 编号标签（连里面）
  /<\/?[A-Za-z_][\w:-]*(?:\s[^<>]*)?\/?>/g, // <user_message …>、</user_message>、<group_recent> 这类标签本身（连属性）
  /\[\d{1,2}:\d{2}(?:[ \t][^\]\n]{0,80})?\](?:\[@我\])?/g, // onebot 钟点前缀 [HH:MM] / [HH:MM 昵称(QQ)·成员][@我]
  /\[受限用户:仅问答\]/g,
  // 媒体标签、[CQ:…]、[[reply:…]] 不在这里：见 bracketTags（线性扫描）
  /https?:\/\/[^\s<>"'，。；！？、\]）)」』”]+/g, // 网址
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s<>"'|，。；！？、\]）)」』”]*/g, // C:\… C:/…
  /(?<![\w~])(?:~|\.\.?)[\\/][^\s<>"'|，。；！？、\]）)」』”]*/g, // ~/… ./… ../…
  /(?<![\w/])\/[A-Za-z]\/[^\s<>"'|，。；！？、\]）)」』”]*/g, // /c/Users/…（Git Bash 写法）
  /```[\s\S]*?(?:```|$)/g, // 代码块（没合上的到结尾）
  /[（(]=[^）)\n]{0,60}[）)]/g, // 别人写的（=…）
]

// 媒体标签 [图片:…] [表情包:…] [卡片:…] … 和 [CQ:…]、[[reply:…]]：只用正则找开头（定长），收尾用「下一个 ] 或换行」的指针，
// 指针只往前走，整段是线性的。不限长度：onebot 的卡片标签最长约 560 字（CARD_MAX_TEXT 360 + 链接 200），限 300 会漏掉长卡片。
const TAG_OPEN = /\[\[reply:|\[CQ:|\[(?:图片|表情包|表情|语音|视频|文件|卡片|分享|联系人|位置|戳一戳|引用里的图片|动画表情|小程序|合并转发|转发|红包|转账|音乐|链接|回复|骰子|猜拳)(?=[:：\]])/g
function bracketTags (s, mask) {
  let nb = -2 // s 里 ≥ p 的第一个 ']'（-1 = 没有了；-2 = 还没找）
  let nn = -2 // ≥ p 的第一个 '\n'
  const stopAt = (p) => {
    if (nb !== -1 && nb < p) nb = s.indexOf(']', p)
    if (nn !== -1 && nn < p) nn = s.indexOf('\n', p)
    if (nb === -1) return -1
    return nn !== -1 && nn < nb ? -1 : nb
  }
  TAG_OPEN.lastIndex = 0
  for (const m of s.matchAll(TAG_OPEN)) {
    const i = m.index
    const p = i + m[0].length
    if (m[0] === '[[reply:') {
      const q = stopAt(p)
      if (q >= 0 && s[q + 1] === ']') mask.fill(1, i, q + 2)
    } else if (m[0] === '[CQ:') {
      const q = stopAt(p)
      if (q >= 0) mask.fill(1, i, q + 1)
    } else if (s[p] === ']') {
      mask.fill(1, i, p + 1)
    } else {
      const q = stopAt(p + 1) // s[p] 是「:」或「：」
      if (q >= 0) mask.fill(1, i, q + 1)
    }
  }
}

// 桥拼的群里近况（local-bridge 的 groupBlock / groupLine）：一行「HH:MM 名字（回X）：正文」；名字里没有「：」（groupNick 去掉了），正文没有换行
const GROUP_OPEN = '<group_recent>'
const GROUP_CLOSE = '</group_recent>'
const GROUP_LINE = /^(\d{1,2}):(\d{2}) [^：\n]*：/
const ENV_OPEN = /<user_message[\s>][^<>]*>|<user_message>/g
const ENV_CLOSE = '</user_message>'
const QUOTE_HEAD = '[引用]'
const FWD_HEAD = '[合并转发 id='
const LEGACY_EXPR = '这个群里大家常这么说（看着用，不用照搬）：' // 10-30 到 11-04 的旧桥（第 17 条，11-04 撤了）

/** 把 [from, to) 切成行：回 [[行首, 行尾（不含换行）], …] */
function linesOf (s, from, to) {
  const out = []
  let st = from
  while (st <= to) {
    let e = s.indexOf('\n', st)
    if (e < 0 || e > to) e = to
    out.push([st, e])
    if (e >= to) break
    st = e + 1
  }
  return out
}

/** 一段信封正文（或没有信封时的全文）里的引用、合并转发：屏蔽区写进 mask */
function quoteForward (s, from, to, mask) {
  // 只看有字的行（信封正文前后各有一个空行）
  const ls = []
  const q = []
  let fwd = -1
  for (const [a, b] of linesOf(s, from, to)) {
    let x = a
    while (x < b && (s[x] === ' ' || s[x] === '\t' || s[x] === '\r')) x++
    if (x >= b) continue
    if (s.startsWith(QUOTE_HEAD, x)) q.push(ls.length)
    if (fwd < 0 && s.startsWith(FWD_HEAD, x)) fwd = ls.length
    ls.push([a, b])
  }
  // 引用：两行以上以「[引用]」开头时，最后那行是正文（以占位「[引用]」开头），前面都是被引用的原话
  if (q.length >= 2) mask.fill(1, ls[q[0]][0], ls[q[q.length - 1]][0])
  // 只有一行、后面还有别的行：这一行是被引用的原话（正文不以「[引用]」开头）；它是最后一行时是正文（引用没展开）
  else if (q.length === 1 && q[0] < ls.length - 1) mask.fill(1, ls[q[0]][0], ls[q[0]][1])
  // 合并转发：头一行到这一段结尾
  if (fwd >= 0) mask.fill(1, ls[fwd][0], to)
}

/**
 * 结构屏蔽区和群里近况的行：
 *   - <group_recent> 块只认第一个 <user_message 之前的（桥拼的；信封里的是别人打的字，可以伪造）；
 *   - 引用、合并转发按信封（没有信封就按全文）找。
 * 回 entries：[{ s, e, hh, mm }]（正文的 [s, e)，按位置递增）
 */
function structure (s, mask) {
  const n = s.length
  const entries = []
  const hasGroup = s.includes(GROUP_OPEN)
  const hasLegacy = s.includes(LEGACY_EXPR)
  const hasQuote = s.includes(QUOTE_HEAD) || s.includes(FWD_HEAD)
  if (!hasGroup && !hasLegacy && !hasQuote) return entries
  ENV_OPEN.lastIndex = 0
  const firstEnvM = ENV_OPEN.exec(s)
  const firstEnv = firstEnvM ? firstEnvM.index : n
  if (hasGroup || hasLegacy) {
    let inGroup = false
    let inLegacy = false
    for (const [a, b] of linesOf(s, 0, firstEnv)) {
      const line = s.slice(a, b)
      if (inGroup) {
        if (line === GROUP_CLOSE) { inGroup = false; continue }
        const m = GROUP_LINE.exec(line)
        const hh = m ? Number(m[1]) % 24 : -1 // 有的语言环境把零点写成 24
        const mm = m ? Number(m[2]) : -1
        if (m && Number(m[1]) <= 24 && mm <= 59) {
          mask.fill(1, a, a + m[0].length) // 钟点、名字、（回X）、冒号
          entries.push({ s: a + m[0].length, e: b, hh, mm })
        } else mask.fill(1, a, b) // 认不出的行整行不标
        continue
      }
      if (inLegacy) {
        if (line.startsWith('- ')) { mask.fill(1, a, b); continue }
        inLegacy = false
      }
      if (line === GROUP_OPEN) inGroup = true
      else if (line === LEGACY_EXPR) { inLegacy = true; mask.fill(1, a, b) }
    }
  }
  if (hasQuote) {
    if (!firstEnvM) quoteForward(s, 0, n, mask)
    else {
      ENV_OPEN.lastIndex = 0
      let from = 0
      for (;;) {
        ENV_OPEN.lastIndex = from
        const m = ENV_OPEN.exec(s)
        if (!m) break
        const cs = m.index + m[0].length
        let ce = s.indexOf(ENV_CLOSE, cs)
        if (ce < 0) ce = n
        quoteForward(s, cs, ce, mask)
        from = ce >= n ? n : ce + ENV_CLOSE.length
        if (from >= n) break
      }
    }
  }
  return entries
}

/** 群里近况那一行的锚点：外层是 {at} 时钉一次；是 {lo, hi} 时两头各钉一次（两头都钉得住才算），同一天才有 */
function lineAnchor (anchor, hh, mm, tz, nightEndHour) {
  const hasAt = anchor.at !== undefined && anchor.at !== null
  if (hasAt) {
    const p = pinClock(anchor.at, hh, mm, tz, 360)
    return p === null ? null : resolveAnchor({ at: p }, tz, nightEndHour)
  }
  const pl = pinClock(anchor.lo, hh, mm, tz, 360)
  const ph = pinClock(anchor.hi, hh, mm, tz, 360)
  return pl === null || ph === null ? null : resolveAnchor({ lo: pl, hi: ph }, tz, nightEndHour)
}

/** 有序区间表上「有一段完全落在 [lo, hi) 里」：starts 递增、区间互不重叠时，看 start ≥ lo 的第一段 */
function anyWithin (starts, ends, lo, hi) {
  let l = 0
  let r = starts.length
  while (l < r) { const mid = (l + r) >> 1; if (starts[mid] < lo) l = mid + 1; else r = mid }
  return l < starts.length && ends[l] <= hi
}

function spansOf (re, s) {
  const starts = []
  const ends = []
  re.lastIndex = 0
  for (const m of s.matchAll(re)) { starts.push(m.index); ends.push(m.index + m[0].length) }
  return { starts, ends }
}

/** 剥掉本模块的注记：base 是剥后的正文；map[j] = base 第 j 个字在原文里的下标；noteAt 收 base 里「后面原本跟着注记」的位置 */
function toBase (text) {
  if (!text.includes('（=')) return { base: text, map: null, noteAt: null }
  OWN_NOTE_G.lastIndex = 0
  const parts = []
  const offs = []
  const noteAt = new Set()
  let last = 0
  let baseLen = 0
  for (const m of text.matchAll(OWN_NOTE_G)) {
    parts.push(text.slice(last, m.index)); offs.push([baseLen, last]); baseLen += m.index - last
    noteAt.add(baseLen)
    last = m.index + m[0].length
  }
  if (!noteAt.size) return { base: text, map: null, noteAt: null }
  parts.push(text.slice(last)); offs.push([baseLen, last]); baseLen += text.length - last
  const base = parts.join('')
  const map = new Int32Array(base.length + 1)
  for (let k = 0; k < offs.length; k++) {
    const [b0, o0] = offs[k]
    const b1 = k + 1 < offs.length ? offs[k + 1][0] : base.length
    for (let j = b0; j < b1; j++) map[j] = o0 + (j - b0)
  }
  map[base.length] = text.length
  return { base, map, noteAt }
}

const EXPLICIT_AFTER = [
  /^[\s，,]*[（(]?\s*(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}/, // （11-20）、11月20日、，11月20日
  /^[\s，,（(]*(?:也就是|即|就是)?\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})[号日]/, // 20号、，也就是20号
  /^\s*[（(]\s*(?:周|星期|礼拜)[一二三四五六日天]\s*[)）]/, // （周五）
]
const APPROX_BEFORE = /(?:大概|大约|差不多|将近|大致)$/
const APPROX_AFTER = /^[\s，,]*(?:大概|大约|左右|前后)/
const ALREADY_AFTER = /^\s*[（(]=/

/**
 * 核心：扫一遍，回所有候选的处理结果。
 * win = null（整段）或 [winStart, winEnd)（原文下标）：只数、只标完全落在窗口里的候选。
 */
function scan (text, anchor, opts, win) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const tz = opts?.tzOffsetMin
  const nightEndHour = opts?.nightEndHour ?? 5
  const maxHits = Number.isInteger(opts?.maxHits) && opts.maxHits >= 0 ? opts.maxHits : 64
  const skips = {}
  const hits = []
  const skip = (k) => { skips[k] = (skips[k] || 0) + 1 }
  if (!s) return { s, hits, skips }
  const { base, map, noteAt } = toBase(s)
  const orig = (j) => (map ? map[j] : j)
  const origEnd = (e) => (map ? map[e - 1] + 1 : e)
  // 先只找候选；没有候选就不必算后面那些表
  const cands = []
  BIG.lastIndex = 0
  for (const m of base.matchAll(BIG)) {
    let cls = null
    for (let g = 0; g < GROUP_NAMES.length; g++) if (m.groups[GROUP_NAMES[g]] !== undefined) { cls = RULES[g][0]; break }
    cands.push(m.index, m.index + m[0].length, cls)
  }
  if (!cands.length) return { s, hits, skips }
  const a = resolveAnchor(anchor, tz, nightEndHour)
  const n = base.length
  // 屏蔽区
  const mask = new Uint8Array(n)
  for (const re of SHIELDS) { re.lastIndex = 0; for (const m of base.matchAll(re)) mask.fill(1, m.index, m.index + m[0].length) }
  bracketTags(base, mask)
  // 群里近况的行（各用各的钟点）、引用、合并转发、旧的「大家常这么说」
  const entries = structure(base, mask)
  const entryAnchors = new Array(entries.length)
  let ep = 0
  // 引号（屏蔽区里的引号字符不开引号；ASCII 双引号和反引号到行尾自动合上，别的到空行合上）
  const quoted = new Uint8Array(n)
  let close = ''
  for (let i = 0; i < n; i++) {
    const ch = base[i]
    if (close) {
      if (ch === close) close = ''
      else if (ch === '\n' && (close === '"' || close === '`' || base[i + 1] === '\n')) close = ''
      else quoted[i] = 1
    } else if (QUOTE_PAIRS[ch] && !mask[i]) close = QUOTE_PAIRS[ch]
  }
  // 分句起止
  const cStart = new Int32Array(n + 1)
  const cEnd = new Int32Array(n + 1)
  for (let i = 0, st = 0; i <= n; i++) { cStart[i] = st; if (i < n && isClauseEnd(base[i])) st = i + 1 }
  for (let i = n, en = n; i >= 0; i--) { if (i < n && isClauseEnd(base[i])) en = i; cEnd[i] = en }
  const rep = spansOf(RE_REPORTED, base)
  const hab = spansOf(RE_HABIT, base)
  const idi = spansOf(RE_IDIOM, base)
  let used = 0
  for (let k = 0; k < cands.length; k += 3) {
    const i = cands[k]
    const end = cands[k + 1]
    const cls = cands[k + 2]
    const os = orig(i)
    const oe = origEnd(end)
    if (win) {
      if (oe <= win[0] || os >= win[1]) continue // 窗口外：不数
      if (os < win[0] || oe > win[1]) { skip('cut'); continue }
    }
    // 这个候选在群里近况的某一行正文里：换成那一行自己的锚点（外层没有锚点时也没有）
    let ca = a
    let viaLine = false
    while (ep < entries.length && entries[ep].e <= i) ep++
    if (ep < entries.length && entries[ep].s <= i && end <= entries[ep].e) {
      viaLine = true
      if (entryAnchors[ep] === undefined) entryAnchors[ep] = a ? lineAnchor(anchor, entries[ep].hh, entries[ep].mm, tz, nightEndHour) : null
      ca = entryAnchors[ep]
    }
    if (!ca) { skip('no-anchor'); continue }
    if (mask[i]) { skip('meta'); continue }
    if (quoted[i]) { skip('quoted'); continue }
    const c0 = Math.max(cStart[i], i - CTX)
    const c1 = Math.min(cEnd[end], end + CTX)
    if (anyWithin(rep.starts, rep.ends, c0, i) || anyWithin(rep.starts, rep.ends, end, c1)) { skip('reported'); continue }
    if (anyWithin(hab.starts, hab.ends, c0, i)) { skip('habit'); continue }
    if (anyWithin(idi.starts, idi.ends, c0, c1)) { skip('idiom'); continue }
    const after = base.slice(end, end + 16)
    if ((noteAt && noteAt.has(end)) || ALREADY_AFTER.test(after)) { skip('already'); used++; continue }
    if (EXPLICIT_AFTER.some((re) => re.test(after))) { skip('explicit-date'); continue }
    if (APPROX_BEFORE.test(base.slice(Math.max(0, i - 4), i)) || APPROX_AFTER.test(after)) { skip('approx'); continue }
    const r = resolveWord(cls, base.slice(i, end), ca)
    if (r.skip) { skip(r.skip); continue }
    if (ca.night && (r.sens === 'day' || (r.sens === 'monday' && ca.wd === 1) || (r.sens === 'first' && ca.d === 1) || (r.sens === 'newyear' && ca.m === 1 && ca.d === 1))) { skip('night'); continue }
    if (used >= maxHits) { skip('cap'); continue }
    used++
    const hit = { start: os, end: oe, cls, kind: r.kind, value: r.value, note: `（=${r.display}）` }
    if (r.edge) hit.edge = r.edge
    if (viaLine) hit.via = 'line' // 用的是群里近况那一行自己的钟点
    hits.push(hit)
  }
  return { s, hits, skips }
}

function insertNotes (s, hits, from = 0, to = s.length) {
  let out = ''
  let last = from
  for (const h of hits) { out += s.slice(last, h.end) + h.note; last = h.end }
  return out + s.slice(last, to)
}

/**
 * 找出该标的位置（不改正文）。
 * @param {string} text 正文（调用方只把正文交进来：说话人标签「主人说：」「[user]」不进函数）
 * @param {{at:number}|{lo:number,hi:number}|null} anchor 那句话真正发生的时刻（毫秒）
 * @param {{tzOffsetMin:number, nightEndHour?:number, maxHits?:number}} opts
 * @returns {{ hits: Array<{start,end,cls,kind,value,note,edge?,via?}>, skips: Record<string, number> }}
 *   start/end 是原文的 UTF-16 下标，注记插在 end；value 是机读的日期（'2026-11-25'、'2026-11-23~2026-11-29'、'2026-12'、'2026'）；
 *   via: 'line' 表示这一处在桥拼的 <group_recent> 某一行里，锚点是那一行自己的钟点（pinClock 钉到外层锚点之前）
 */
export function findRelDates (text, anchor, opts) {
  const { hits, skips } = scan(text, anchor, opts, null)
  return { hits, skips }
}

/** 整段加注记 → { text, hits, skips } */
export function annotateText (text, anchor, opts) {
  const { s, hits, skips } = scan(text, anchor, opts, null)
  return { text: hits.length ? insertNotes(s, hits) : s, hits, skips }
}

/**
 * 只给 [winStart, winEnd) 这一段加注记：引号、分句、转述在整条上判，只插完全落在窗口里的；
 * maxHits 只数窗口里的。回的 text 是窗口那一段（带注记），hits 的下标是整条原文的。
 */
export function annotateWindow (fullText, winStart, winEnd, anchor, opts) {
  const s = typeof fullText === 'string' ? fullText : String(fullText ?? '')
  const ws = Math.max(0, Math.min(s.length, Number.isInteger(winStart) ? winStart : 0))
  const we = Math.max(ws, Math.min(s.length, Number.isInteger(winEnd) ? winEnd : s.length))
  const { hits, skips } = scan(s, anchor, opts, [ws, we])
  return { text: insertNotes(s, hits, ws, we), hits, skips }
}

/** 去掉本模块加的注记（只认本模块的写法） */
export function stripRelDates (text) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (!s.includes('（=')) return s
  OWN_NOTE_G.lastIndex = 0
  return s.replace(OWN_NOTE_G, '')
}
