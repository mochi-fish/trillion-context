// fork（养成向）：Anthropic 线上 `source.type: "file"` 的图——出口那一道闸。
//
// 这类图的原图在宿主那边：宿主每次发请求前现查自己的上传索引，快过期的先重传、
// 换新的 file_id（DeepSeek 7 天就删）。所以发给上游的图片块只能是「这一次宿主
// 送来的」——账本、快照、canonical 里存着的旧 file_id 一律不许上线：发出去要么
// 400（对方已经删了），要么张冠李戴。
//
// 正常的路上出站的每个图片块本来就来自这一次的入站（代理按入站重建），这道闸
// 是兜底：凡是出站里出现、入站里没有的 file_id，换成一段占位字，并记数。只在
// compress.foldHostFileImages 开着时启用（不开时和上游逐字节一样）。
import { HOST_HELD_IMAGE_PLACEHOLDER } from "./image-note.js";

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fileIdOf(block: unknown): string | undefined {
    if (!isObj(block) || block.type !== "image") return undefined;
    const s = block.source;
    return isObj(s) && s.type === "file" && typeof s.file_id === "string" && s.file_id.length > 0 ? s.file_id : undefined;
}

/** Every Anthropic file-sourced image id in a messages array — top-level
 *  content blocks and images nested in tool_result content. */
export function collectAnthropicFileIds(messages: unknown): Set<string> {
    const ids = new Set<string>();
    if (!Array.isArray(messages)) return ids;
    for (const m of messages) {
        const content = isObj(m) ? m.content : undefined;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
            const id = fileIdOf(b);
            if (id) ids.add(id);
            if (isObj(b) && b.type === "tool_result" && Array.isArray(b.content)) {
                for (const nb of b.content) {
                    const nid = fileIdOf(nb);
                    if (nid) ids.add(nid);
                }
            }
        }
    }
    return ids;
}

const PLACEHOLDER_BLOCK = (): { type: "text"; text: string } => ({ type: "text", text: HOST_HELD_IMAGE_PLACEHOLDER });

/** Replace every file-sourced image whose id is NOT in `allowed` (this
 *  request's inbound ids) with a plain-text placeholder. Copy-on-write: the
 *  input array (and every untouched message/block) is returned by reference
 *  when nothing needed replacing. */
export function replaceForeignFileImages<T>(messages: readonly T[], allowed: ReadonlySet<string>): { messages: T[]; replaced: number } {
    let replaced = 0;
    let changed = false;
    const out = messages.map((m) => {
        if (!isObj(m) || !Array.isArray(m.content)) return m;
        let blockChanged = false;
        const content = (m.content as unknown[]).map((b) => {
            const id = fileIdOf(b);
            if (id !== undefined && !allowed.has(id)) {
                replaced++;
                blockChanged = true;
                return PLACEHOLDER_BLOCK();
            }
            if (isObj(b) && b.type === "tool_result" && Array.isArray(b.content)) {
                let nestedChanged = false;
                const nested = (b.content as unknown[]).map((nb) => {
                    const nid = fileIdOf(nb);
                    if (nid !== undefined && !allowed.has(nid)) {
                        replaced++;
                        nestedChanged = true;
                        return PLACEHOLDER_BLOCK();
                    }
                    return nb;
                });
                if (nestedChanged) {
                    blockChanged = true;
                    return { ...b, content: nested };
                }
            }
            return b;
        });
        if (!blockChanged) return m;
        changed = true;
        return { ...m, content } as T;
    });
    return { messages: changed ? out : (messages as T[]), replaced };
}
