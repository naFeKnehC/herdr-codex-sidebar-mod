import test from "node:test";
import assert from "node:assert/strict";
import {
  agentKindOf,
  agentTerminalLabels,
  isActiveAgent,
  isAgent,
  isAgentCommand,
  labelValue,
  managedTabTitle,
  matchLiveChat,
  matchLiveSession,
  resumedSessionId,
  sessionIdentity,
} from "../mods/herdr-codex-sidebar-mod/live-state.mjs";

test("recognizes Claude and Codex agents and commands", () => {
  assert.equal(agentKindOf({ app: "claude" }), "claude");
  assert.equal(agentKindOf({ app: "claude-code" }), "claude");
  assert.equal(agentKindOf({ program: { key: "codex" } }), "codex");
  // Hermes 支持已移除，旧数据中的 hermes 不能再被识别。
  assert.equal(agentKindOf({ program: { key: "hermes" } }), null);
  assert.equal(agentKindOf("Claude"), "claude");
  assert.equal(agentKindOf({ app: "shell" }), null);
  assert.equal(isAgent({ app: "codex" }, "codex"), true);
  assert.equal(isAgent({ app: "codex" }, "claude"), false);
  assert.equal(isAgentCommand("/opt/homebrew/bin/codex", "codex"), true);
  assert.equal(isAgentCommand("/opt/bin/claude", "claude"), true);
  assert.equal(isAgentCommand("hermes", "hermes"), false);
  assert.equal(isAgentCommand("zsh"), false);
});

test("only working or blocked agents count as active", () => {
  assert.equal(isActiveAgent({ app: "codex", status: "working" }), true);
  assert.equal(isActiveAgent({ app: "claude", status: "blocked" }), true);
  assert.equal(isActiveAgent({ app: "shell", status: "working" }), false);
});

test("writes generic agent labels and clears legacy codex labels", () => {
  const labels = agentTerminalLabels({
    kind: "claude",
    sessionId: "session-1",
    cwd: "/tmp/it's here",
    tabTitle: "Conversation",
    placeholder: true,
  });
  assert.ok(labels.includes("agent.kind=claude"));
  assert.ok(labels.includes("agent.session.id=session-1"));
  assert.ok(labels.includes("agent.cwd=/tmp/it's here"));
  assert.ok(labels.includes("agent.managed=true"));
  assert.ok(labels.includes("agent.placeholder=true"));
  assert.ok(labels.includes("agent.tab.title=Conversation"));
  assert.ok(labels.includes("agent.preview.exit="));
  assert.ok(labels.includes("agent.resume.exit="));
  assert.ok(labels.includes("codex.thread.id="));
  assert.ok(labels.includes("codex.project.id="));
});

test("reads generic labels first and falls back to legacy codex labels", () => {
  assert.deepEqual(sessionIdentity({
    labels: {
      "agent.kind": "codex",
      "agent.session.id": "x1",
      "agent.cwd": "/tmp/x",
    },
  }), { agent: "codex", id: "x1", cwd: "/tmp/x" });

  assert.deepEqual(sessionIdentity({
    labels: { "codex.thread.id": "old", "codex.cwd": "/tmp/old" },
  }), { agent: "codex", id: "old", cwd: "/tmp/old" });

  assert.deepEqual(sessionIdentity({ labels: ["agent.kind=claude", "agent.session.id=c1"] }), {
    agent: "claude",
    id: "c1",
    cwd: null,
  });
});

test("parses resume ids for --resume and codex resume syntax", () => {
  assert.equal(resumedSessionId(["claude", "--resume", "c1"], "claude"), "c1");
  assert.equal(resumedSessionId(["codex", "--no-daemon", "-C", "/tmp", "resume", "x1"], "codex"), "x1");
  assert.equal(resumedSessionId(["zsh"], "codex"), null);
});

test("matches a Claude session by agent.session.id label", () => {
  const sessions = [
    { agent: "claude", id: "c1", title: "One", cwd: "/tmp/project" },
    { agent: "claude", id: "c2", title: "Two", cwd: "/tmp/project" },
  ];
  const live = {
    agent: { app: "claude", title: "Claude" },
    pane: { cwd: "/tmp/project" },
    terminal: { labels: { "agent.kind": "claude", "agent.session.id": "c2" } },
  };
  const result = matchLiveSession(live, sessions, { kind: "claude" });
  assert.equal(result.session.id, "c2");
  assert.equal(result.confidence, "confirmed");
});

test("matches a Codex session through legacy labels and current argv", () => {
  const sessions = [{ agent: "codex", id: "t1", title: "Old", cwd: "/tmp/project" }];
  const live = {
    agent: { app: "codex", title: "Codex" },
    pane: { cwd: "/tmp/project" },
    terminal: { labels: { "codex.thread.id": "t1" } },
  };
  assert.equal(matchLiveChat(live, sessions, { kind: "codex" }).id, "t1");
});

test("the current title wins over stale resume argv after /new", () => {
  const live = {
    agent: { app: "codex", title: "⠹ New conversation | project" },
    pane: { cwd: "/tmp/project" },
    argv: ["codex", "resume", "old-thread"],
  };
  const sessions = [
    { agent: "codex", id: "old-thread", title: "Old conversation", cwd: "/tmp/project" },
    { agent: "codex", id: "new-thread", title: "New conversation", cwd: "/tmp/project" },
  ];
  assert.equal(matchLiveChat(live, sessions, { kind: "codex" }).id, "new-thread");
});

test("a foreground resume command is direct evidence for a new session", () => {
  const live = {
    agent: { app: "claude", title: "Claude" },
    pane: { cwd: "/tmp/project" },
    foregroundArgv: ["claude", "--resume", "new-session"],
  };
  const sessions = [
    { agent: "claude", id: "old-session", title: "Old", cwd: "/tmp/project" },
    { agent: "claude", id: "new-session", title: "New", cwd: "/tmp/project" },
  ];
  const result = matchLiveSession(live, sessions, { kind: "claude" });
  assert.equal(result.session.id, "new-session");
  assert.equal(result.confidence, "confirmed");
});

test("does not match sessions from another agent even with the same id", () => {
  const live = {
    agent: { app: "claude", title: "Same title" },
    pane: { cwd: "/tmp/project" },
    terminal: { labels: { "agent.kind": "claude", "agent.session.id": "same" } },
  };
  const sessions = [{ agent: "codex", id: "same", title: "Same title", cwd: "/tmp/project" }];
  const result = matchLiveSession(live, sessions, { kind: "claude" });
  assert.equal(result.session, null);
  assert.equal(result.confidence, "none");
});

test("duplicate titles in the same cwd are ambiguous rather than guessed", () => {
  const live = {
    agent: { app: "codex", title: "Same" },
    pane: { cwd: "/tmp/project" },
  };
  const sessions = [
    { agent: "codex", id: "a", title: "Same", cwd: "/tmp/project" },
    { agent: "codex", id: "b", title: "Same", cwd: "/tmp/project" },
  ];
  const result = matchLiveSession(live, sessions, { kind: "codex" });
  assert.equal(result.session, null);
  assert.equal(result.confidence, "ambiguous");
  assert.equal(result.candidates.length, 2);
});

test("same title in different folders stays independent", () => {
  const live = {
    agent: { app: "codex", title: "Same" },
    pane: { cwd: "/tmp/a" },
  };
  const sessions = [
    { agent: "codex", id: "a", title: "Same", cwd: "/tmp/a" },
    { agent: "codex", id: "b", title: "Same", cwd: "/tmp/b" },
  ];
  const result = matchLiveSession(live, sessions, { kind: "codex" });
  assert.equal(result.session.id, "a");
  assert.equal(result.confidence, "inferred");
});

test("infers a new session from terminal start time and cwd only when unique", () => {
  const live = {
    agent: { app: "codex", title: "Codex" },
    pane: { cwd: "/tmp/project" },
    terminal: { created_ms: 1_800_000_000_000 },
    argv: ["codex"],
  };
  const sessions = [
    { agent: "codex", id: "old", title: "Old", cwd: "/tmp/project", createdAt: 1_799_000_000 },
    { agent: "codex", id: "new", title: "New", cwd: "/tmp/project", createdAt: 1_800_000_040 },
    { agent: "codex", id: "helper", title: "Guardian", cwd: "/tmp/project", createdAt: 1_800_000_041, subagent: true },
  ];
  assert.equal(matchLiveChat(live, sessions, { kind: "codex" }).id, "new");

  const tie = matchLiveSession({ ...live, pane: { cwd: "/tmp/tie" } }, [
    { agent: "codex", id: "a", title: "A", cwd: "/tmp/tie", createdAt: 1_800_000_000 },
    { agent: "codex", id: "b", title: "B", cwd: "/tmp/tie", createdAt: 1_800_000_000 },
  ], { kind: "codex" });
  assert.equal(tie.confidence, "none");
});

test("does not use stale resume argv when the current title is unrecognized", () => {
  const result = matchLiveSession({
    agent: { app: "codex", title: "Current conversation" },
    pane: { cwd: "/tmp/project" },
    argv: ["codex", "resume", "old"],
  }, [{ agent: "codex", id: "old", title: "Old", cwd: "/tmp/project" }], { kind: "codex" });
  assert.equal(result.session, null);
  assert.equal(result.confidence, "none");
});

test("updates only tab titles this mod manages", () => {
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
  assert.equal(managedTabTitle({
    tabName: "我的自定义标题",
    managedName: "旧标题",
    chatTitle: "新标题",
  }), null);
});

test("matches a fallback-resumed session through the effective cwd callback", () => {
  const sessions = [{ agent: "codex", id: "x1", title: "Same", cwd: "/old/gone" }];
  const live = {
    agent: { app: "codex", title: "Same" },
    pane: { cwd: "/fallback" },
    terminal: { labels: { "agent.kind": "codex", "agent.cwd": "/fallback" } },
  };

  // 原 cwd 已失效且与 live cwd 不同：没有回调时标题候选会被过滤。
  assert.equal(matchLiveSession(live, sessions, { kind: "codex" }).confidence, "none");

  const result = matchLiveSession(live, sessions, {
    kind: "codex",
    cwdForSession: () => "/fallback",
  });
  assert.equal(result.session.id, "x1");
  assert.equal(result.confidence, "inferred");
});

test("time-based inference also uses the effective cwd", () => {
  const live = {
    agent: { app: "claude", title: "Claude" },
    pane: { cwd: "/fallback" },
    terminal: { created_ms: 1_800_000_000_000 },
  };
  const sessions = [{
    agent: "claude",
    id: "c1",
    title: "Old title",
    cwd: "/old/gone",
    createdAt: 1_800_000_040,
  }];
  assert.equal(matchLiveChat(live, sessions, { kind: "claude" }), null);
  assert.equal(matchLiveChat(live, sessions, {
    kind: "claude",
    cwdForSession: () => "/fallback",
  }).id, "c1");
});

test("labelValue supports object and core label arrays", () => {
  assert.equal(labelValue({ labels: { x: "one" } }, "x"), "one");
  assert.equal(labelValue({ labels: ["x=two"] }, "x"), "two");
  assert.equal(labelValue({ labels: ["x=two"] }, "missing"), null);
});
