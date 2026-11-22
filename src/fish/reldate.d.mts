// fork（日期，D2）：reldate.mjs 的类型声明（手写；正本是 .mjs，见 fish-dsh sessionless/reldate/RD-NOTES.md 第六节）。
// reldate.mjs 本身是逐字节拷贝，不能改；这里只描述它的导出。代码里不静态 import 它（见 reldate-load.ts）。

export type RelDateAnchor = { at: number } | { lo: number; hi: number };

interface RelDateOpts {
    tzOffsetMin: number;
    nightEndHour?: number;
    maxHits?: number;
}

interface RelDateHit {
    start: number;
    end: number;
    cls: string;
    kind: string;
    value: string;
    note: string;
    edge?: string;
    via?: string;
}

interface RelDateScan {
    hits: RelDateHit[];
    skips: Record<string, number>;
}

interface RelDateLocalParts {
    y: number;
    m: number;
    d: number;
    wd: number;
    hh: number;
    mi: number;
    dayNo: number;
}

export declare const RELDATE_VERSION: string;
export declare const RELDATE_LEGEND: string;
export declare const RELDATE_SKIP_KEYS: readonly string[];
export declare const RELDATE_CLASSES: readonly string[];
export declare function localParts(ms: number, tzOffsetMin: number): RelDateLocalParts | null;
export declare function resolveAnchor(anchor: RelDateAnchor | null | undefined, tzOffsetMin: number, nightEndHour?: number): (RelDateLocalParts & { night: boolean }) | null;
export declare function pinClock(refMs: number, hh: number, mm: number, tzOffsetMin: number, maxBackMin?: number): number | null;
export declare function findRelDates(text: string, anchor: RelDateAnchor | null | undefined, opts: RelDateOpts): RelDateScan;
export declare function annotateText(text: string, anchor: RelDateAnchor | null | undefined, opts: RelDateOpts): RelDateScan & { text: string };
export declare function annotateWindow(fullText: string, winStart: number, winEnd: number, anchor: RelDateAnchor | null | undefined, opts: RelDateOpts): RelDateScan & { text: string };
export declare function stripRelDates(text: string): string;
