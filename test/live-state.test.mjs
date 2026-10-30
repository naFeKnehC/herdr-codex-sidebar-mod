import test from "node:test";
import assert from "node:assert/strict";
import { isActiveCodexAgent, isCodexAgent, isCodexCommand, matchLiveChat } from "../mods/codex-history/live-state.mjs";

test("only active Codex agents count as live", () => {
  assert.equal(isActiveCodexAgent({ app: "codex", status: "working" }), true);
  assert.equal(isActiveCodexAgent({ app: "codex", status: "blocked" }), true);
  assert.equal(isActiveCodexAgent({ program: { key: "codex" }, status: "idle" }), false);
  assert.equal(isActiveCodexAgent({ app: "codex", status: "done" }), false);
  assert.equal(isActiveCodexAgent({ app: "shell", status: "working" }), false);
});

test("idle Codex agents remain available for focus", () => {
  assert.equal(isCodexAgent({ app: "codex", status: "idle" }), true);
  assert.equal(isActiveCodexAgent({ app: "codex", status: "idle" }), false);
});

test("recognizes Codex executable paths", () => {
  assert.equal(isCodexCommand("/opt/homebrew/bin/codex"), true);
  assert.equal(isCodexCommand("codex"), true);
  assert.equal(isCodexCommand("zsh"), false);
});

test("matches a resumed thread by the current command, not stale labels", () => {
  const session = {
    argv: ["/opt/homebrew/bin/codex", "resume", "new-thread"],
    agent: { title: "A reused pane" },
    pane: { cwd: "/tmp/project" },
  };
  const chats = [
    { id: "old-thread", title: "Old chat", cwd: "/tmp/project" },
    { id: "new-thread", title: "New chat", cwd: "/tmp/project" },
  ];
  assert.equal(matchLiveChat(session, chats).id, "new-thread");
});

test("does not mark duplicate title chats live for one id-less session", () => {
  const session = {
    argv: ["codex"],
    agent: { title: "Same title" },
    pane: { cwd: "/tmp/project" },
  };
  const chats = [
    { id: "first", title: "Same title", cwd: "/tmp/project" },
    { id: "second", title: "Same title", cwd: "/tmp/project" },
  ];
  assert.equal(matchLiveChat(session, chats), null);
});

test("does not require the reused pane foreground command to be codex", () => {
  const session = {
    argv: ["zsh"],
    agent: { title: "Current chat" },
    pane: { cwd: "/tmp/project" },
  };
  assert.equal(matchLiveChat(session, [{ id: "current", title: "Current chat", cwd: "/tmp/project" }]).id, "current");
});
