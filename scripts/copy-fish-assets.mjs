#!/usr/bin/env node
// fork（日期，D2）：把 src/fish/reldate.mjs（fish-dsh sessionless/reldate/reldate.mjs 的逐字节拷贝）和它的
// 第三方声明原样拷到 dist/fish/。tsup 不打包它：src/fish/reldate-load.ts 运行时读这份文件、核 sha256、
// 对得上才用（对不上 = 日期注记整条不启用）。这里先核一遍 sha，对不上就让 build 失败（不发一个必然关着的包）。
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "fish");
const out = join(root, "dist", "fish");
const want = readFileSync(join(src, "reldate.sha256"), "utf8").trim().split(/\s+/)[0];
const got = createHash("sha256").update(readFileSync(join(src, "reldate.mjs"))).digest("hex");
const load = readFileSync(join(src, "reldate-load.ts"), "utf8");
if (got !== want || !load.includes(`"${want}"`)) {
    console.error(`[copy-fish-assets] reldate.mjs sha256 ${got} does not match reldate.sha256 ${want} / RELDATE_SHA256 in reldate-load.ts`);
    process.exit(1);
}
mkdirSync(out, { recursive: true });
copyFileSync(join(src, "reldate.mjs"), join(out, "reldate.mjs"));
copyFileSync(join(src, "RELDATE-THIRD-PARTY-NOTICES"), join(out, "RELDATE-THIRD-PARTY-NOTICES"));
console.log(`[copy-fish-assets] dist/fish/reldate.mjs ${got.slice(0, 12)}`);
