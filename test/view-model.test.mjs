import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS,
  NO_CWD_KEY,
  applySessionCwdOverrides,
  badgeColor,
  computeFallbackDefault,
  displayNameForFallback,
  liveLabel,
  normalizeAgentHistory,
  normalizeFallbackValue,
  paginate,
  resolveAgentSelection,
  resolveDirectorySelection,
  resolveFallback,
  spaceNameForCwd,
  stableElementId,
  tabTitleForSession,
  translucentColor,
} from "../mods/herdr-codex-sidebar-mod/view-model.mjs";

const sessions = (agent, cwd, count = 1, base = 100) => Array.from({ length: count }, (_, index) => ({
  id: `${agent}-${index}`,
  cwd,
  title: `${agent} ${index}`,
  lastActivityAt: base + index,
}));

function viewsFor(availability) {
  return Object.fromEntries(AGENTS.map((agent) => [
    agent,
    { agent, available: availability[agent] !== false, directories: [], counts: { total: 0 } },
  ]));
}

test("keeps three agents in separate views even when they share one cwd", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: { sessions: sessions("claude", "/tmp/shared") },
      codex: { sessions: sessions("codex", "/tmp/shared") },
      hermes: { sessions: sessions("hermes", "/tmp/shared") },
    },
  });
  for (const agent of AGENTS) {
    assert.equal(data.agents[agent].directories.length, 1);
    assert.equal(data.agents[agent].directories[0].key, "/tmp/shared");
    assert.equal(data.agents[agent].counts.total, 1);
    assert.equal(data.agents[agent].directories[0].sessions[0].agent, agent);
  }
  assert.equal(data.counts, undefined, "no global summary counts");
  assert.equal(data.selectedAgent, "claude");
});

test("restores the saved agent and falls back Claude -> Codex -> Hermes", () => {
  const all = viewsFor({});
  assert.deepEqual(resolveAgentSelection(all, "codex"), { agent: "codex", changed: false });
  assert.deepEqual(resolveAgentSelection(viewsFor({ claude: false }), "claude"), { agent: "codex", changed: true });
  assert.deepEqual(resolveAgentSelection(viewsFor({ claude: false, codex: false }), null), { agent: "hermes", changed: true });
  assert.deepEqual(resolveAgentSelection(viewsFor({ claude: false, codex: false, hermes: false }), "codex"), { agent: "codex", changed: false });
});

test("directory selection falls back only when a real directory list exists", () => {
  const view = {
    directories: [{ key: "/a" }, { key: "/b" }],
  };
  assert.deepEqual(resolveDirectorySelection(view, "/b"), { key: "/b", changed: false, empty: false, fallback: false });
  assert.deepEqual(resolveDirectorySelection(view, "/gone"), { key: "/a", changed: true, empty: false, fallback: true });
  assert.deepEqual(resolveDirectorySelection({ directories: [] }, "/gone"), { key: "/gone", changed: false, empty: true, fallback: false });
});

test("each agent keeps independent directory and page selection", () => {
  const claudeSessions = sessions("claude", "/claude/a", 13, 200);
  const codexSessions = sessions("codex", "/codex/b", 2, 100);
  const data = normalizeAgentHistory({
    agents: {
      claude: { sessions: claudeSessions },
      codex: { sessions: codexSessions },
    },
  }, {
    savedDirectories: { claude: "/claude/a", codex: "/codex/b" },
    savedPages: { claude: { "/claude/a": 1 }, codex: { "/codex/b": 0 } },
  });
  assert.equal(data.selectedAgent, "claude");
  assert.equal(data.agents.claude.selectedDirectoryKey, "/claude/a");
  assert.equal(data.agents.claude.selectedPage, 1);
  assert.equal(data.agents.codex.selectedDirectoryKey, "/codex/b");
  assert.equal(data.agents.codex.selectedPage, 0);
});

test("an empty sync does not forget the saved directory", () => {
  const data = normalizeAgentHistory({
    agents: { claude: { sessions: [] }, codex: { sessions: [] }, hermes: { sessions: [] } },
  }, {
    selectedAgent: "claude",
    savedDirectories: { claude: "/saved/dir" },
  });
  assert.equal(data.agents.claude.selectedDirectoryKey, "/saved/dir");
  assert.equal(data.directorySelections.claude.empty, true);
});

test("selecting No directory keeps it as a normal directory selection", () => {
  const data = normalizeAgentHistory({
    agents: { codex: { sessions: [{ id: "none", cwd: null }] } },
  }, {
    selectedAgent: "codex",
    savedDirectories: { codex: NO_CWD_KEY },
  });
  assert.equal(data.agents.codex.selectedDirectoryKey, NO_CWD_KEY);
  assert.equal(data.agents.codex.directories[0].displayName, "No directory");
});

test("stale sync state is exposed per agent without dropping its sessions", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: { sessions: [{ id: "old", cwd: "/a" }], stale: true, warnings: ["Claude sync failed"] },
      codex: { sessions: [{ id: "new", cwd: "/b" }] },
      hermes: { available: false, reason: "Hermes state.db not found", sessions: [] },
    },
  });
  assert.equal(data.agents.claude.counts.total, 1);
  assert.equal(data.agents.claude.sync.stale, true);
  assert.equal(data.agents.codex.sync.stale, false);
  assert.equal(data.agents.hermes.available, false);
  assert.deepEqual(data.staleAgents, ["claude"]);
  assert.ok(data.warnings.includes("Claude sync failed"));
});

test("maps open, blocked, done, idle, unknown and multi-instance states independently", () => {
  assert.deepEqual(liveLabel({ terminal: { state: "live" }, status: "working" }), { text: "Working", color: "working" });
  assert.deepEqual(liveLabel({ terminal: { state: "live" }, status: "blocked" }), { text: "Needs you", color: "blocked" });
  assert.deepEqual(liveLabel({ terminal: { state: "live" }, status: "done" }), { text: "Done", color: "done" });
  assert.deepEqual(liveLabel({ terminal: { state: "live" }, status: "idle" }), { text: "Idle", color: "idle" });
  assert.deepEqual(liveLabel({ terminal: { state: "live" } }), { text: "Open · unknown", color: "accent" });
  assert.deepEqual(liveLabel({ terminal: { state: "finished" } }), { text: "Exited · resumable", color: "dim" });
  assert.deepEqual(liveLabel({ status: "working", source: "claude-static" }), { text: "Working", color: "working" });
  assert.deepEqual(liveLabel({ ambiguous: true, status: "working" }), { text: "Confirm", color: "blocked" });
  assert.equal(liveLabel(null), null);
});

test("falls back to known colors for live status badges", () => {
  const theme = { working: "#e5c07b", accent: "#3b82f6" };
  assert.equal(badgeColor(theme, "working"), "#e5c07b");
  assert.equal(badgeColor(theme, "missing"), "#3b82f6");
  assert.equal(translucentColor("#e5c07b"), "#e5c07b18");
  assert.equal(translucentColor("rgba(1, 2, 3, 1)"), "transparent");
});

test("normalizes malformed cached history before rendering", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: {
        sessions: [
          { id: "ok", cwd: "/tmp/a", title: null },
          null,
          { cwd: "/tmp/a" },
        ],
      },
    },
    warnings: [null, " Sync failed "],
  });
  assert.equal(data.agents.claude.sessions.length, 1);
  assert.equal(data.agents.claude.sessions[0].title, "Untitled chat");
  assert.deepEqual(data.warnings, ["Sync failed"]);
});

test("generates stable row ids for Unicode keys and separates prefixes", () => {
  assert.equal(stableElementId("session", "会话🎛"), stableElementId("session", "会话🎛"));
  assert.notEqual(stableElementId("session", "a"), stableElementId("session", "b"));
  assert.notEqual(stableElementId("session", "a"), stableElementId("dir", "a"));
});

test("new space and tab names follow the documented rules", () => {
  assert.equal(spaceNameForCwd("/", "Claude"), "root");
  assert.equal(spaceNameForCwd("/tmp/app", "Claude"), "app");
  assert.equal(spaceNameForCwd(null, "Claude"), "Claude");
  assert.equal(tabTitleForSession({ agent: "claude", title: "Chat" }), "Chat");
  assert.equal(tabTitleForSession({ agent: "codex", title: "Untitled chat" }), "Codex Untitled");
  assert.equal(tabTitleForSession({ agent: "hermes", title: "" }), "Hermes Untitled");
});

const cwdInfo = (cwd, status = "ok", { exists = status !== "missing-directory", accessible = status === "ok" } = {}) => ({
  key: cwd,
  cwd,
  exists,
  accessible,
  status,
});

const sessionAt = (id, cwd, lastActivityAt = 1, status = "ok") => ({
  id,
  cwd,
  lastActivityAt,
  cwdInfo: cwd ? cwdInfo(cwd, status) : undefined,
});

test("computes a fallback from the longest common parent of existing directories", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: {
        sessions: [
          sessionAt("app", "/Users/me/project/app"),
          sessionAt("api", "/Users/me/project/api"),
          sessionAt("docs", "/Users/me/project/docs"),
        ],
      },
    },
  });
  const info = computeFallbackDefault(data.agents, { home: "/Users/me" });
  assert.equal(info.cwd, "/Users/me/project");
  assert.equal(info.source, "common-parent");
  assert.equal(info.valid, true);
  assert.deepEqual([...info.candidates].sort(), [
    "/Users/me/project/api",
    "/Users/me/project/app",
    "/Users/me/project/docs",
  ]);
});

test("falls back to the most frequent directory when a common parent is the root", () => {
  const info = computeFallbackDefault({
    codex: {
      sessions: [
        sessionAt("a1", "/tmp/a", 1),
        sessionAt("a2", "/tmp/a", 5),
        sessionAt("b1", "/opt/b", 10),
        sessionAt("b2", "/opt/b", 2),
      ],
    },
  });
  assert.equal(info.source, "most-frequent");
  assert.equal(info.valid, true);
  // 次数优先，同为 2 次时最近活动更晚的 /opt/b 胜出。
  assert.equal(info.cwd, "/opt/b");
});

test("suggests a missing directory but marks it invalid", () => {
  const info = computeFallbackDefault({
    hermes: {
      sessions: [
        sessionAt("gone", "/old/gone", 2, "missing-directory"),
        sessionAt("gone2", "/old/gone", 1, "missing-directory"),
        sessionAt("other", "/old/other", 3, "missing-directory"),
      ],
    },
  });
  assert.equal(info.cwd, "/old/gone");
  assert.equal(info.source, "suggested-missing");
  assert.equal(info.valid, false);
  assert.deepEqual(info.candidates, ["/old/gone", "/old/other"]);
  assert.deepEqual(computeFallbackDefault({ claude: { sessions: [] } }), {
    cwd: null,
    source: null,
    valid: false,
    candidates: [],
  });
});

test("expands ~ in fallback values with the provided home", () => {
  assert.deepEqual(normalizeFallbackValue("~/project", { home: "/Users/me" }), {
    ok: true,
    cwd: "/Users/me/project",
    reason: null,
  });
  assert.equal(normalizeFallbackValue("~", { home: "/Users/me" }).cwd, "/Users/me");

  const resolved = resolveFallback(
    { fallbackDirectory: "~/project" },
    "codex",
    null,
    { home: "/Users/me", exists: (path) => path === "/Users/me/project" },
  );
  assert.equal(resolved.cwd, "/Users/me/project");
  assert.equal(resolved.source, "user");
  assert.equal(resolved.valid, true);

  const missing = resolveFallback(
    { fallbackDirectory: "~/gone" },
    "codex",
    null,
    { home: "/Users/me", exists: () => false },
  );
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.candidates, ["/Users/me/gone"]);
});

test("resolves fallback priority user > agent > default and skips invalid values", () => {
  const settings = {
    fallbackDirectory: "/user",
    agents: { codex: { fallbackDirectory: "/agent" } },
  };
  const defaultInfo = { cwd: "/default", valid: true };
  const allExist = () => true;

  assert.deepEqual(
    resolveFallback(settings, "codex", defaultInfo, { exists: allExist }),
    { cwd: "/user", source: "user", valid: true, needsUserInput: false, warnings: [] },
  );

  const agentOnly = resolveFallback({
    fallbackDirectory: "/missing-user",
    agents: { codex: { fallbackDirectory: "/agent" } },
  }, "codex", defaultInfo, { exists: (path) => path === "/agent" });
  assert.equal(agentOnly.cwd, "/agent");
  assert.equal(agentOnly.source, "agent");
  assert.match(agentOnly.warnings[0], /user fallback does not exist/);

  const byDefault = resolveFallback({}, "claude", defaultInfo, { exists: allExist });
  assert.equal(byDefault.cwd, "/default");
  assert.equal(byDefault.source, "default");

  const none = resolveFallback({
    fallbackDirectory: "relative/path",
    agents: { claude: { fallbackDirectory: "/gone" } },
  }, "claude", { cwd: "/also-gone", valid: false }, { exists: () => false });
  assert.equal(none.valid, false);
  assert.equal(none.needsUserInput, true);
  assert.equal(none.cwd, null);
  assert.deepEqual(none.candidates, ["/also-gone", "/gone"]);
  assert.ok(none.warnings.some((warning) => /invalid/.test(warning)));
  assert.ok(none.warnings.some((warning) => /does not exist/.test(warning)));
});

test("explicit directory overrides regroup sessions without touching originals", () => {
  const data = normalizeAgentHistory({
    agents: {
      codex: {
        sessions: [
          { id: "s", cwd: "/old/gone", lastActivityAt: 2 },
          { id: "keep", cwd: "/keep", lastActivityAt: 1 },
        ],
      },
    },
  });
  const view = data.agents.codex;
  const moved = applySessionCwdOverrides(view, { "codex:s": { cwd: "/new/home", updatedAt: 9 } });
  assert.deepEqual(moved.directories.map((group) => group.key), ["/new/home", "/keep"]);
  const session = moved.sessions.find((item) => item.id === "s");
  assert.equal(session.cwd, "/new/home");
  assert.equal(session.originalCwd, "/old/gone");
  assert.equal(session.capabilities.resumeInPlace, true);
  assert.equal(session.unavailableReason, null);

  // 失效 / 相对路径 override 被忽略，视图保持原样。
  const relative = applySessionCwdOverrides(view, { "codex:s": { cwd: "relative" } });
  assert.equal(relative, view);
});

test("displayNameForFallback returns a short badge name", () => {
  assert.equal(displayNameForFallback("/Users/me/project"), "project");
  assert.equal(displayNameForFallback(null), "No directory");
});

test("paginates long lists and clamps out-of-range pages", () => {
  const items = Array.from({ length: 25 }, (_, index) => index + 1);
  const first = paginate(items, 0, 12);
  assert.deepEqual(first.items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(first.pageCount, 3);
  assert.deepEqual(paginate(items, 1, 12).items, [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.deepEqual(paginate(items, 2, 12).items, [25]);
  assert.equal(paginate(items, 99, 12).page, 2);
  assert.equal(paginate(items, -5, 12).page, 0);
  assert.deepEqual(paginate([], 7, 12), { page: 0, pageCount: 1, start: 0, end: 0, total: 0, items: [] });
});
