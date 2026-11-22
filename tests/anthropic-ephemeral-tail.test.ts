import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { createCore } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody, type AnthropicWireMessage } from "acp-kernel/wire";
import { resolveCompressPrompts, resolveCompressSurface } from "../src/compress-settings.js";
import { loadOptions } from "../src/config.js";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.js";
import { prepareAnthropic } from "../src/server/prepare-anthropic.js";
import { createSession } from "../src/session.js";

const trailingSystems: AnthropicWireMessage[] = [
    { role: "system", content: [{ type: "text", text: "Keep the current instructions." }] },
    { role: "system", content: [], output_config: { effort: "high" } },
];

function request(): AnthropicRequestBody {
    return { model: "test-model", max_tokens: 32, messages: [
        { role: "user", content: "Look up the sample." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_sample", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sample", content: "sample result" }] },
        ...structuredClone(trailingSystems),
    ] };
}

function assertTail(messages: AnthropicWireMessage[], note: string): void {
    assert.deepEqual(messages.map(m => m.role), ["user", "assistant", "user", "user", "system", "system"]);
    const textBlocks = messages.at(-2)?.content;
    assert.ok(Array.isArray(textBlocks) && textBlocks.length === 1 && textBlocks[0].type === "text");
    assert.ok(textBlocks[0].text.endsWith("Keep the current instructions."));
    assert.deepEqual(messages.at(-1), trailingSystems[1]);
    assert.equal(messages.at(-3)?.content, note);
    assert.match(JSON.stringify(messages[1].content), /"id":"toolu_sample"/);
    assert.match(JSON.stringify(messages[2].content), /"tool_use_id":"toolu_sample"/);
}

test("the proxy status note stays before a trailing system run on the main request", async () => {
    const note = "[ACP status fixture]";
    const core = createCore();
    const opts = loadOptions({});
    const socket = new Socket();
    try {
        const prepared = await prepareAnthropic(request(), new IncomingMessage(socket), opts, {
            ...core, processTurn(input) { return { ...core.processTurn(input), statusLine: note }; },
        }, opts.kernelConfig, resolveCompressPrompts({}), resolveCompressSurface({}), () => {},
        createSession("ephemeral-system-tail"), false, "http://127.0.0.1", undefined, false);
        assertTail(JSON.parse(prepared.body.toString()).messages, note);
    } finally {
        socket.destroy();
    }
});

test("the follow-up request keeps its adapter note before the same system run", () => {
    const body = request();
    const note = "Updated system anchor.";
    const adapter = createAnthropicAdapter(body, body.system, [note]);
    const result = adapter.buildRequest(anthropicToCore(body).msgs, "", body);
    assertTail(result.messages as AnthropicWireMessage[], note);
});
