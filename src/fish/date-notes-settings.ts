/**
 * fork（日期）：顶层 `fish.dateNotes` 配置块的类型、缺省值和严格解析（没有任何 import，config.ts 和 date-notes.ts 共用）。
 *
 *   "fish": { "dateNotes": { "enabled": false, "summaries": false, "tzOffsetMin": 540, "nightEndHour": 5,
 *                            "maxPerResult": 24, "maxPerSnippet": 3, "recordOccurrence": false } }
 *
 * 严格：块里有一个认不出的键、或者有一个值不对，整块当没写（= 全关），并把问题交回给调用方记日志。
 * 没写 `fish` = Options 上没有这个键（和这一包之前逐字节一样）。
 */

export interface DateNotesSettings {
    enabled: boolean;
    summaries: boolean;
    tzOffsetMin: number;
    nightEndHour: number;
    maxPerResult: number;
    maxPerSnippet: number;
    recordOccurrence: boolean;
}

export const DATE_NOTES_DEFAULTS: Readonly<DateNotesSettings> = Object.freeze({
    enabled: false,
    summaries: false,
    tzOffsetMin: 540,
    nightEndHour: 5,
    maxPerResult: 24,
    maxPerSnippet: 3,
    recordOccurrence: false,
});

export interface FishSettings {
    dateNotes?: DateNotesSettings;
}

const BOOL_KEYS = ["enabled", "summaries", "recordOccurrence"] as const;
const INT_KEYS: Record<"tzOffsetMin" | "nightEndHour" | "maxPerResult" | "maxPerSnippet", [number, number]> = {
    tzOffsetMin: [-720, 840],
    nightEndHour: [0, 12],
    maxPerResult: [1, 200],
    maxPerSnippet: [1, 24],
};

/** 解析顶层 `fish`。回 { fish?, problems }：problems 非空时 fish 不带（整块当没写）。 */
export function parseFishSettings(raw: unknown): { fish?: FishSettings; problems: string[] } {
    if (raw === undefined || raw === null) return { problems: [] };
    if (typeof raw !== "object" || Array.isArray(raw)) return { problems: ["fish must be an object"] };
    const problems: string[] = [];
    const o = raw as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== "dateNotes") problems.push(`fish: unknown key "${k}"`);
    const dn = o.dateNotes;
    let dateNotes: DateNotesSettings | undefined;
    if (dn !== undefined && dn !== null) {
        if (typeof dn !== "object" || Array.isArray(dn)) problems.push("fish.dateNotes must be an object");
        else {
            const d = dn as Record<string, unknown>;
            const out: DateNotesSettings = { ...DATE_NOTES_DEFAULTS };
            for (const k of Object.keys(d)) {
                if ((BOOL_KEYS as readonly string[]).includes(k)) {
                    const v = d[k];
                    if (typeof v === "boolean") (out as unknown as Record<string, unknown>)[k] = v;
                    else problems.push(`fish.dateNotes.${k} must be true or false`);
                } else if (Object.prototype.hasOwnProperty.call(INT_KEYS, k)) {
                    const [lo, hi] = INT_KEYS[k as keyof typeof INT_KEYS];
                    const v = d[k];
                    if (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi) (out as unknown as Record<string, unknown>)[k] = v;
                    else problems.push(`fish.dateNotes.${k} must be an integer ${lo}–${hi}`);
                } else problems.push(`fish.dateNotes: unknown key "${k}"`);
            }
            dateNotes = out;
        }
    }
    if (problems.length > 0) return { problems };
    return dateNotes ? { fish: { dateNotes }, problems } : { fish: {}, problems };
}
