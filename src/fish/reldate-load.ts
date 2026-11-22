/**
 * fork（日期，D2）：载入 reldate.mjs 的逐字节拷贝，核 sha256，对不上整条不启用。
 *
 * reldate.mjs 是 fish-dsh `sessionless/reldate/reldate.mjs` 的逐字节拷贝（桥和 fish-ledger-core 里各有一份，
 * 三处跑同一份用例 tests/fixtures/reldate-cases.json）。它不进 tsup 的打包：build 把它原样拷到
 * dist/fish/reldate.mjs（scripts/copy-fish-assets.mjs），这里读出字节、算 sha256、和 RELDATE_SHA256 比，
 * 对得上才用同一份字节 import（data: URL，读到的就是跑的，中间没有第二次读文件）。
 *
 * 找文件的顺序：和本模块同目录（tsx 跑 src/fish/reldate-load.ts）→ 同目录的 fish/（dist/index.js）
 * → 上一级的 fish/（dist/agent/*.js）。都找不到、读不了、sha 不对、import 抛错 → null，调用方当「日期注记关着」。
 *
 * 只在 fish.dateNotes.enabled 开着时才会被调（setFishDateNotes 里预载）；关着时一个文件都不读。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as RelDate from "./reldate.mjs";

export type RelDateModule = typeof RelDate;

/** reldate.mjs 正本（RELDATE_VERSION '2'）的 sha256。改正本要同时改这里、src/fish/reldate.sha256 和用例。 */
export const RELDATE_SHA256 = "7af987206bdee56fd3989ccc9ab5cabf08412333cd8a66d1b5646dcda2ee7ca6";

type RelDateLoadState = "idle" | "loading" | "ok" | "missing" | "sha-mismatch" | "import-failed";

let state: RelDateLoadState = "idle";
let loaded: RelDateModule | null = null;
let pending: Promise<RelDateModule | null> | null = null;

function candidates(): string[] {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return [path.join(here, "reldate.mjs"), path.join(here, "fish", "reldate.mjs"), path.join(path.dirname(here), "fish", "reldate.mjs")];
}

async function doLoad(files: readonly string[] = candidates()): Promise<RelDateModule | null> {
    let bytes: Buffer | null = null;
    for (const f of files) {
        try {
            bytes = readFileSync(f);
            break;
        } catch {
            // next candidate
        }
    }
    if (bytes === null) {
        state = "missing";
        return null;
    }
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== RELDATE_SHA256) {
        state = "sha-mismatch";
        return null;
    }
    try {
        const mod = (await import(`data:text/javascript;base64,${bytes.toString("base64")}`)) as RelDateModule;
        if (typeof mod.annotateText !== "function" || typeof mod.annotateWindow !== "function" || typeof mod.resolveAnchor !== "function") {
            state = "import-failed";
            return null;
        }
        loaded = mod;
        state = "ok";
        return mod;
    } catch {
        state = "import-failed";
        return null;
    }
}

/** 预载（幂等）。结果：模块或 null。 */
export function loadRelDate(): Promise<RelDateModule | null> {
    if (loaded) return Promise.resolve(loaded);
    if (pending) return pending;
    state = "loading";
    pending = doLoad();
    return pending;
}

/** 同步取：已经载好的模块，没载好（还在载、载不了）都是 null。 */
export function relDateModule(): RelDateModule | null {
    return loaded;
}

export function relDateLoadState(): RelDateLoadState {
    return state;
}

/** 测试用：从指定的文件走一遍同样的读、核、载（结果进缓存，和正常载入一样）。 */
export async function _loadRelDateFromForTest(files: readonly string[]): Promise<{ mod: RelDateModule | null; state: RelDateLoadState }> {
    _resetRelDateForTest();
    state = "loading";
    pending = doLoad(files);
    const mod = await pending;
    return { mod, state };
}

/** 测试用：清掉缓存，下次重新读（不影响别的）。 */
export function _resetRelDateForTest(): void {
    state = "idle";
    loaded = null;
    pending = null;
}
