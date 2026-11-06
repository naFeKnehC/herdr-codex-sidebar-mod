import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyClaudeLive,
  parseClaudeJsonl,
  readClaudeLiveEntries,
  readClaudePreview,
  readClaudeSessions,
} from "../mods/herdr-codex-sidebar-mod/helper/lib/adapters/claude.mjs";

const row = (value) => JSON.stringify(value);

async function fixture({ lines, filename = "session-1.jsonl", extra = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  const claudeHome = join(root, ".claude");
  const directory = join(claudeHome, "projects", "-tmp-project");
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  await writeFile(path, lines.join("\n"));
  for (const [relative, content] of extra) {
    const target = join(directory, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return { root, claudeHome, directory, path };
}

test("discovers only top-level JSONL sessions and parses id, cwd and title", async () => {
  const lines = [
    row({ type: "custom-title", customTitle: "Custom title", sessionId: "session-1", cwd: "/tmp/project", timestamp: "2026-11-04T10:00:00Z" }),
    row({ type: "user", sessionId: "session-1", cwd: "/tmp/project", message: { role: "user", content: "First question" }, timestamp: "2026-11-04T10:00:01Z" }),
    row({ type: "assistant", sessionId: "session-1", cwd: "/tmp/project", message: { role: "assistant", content: [{ type: "text", text: "Answer" }] }, timestamp: "2026-11-04T10:00:02Z" }),
  ];
  const { claudeHome, directory } = await fixture({
    lines,
    extra: [[join("session-1", "subagents", "agent-1.jsonl"), row({
      type: "user", sessionId: "agent-1", cwd: "/tmp/project", message: { role: "user", content: "Subagent" },
    })]],
  });
  const result = await readClaudeSessions({ claudeHome, liveStatus: false });
  assert.equal(result.available, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, "session-1");
  assert.equal(result.sessions[0].cwd, "/tmp/project");
  assert.equal(result.sessions[0].title, "Custom title");
  assert.equal(result.sessions[0].path, join(directory, "session-1.jsonl"));
});

test("uses file name as id when sessionId is absent", () => {
  const parsed = parseClaudeJsonl([
    row({ type: "user", cwd: "/tmp/project", message: { role: "user", content: "Hello" } }),
  ], { path: "/tmp/abc.jsonl" });
  assert.equal(parsed.session.id, "abc");
});

test("takes the first cwd that appears", () => {
  const parsed = parseClaudeJsonl([
    row({ type: "user", message: { role: "user", content: "one" } }),
    row({ type: "assistant", cwd: "/tmp/project", message: { role: "assistant", content: "two" } }),
    row({ type: "assistant", cwd: "/tmp/later", message: { role: "assistant", content: "three" } }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(parsed.session.cwd, "/tmp/project");
});

test("title priority is custom-title > ai-title > first user text > last-prompt", () => {
  const withCustom = parseClaudeJsonl([
    row({ type: "ai-title", aiTitle: "AI title", timestamp: "2026-11-04T10:00:03Z" }),
    row({ type: "custom-title", customTitle: "Custom", timestamp: "2026-11-04T10:00:01Z" }),
    row({ type: "user", message: { role: "user", content: "First user" }, timestamp: "2026-11-04T10:00:02Z" }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(withCustom.session.title, "Custom");

  const withAi = parseClaudeJsonl([
    row({ type: "ai-title", aiTitle: "AI title" }),
    row({ type: "user", message: { role: "user", content: "First user" } }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(withAi.session.title, "AI title");

  const withUser = parseClaudeJsonl([
    row({ type: "last-prompt", lastPrompt: "Last prompt" }),
    row({ type: "user", message: { role: "user", content: "First user" } }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(withUser.session.title, "First user");

  const withLast = parseClaudeJsonl([
    row({ type: "last-prompt", lastPrompt: "Last prompt" }),
    row({ type: "assistant", message: { role: "assistant", content: "Answer" } }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(withLast.session.title, "Last prompt");

  const untitled = parseClaudeJsonl([
    row({ type: "assistant", message: { role: "assistant", content: "Answer" } }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(untitled.session.title, "Untitled chat");
});

test("the latest title event wins", () => {
  const parsed = parseClaudeJsonl([
    row({ type: "custom-title", customTitle: "Old", timestamp: "2026-11-04T10:00:00Z" }),
    row({ type: "custom-title", customTitle: "New", timestamp: "2026-11-04T11:00:00Z" }),
    row({ type: "custom-title", customTitle: "Older", timestamp: "2026-11-04T09:00:00Z" }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(parsed.session.title, "New");
});

test("skips bad JSON lines and sidechain messages but keeps readable sessions", () => {
  const parsed = parseClaudeJsonl([
    "not json",
    row({ type: "user", sessionId: "s1", message: { role: "user", content: "Real" } }),
    row({ type: "user", isSidechain: true, message: { role: "user", content: "Sidechain" } }),
    row({ type: "assistant", isSidechain: true, message: { role: "assistant", content: "Side answer" } }),
    row({ type: "assistant", message: { role: "assistant", content: "Answer" } }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(parsed.session.id, "s1");
  assert.deepEqual(parsed.messages.map((message) => message.text), ["Real", "Answer"]);
  assert.ok(parsed.warnings.some((warning) => /malformed/.test(warning)));
});

test("folds tool results instead of embedding raw JSON", () => {
  const parsed = parseClaudeJsonl([
    row({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", content: "{\"huge\":true}" },
          { type: "text", text: "Human follow-up" },
        ],
      },
    }),
    row({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "x" }] } }),
  ], { path: "/tmp/s.jsonl" });
  assert.match(parsed.messages[0].text, /\[tool\]/);
  assert.doesNotMatch(parsed.messages[0].text, /huge/);
  assert.equal(parsed.messages[1].text, "[tool]");
});

test("ignores environment/system user messages for title and preview", () => {
  const parsed = parseClaudeJsonl([
    row({ type: "user", message: { role: "user", content: "<environment_context>hidden</environment_context>" } }),
    row({ type: "user", message: { role: "user", content: "Actual question" } }),
  ], { path: "/tmp/s.jsonl" });
  assert.equal(parsed.session.title, "Actual question");
  assert.deepEqual(parsed.messages.map((message) => message.text), ["Actual question"]);
});

test("reads live session entries only for alive PIDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-live-"));
  const claudeHome = join(root, ".claude");
  await mkdir(join(claudeHome, "sessions"), { recursive: true });
  await writeFile(join(claudeHome, "sessions", "101.json"), JSON.stringify({
    sessionId: "busy-session", status: "busy", cwd: "/tmp/project", updatedAt: 200,
  }));
  await writeFile(join(claudeHome, "sessions", "202.json"), JSON.stringify({
    sessionId: "dead-session", status: "busy",
  }));
  const live = await readClaudeLiveEntries({ claudeHome, alive: (pid) => pid === 101 });
  assert.equal(live.entries.length, 1);
  assert.equal(live.entries[0].sessionId, "busy-session");
  assert.equal(live.entries[0].status, "working");
});

test("applies busy/idle and marks multiple live PIDs as ambiguous", () => {
  const sessions = [{ id: "busy" }, { id: "idle" }, { id: "multi" }];
  applyClaudeLive(sessions, [
    { sessionId: "busy", pid: 1, status: "working", updatedAt: 1 },
    { sessionId: "idle", pid: 2, status: "idle", updatedAt: 1 },
    { sessionId: "multi", pid: 3, status: "working", updatedAt: 1 },
    { sessionId: "multi", pid: 4, status: "idle", updatedAt: 2 },
  ]);
  assert.equal(sessions[0].live.status, "working");
  assert.equal(sessions[1].live.status, "idle");
  assert.equal(sessions[2].live.status, "idle");
  assert.equal(sessions[2].live.ambiguous, true);
});

test("reads a read-only Claude preview without launching the agent", async () => {
  const { claudeHome, path } = await fixture({
    lines: [
      row({ type: "user", sessionId: "session-1", message: { role: "user", content: "\x1b[31mQuestion\x1b[0m" } }),
      row({ type: "assistant", sessionId: "session-1", message: { role: "assistant", content: "Answer" } }),
    ],
  });
  const preview = await readClaudePreview({ claudeHome, sessionId: "session-1" });
  assert.equal(preview.path, path);
  assert.equal(preview.messages.length, 2);
  assert.equal(await readFile(path, "utf8").then((text) => text.includes("Question")), true);
});

test("reports an unavailable data root without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-missing-"));
  const result = await readClaudeSessions({ claudeHome: join(root, "missing") });
  assert.equal(result.available, false);
  assert.match(result.reason, /not found/);
  assert.deepEqual(result.sessions, []);
});
