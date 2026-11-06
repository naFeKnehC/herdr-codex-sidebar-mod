import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findTranscriptPath,
  parseTranscriptLines,
  readThreadTranscript,
  renderTranscript,
  sanitizeTerminalText,
} from "../mods/herdr-codex-sidebar-mod/helper/lib/transcript.mjs";

test("extracts user and agent messages from completed events", () => {
  const lines = [
    JSON.stringify({
      timestamp: "2026-11-02T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          content: [
            { type: "local_image", path: "/tmp/image.png" },
            { type: "text", text: "Hello" },
          ],
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-11-02T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "AgentMessage", content: [{ type: "Text", text: "Hi there" }] },
      },
    }),
    "not json",
  ];
  assert.deepEqual(parseTranscriptLines(lines), [
    {
      role: "user",
      text: "[image: image.png]\nHello",
      at: "2026-11-02T10:00:00.000Z",
    },
    {
      role: "assistant",
      text: "Hi there",
      at: "2026-11-02T10:00:01.000Z",
    },
  ]);
});

test("falls back to response items without environment messages", () => {
  const lines = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>hidden</environment_context>" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Question" }] },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] },
    }),
  ];
  assert.deepEqual(parseTranscriptLines(lines).map((message) => message.text), ["Question", "Answer"]);
});

test("renders a readable history preview and strips terminal escapes", () => {
  const output = renderTranscript({
    agent: "codex",
    title: "A chat",
    sessionId: "thread-1",
    cwd: "/tmp/project",
    messages: [{ role: "user", text: "\x1b]0;owned\x07Hello", at: "2026-11-02T10:00:00.000Z" }],
    color: false,
  });
  assert.match(output, /Codex history: A chat/);
  assert.match(output, /Session thread-1/);
  assert.match(output, /You/);
  assert.match(output, /Hello/);
  assert.doesNotMatch(output, /owned/);
  assert.match(output, /Double-click the chat/);
  assert.equal(sanitizeTerminalText("\x1b[31mred\x1b[0m"), "red");
});

test("renders Claude and Hermes previews with their own names", () => {
  for (const [agent, name] of [["claude", "Claude"], ["hermes", "Hermes"]]) {
    const output = renderTranscript({
      agent,
      title: "Chat",
      sessionId: "s1",
      messages: [{ role: "assistant", text: "Answer" }],
      color: false,
    });
    assert.match(output, new RegExp(`${name} history: Chat`));
    assert.match(output, new RegExp(`resume ${name}`));
    assert.match(output, /Answer/);
  }
});

test("limits very large previews and sanitizes control characters", () => {
  const messages = Array.from({ length: 250 }, (_, index) => ({
    role: index % 2 ? "user" : "assistant",
    text: `\u0007message ${index}`,
  }));
  const output = renderTranscript({ agent: "claude", title: "Big", sessionId: "s", messages, color: false });
  assert.match(output, /more message\(s\) not shown/);
  assert.doesNotMatch(output, /\u0007/);
});

test("finds and reads a transcript by thread id", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-history-"));
  const directory = join(home, "sessions", "2026", "11", "02");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "rollout-thread-1.jsonl");
  await writeFile(path, `${JSON.stringify({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "AgentMessage", content: [{ type: "Text", text: "History" }] },
    },
  })}\n`);

  assert.equal(await findTranscriptPath({ codexHome: home, threadId: "thread-1" }), path);
  const transcript = await readThreadTranscript({ codexHome: home, threadId: "thread-1" });
  assert.equal(transcript.messages[0].text, "History");
});
