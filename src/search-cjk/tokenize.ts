/**
 * fork search v2 (11-20) — dictionary-free CJK gram tokenizer.
 *
 * Index side: every CJK char (unigram) + every adjacent CJK pair (bigram),
 * ASCII words (>= 2 letters, lower-cased), digit runs, and an extra number
 * token for Chinese numerals 0–99 (十二 ↔ 12). Query side cuts the SAME way
 * (bigrams of a CJK run, the char itself for a 1-char run), so query and
 * text are symmetric — unlike the kernel's Intl.Segmenter path, which drops
 * single-char words next to multi-char ones and segments short queries
 * differently from the text (search.md §1.2). Clean-room; the idea (unigram
 * + bigram, no dictionary) follows dsh-dot recall.js (MIT).
 *
 * Token keys: numbers for BMP CJK grams (unigram = code, bigram =
 * 0x10000 + c1 * 0x10000 + c2), strings for words ("w:…") and numbers
 * ("n:…"). Pure functions, no state.
 */

export type GramKey = number | string;

/** CJK ideographs (+ext A, compat), kana, hangul — BMP only. */
export function isCjkCode(c: number): boolean {
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)
        || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af);
}

/**
 * Same-length fold used on both sides (index text and query): full-width
 * ASCII (U+FF01–U+FF5E) and the ideographic space become their ASCII forms
 * (ＭＣ → mc, １２月 → 12月 — an IME left in full-width mode), then
 * lower-case wherever the lower-case form keeps the length (İ stays as is).
 * Offsets in the folded copy equal offsets in the original, so excerpts and
 * 【】 marks cut from the original text stay aligned.
 */
export function foldSameLength(s: string): string {
    let t = s;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if ((c >= 0xff01 && c <= 0xff5e) || c === 0x3000) {
            let out = "";
            for (let k = 0; k < s.length; k++) {
                const d = s.charCodeAt(k);
                out += d >= 0xff01 && d <= 0xff5e ? String.fromCharCode(d - 0xfee0) : d === 0x3000 ? " " : s[k]!;
            }
            t = out;
            break;
        }
    }
    const l = t.toLowerCase();
    if (l.length === t.length) return l;
    let out = "";
    for (const ch of t) {
        const x = ch.toLowerCase();
        out += x.length === ch.length ? x : ch;
    }
    return out;
}

const uniKey = (c: number): number => c;
const biKey = (c1: number, c2: number): number => 0x10000 + c1 * 0x10000 + c2;

const ZH_DIGIT: Record<string, number> = { "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
function isZhNumeralChar(ch: string): boolean {
    return ch === "十" || ZH_DIGIT[ch] !== undefined;
}

/** Value of a Chinese numeral string in 0–99, or null (十 / 十二 / 二十 / 二十三 / 七 / 两). */
export function zhNumeralValue(s: string): number | null {
    if (s.length === 0 || s.length > 3) return null;
    if (s.length === 1) {
        if (s === "十") return 10;
        const d = ZH_DIGIT[s];
        return d === undefined ? null : d;
    }
    const i = s.indexOf("十");
    if (i === -1) return null;
    if (s.indexOf("十", i + 1) !== -1) return null;
    const head = s.slice(0, i);
    const tail = s.slice(i + 1);
    let tens = 1;
    if (head.length === 1) {
        const d = ZH_DIGIT[head];
        if (d === undefined || d === 0) return null;
        tens = d;
    } else if (head.length > 1) return null;
    let ones = 0;
    if (tail.length === 1) {
        const d = ZH_DIGIT[tail];
        if (d === undefined || d === 0) return null;
        ones = d;
    } else if (tail.length > 1) return null;
    return tens * 10 + ones;
}

const ZH_DIGIT_CHARS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** Chinese spellings of 0–99 (38 → 三十八, 2 → 二 / 两) — the surfaces an
 *  Arabic-digit query unit marks in text written with Chinese numerals. 1 is
 *  left out: a lone 一 is mostly text (一起 / 统一). */
function zhNumeralSurfaces(v: number): string[] {
    if (!Number.isInteger(v) || v < 0 || v > 99 || v === 1) return [];
    if (v < 10) return v === 2 ? ["二", "两"] : [ZH_DIGIT_CHARS[v]!];
    const tens = Math.floor(v / 10);
    const ones = v % 10;
    return [`${tens === 1 ? "" : ZH_DIGIT_CHARS[tens]!}十${ones === 0 ? "" : ZH_DIGIT_CHARS[ones]!}`];
}

function isAsciiLetter(c: number): boolean {
    return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
function isAsciiDigit(c: number): boolean {
    return c >= 0x30 && c <= 0x39;
}

/** Emit the numeral tokens hidden in one CJK run (maximal 十/digit spans). */
function emitZhNumbers(run: string, emit: (k: GramKey) => void): void {
    let i = 0;
    while (i < run.length) {
        if (!isZhNumeralChar(run[i]!)) { i++; continue; }
        let j = i;
        while (j < run.length && isZhNumeralChar(run[j]!)) j++;
        const v = zhNumeralValue(run.slice(i, j));
        if (v !== null) emit(`n:${v}`);
        i = j;
    }
}

/**
 * Walk `text` and emit every index token. CJK runs → unigrams + bigrams (+
 * numeral numbers); ASCII letter runs (>= 2) → "w:<lower>"; digit runs →
 * "n:<digits without leading zeros>". Everything else separates runs.
 */
export function forEachIndexToken(text: string, emit: (k: GramKey) => void): void {
    const n = text.length;
    let i = 0;
    while (i < n) {
        const c = text.charCodeAt(i);
        if (isCjkCode(c)) {
            let j = i;
            while (j < n && isCjkCode(text.charCodeAt(j))) j++;
            let prev = -1;
            for (let k = i; k < j; k++) {
                const ck = text.charCodeAt(k);
                emit(uniKey(ck));
                if (prev >= 0) emit(biKey(prev, ck));
                prev = ck;
            }
            emitZhNumbers(text.slice(i, j), emit);
            i = j;
            continue;
        }
        if (isAsciiLetter(c)) {
            let j = i;
            while (j < n && isAsciiLetter(text.charCodeAt(j))) j++;
            if (j - i >= 2) emit(`w:${text.slice(i, j).toLowerCase()}`);
            i = j;
            continue;
        }
        if (isAsciiDigit(c)) {
            let j = i;
            while (j < n && isAsciiDigit(text.charCodeAt(j))) j++;
            emit(`n:${normDigits(text.slice(i, j))}`);
            i = j;
            continue;
        }
        i++;
    }
}

function normDigits(d: string): string {
    const t = d.replace(/^0+(?=\d)/, "");
    return t.length > 0 ? t : "0";
}

/** One query unit: an index key plus the surface strings an excerpt marks. */
interface QueryUnit {
    key: GramKey;
    /** Visible strings this unit matches in text (lower-cased). */
    surfaces: string[];
    /** True for a unigram that came from a 1-char CJK segment. */
    single: boolean;
    /** Query char positions this unit covers (the evidence gate weighs
     *  positions, so a junk bigram across a word boundary costs nothing when
     *  both its chars are covered by real words). */
    pos: number[];
}

/**
 * Cut a (hub-stripped) query into units: bigrams of each CJK run (the char
 * itself for a 1-char run), ASCII words >= 2, digit runs, and Chinese
 * numerals (0–99, a lone 一 excepted) as number units — a numeral span
 * splits its CJK run so 十二个 does not also demand the bigram 二个.
 */
export function queryUnits(query: string): QueryUnit[] {
    const out: QueryUnit[] = [];
    const seen = new Set<GramKey>();
    const push = (u: QueryUnit): void => {
        if (seen.has(u.key)) {
            const prev = out.find((x) => x.key === u.key);
            if (prev) {
                for (const s of u.surfaces) if (!prev.surfaces.includes(s)) prev.surfaces.push(s);
                for (const p of u.pos) if (!prev.pos.includes(p)) prev.pos.push(p);
            }
            return;
        }
        seen.add(u.key);
        out.push(u);
    };
    const pushCjkSegment = (seg: string, at: number): void => {
        if (seg.length === 0) return;
        if (seg.length === 1) {
            push({ key: uniKey(seg.charCodeAt(0)), surfaces: [seg], single: true, pos: [at] });
            return;
        }
        for (let k = 0; k + 1 < seg.length; k++) push({ key: biKey(seg.charCodeAt(k), seg.charCodeAt(k + 1)), surfaces: [seg.slice(k, k + 2)], single: false, pos: [at + k, at + k + 1] });
    };
    const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_x, i) => a + i);
    const n = query.length;
    let i = 0;
    while (i < n) {
        const c = query.charCodeAt(i);
        if (isCjkCode(c)) {
            let j = i;
            while (j < n && isCjkCode(query.charCodeAt(j))) j++;
            const run = query.slice(i, j);
            // split at numeral spans (a lone 一 stays text: 一起 / 统一)
            let segStart = 0;
            let k = 0;
            while (k < run.length) {
                if (!isZhNumeralChar(run[k]!)) { k++; continue; }
                let e = k;
                while (e < run.length && isZhNumeralChar(run[e]!)) e++;
                const span = run.slice(k, e);
                const v = span === "一" ? null : zhNumeralValue(span);
                if (v !== null) {
                    pushCjkSegment(run.slice(segStart, k), i + segStart);
                    push({ key: `n:${v}`, surfaces: [String(v), span], single: false, pos: range(i + k, i + e) });
                    segStart = e;
                }
                k = e;
            }
            pushCjkSegment(run.slice(segStart), i + segStart);
            i = j;
            continue;
        }
        if (isAsciiLetter(c)) {
            let j = i;
            while (j < n && isAsciiLetter(query.charCodeAt(j))) j++;
            if (j - i >= 2) {
                const w = query.slice(i, j).toLowerCase();
                push({ key: `w:${w}`, surfaces: [w], single: false, pos: range(i, j) });
            }
            i = j;
            continue;
        }
        if (isAsciiDigit(c)) {
            let j = i;
            while (j < n && isAsciiDigit(query.charCodeAt(j))) j++;
            const d = normDigits(query.slice(i, j));
            push({ key: `n:${d}`, surfaces: [d, ...(d.length <= 2 ? zhNumeralSurfaces(Number(d)) : [])], single: false, pos: range(i, j) });
            i = j;
            continue;
        }
        i++;
    }
    return out;
}

/** Character bigram set of a string (near-duplicate check). */
export function bigramSet(s: string): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i + 1 < s.length; i++) {
        const a = s.charCodeAt(i);
        const b = s.charCodeAt(i + 1);
        if (a === 0x20 || b === 0x20 || a === 0x0a || b === 0x0a) continue;
        out.add(s.slice(i, i + 2));
    }
    return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const x of small) if (big.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}
