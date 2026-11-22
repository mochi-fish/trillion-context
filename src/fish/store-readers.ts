/**
 * fork（日期）：日期注记从统一库读东西的三个口子（只读）。只在 fish.dateNotes 开着时才会被调；
 * 关着时没有任何一条走到这里。
 */

import type { CompressionState, CoreMessage } from "acp-kernel";
import { getStore } from "../persist.js";
import type { RowSource } from "../search-cjk/corpus.js";
import { fishDateNotesTz, type DecompressRows } from "./date-notes.js";
import { noteOccResponseEnd, recordOccurrences } from "./occ-ledger.js";
import type { OccExtReader } from "./occurrence.js";

export const fishRowSource: RowSource & DecompressRows = {
    page: (id, after, limit, skipKinds) => getStore().unifiedSearchRowsPage(id, after, limit, skipKinds),
    byRefRange: (id, lo, hi) => getStore().unifiedSearchRowsByRefRange(id, lo, hi),
};

export const fishOccExt: OccExtReader = {
    list: (id) => getStore().listSessionExt(id),
};

/** D4：这一轮内核盖完章以后（prepare-* 里 session.state = turn.state 之前）调；只在 recordOccurrence 开着时调。不抛。 */
export function fishOccRecordTurn(sessionId: string, prev: CompressionState, next: CompressionState, messages: readonly CoreMessage[]): void {
    try {
        recordOccurrences(sessionId, prev, next, messages, getStore(), fishDateNotesTz(), Date.now());
    } catch {
        // 只少 A 档
    }
}

/** D4：上游回复结算的那一刻；只在 recordOccurrence 开着时调。 */
export function fishOccResponseEnd(sessionId: string): void {
    noteOccResponseEnd(sessionId, Date.now());
}
