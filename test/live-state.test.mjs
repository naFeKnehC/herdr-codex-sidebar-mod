import test from "node:test";
import assert from "node:assert/strict";
import {
  codexTerminalLabels,
  isActiveCodexAgent,
  isCodexAgent,
  isCodexCommand,
  managedTabTitle,
  matchLiveChat,
} from "../mods/herdr-codex-sidebar-mod/live-state.mjs";

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

test("the current title wins over resume argv after /new switches threads", () => {
  const session = {
    argv: ["/opt/homebrew/bin/codex", "resume", "old-thread"],
    agent: { title: "⠹ New conversation | project" },
    pane: { cwd: "/tmp/project" },
  };
  const chats = [
    { id: "old-thread", title: "Old conversation", cwd: "/tmp/project" },
    { id: "new-thread", title: "New conversation", cwd: "/tmp/project" },
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

test("infers a new thread from the terminal start time and cwd", () => {
  const session = {
    argv: ["node", "/opt/codex"],
    agent: { title: "Codex" },
    pane: { cwd: "/tmp/project" },
    terminal: { created_ms: 1_800_000_000_000 },
  };
  const chats = [
    { id: "old", title: "Old", cwd: "/tmp/project", createdAt: 1_799_000_000 },
    { id: "new", title: "New conversation", cwd: "/tmp/project", createdAt: 1_800_000_040 },
    { id: "helper", title: "Guardian review", cwd: "/tmp/project", createdAt: 1_800_000_041, subagent: true },
  ];
  assert.equal(matchLiveChat(session, chats).id, "new");
});

test("managed tab names follow the latest agent summary", () => {
  assert.equal(managedTabTitle({
    tabName: "Pi",
    managedName: null,
    chatTitle: "排查沉浸式翻译自动添加网址问题",
  }), "排查沉浸式翻译自动添加网址问题");
  assert.equal(managedTabTitle({
    tabName: "旧标题",
    managedName: "旧标题",
    chatTitle: "新标题",
  }), "新标题");
});

test("a renamed tab is left alone", () => {
  assert.equal(managedTabTitle({
    tabName: "我的自定义标题",
    managedName: "旧标题",
    chatTitle: "新标题",
  }), null);
});

test("unassigned chats clear stale project labels", () => {
  assert.deepEqual(
    codexTerminalLabels(
      { id: null, name: "Unassigned", roots: [] },
      { id: "thread-1" },
      "Conversation",
    ),
    [
      "codex.thread.id=thread-1",
      "codex.managed=true",
      "codex.project.id=",
      "codex.tab.title=Conversation",
      "codex.placeholder=",
    ],
  );
});

test("assigned chats keep their project label", () => {
  assert.deepEqual(
    codexTerminalLabels(
      { id: "project-1", name: "Project", roots: ["/tmp/project"] },
      { id: "thread-1" },
    ),
    [
      "codex.thread.id=thread-1",
      "codex.managed=true",
      "codex.project.id=project-1",
      "codex.placeholder=",
    ],
  );
});

test("placeholder tabs carry a removable marker", () => {
  const labels = codexTerminalLabels(
    { id: "project-1" },
    { id: "thread-1" },
    "Conversation",
    true,
  );
  assert.equal(labels.at(-1), "codex.placeholder=true");
});
