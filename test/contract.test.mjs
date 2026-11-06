import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS,
  NO_CWD_KEY,
  normalizeAgentHistory,
} from "../mods/herdr-codex-sidebar-mod/view-model.mjs";

const raw = {
  schemaVersion: 2,
  syncedAt: 1_800_000_000,
  agents: {
    claude: {
      available: true,
      warnings: [],
      sessions: [
        { id: "c1", cwd: "/tmp/project", title: "Claude", createdAt: 10, updatedAt: 20 },
        { id: "c2", cwd: null, title: "No cwd", createdAt: 11, updatedAt: 21 },
      ],
    },
    codex: {
      available: true,
      sessions: [{ id: "x1", cwd: "/tmp/project", title: "Codex" }],
    },
  },
  warnings: ["top warning"],
};

test("AgentView and DirectoryGroup expose the v0.2 contract", () => {
  const data = normalizeAgentHistory(raw, { selectedAgent: "claude" });
  assert.equal(data.schemaVersion, 2);
  assert.deepEqual(Object.keys(data.agents).sort(), [...AGENTS].sort());

  for (const agent of AGENTS) {
    const view = data.agents[agent];
    assert.equal(view.agent, agent);
    assert.equal(typeof view.available, "boolean");
    assert.equal(typeof view.sync.status, "string");
    assert.equal(typeof view.sync.stale, "boolean");
    assert.ok(Array.isArray(view.sync.warnings));
    assert.ok(Array.isArray(view.directories));
    assert.equal(typeof view.selectedPage, "number");
    assert.equal(typeof view.counts.total, "number");

    for (const directory of view.directories) {
      assert.equal(directory.agent, agent);
      assert.equal(typeof directory.key, "string");
      assert.equal(typeof directory.displayName, "string");
      assert.equal(typeof directory.exists, "boolean");
      assert.equal(typeof directory.accessible, "boolean");
      assert.equal(typeof directory.lastActivityAt, "number");
      assert.ok(Array.isArray(directory.sessions));
      assert.ok(directory.sessions.every((session) => session.agent === agent));
    }
  }
});

test("Session exposes a stable key and capability flags", () => {
  const data = normalizeAgentHistory(raw, { selectedAgent: "claude" });
  const sessions = AGENTS.flatMap((agent) => data.agents[agent].sessions);
  const keys = new Set();
  for (const session of sessions) {
    assert.equal(session.key, `${session.agent}:${session.id}`);
    assert.ok(!keys.has(session.key), `duplicate key ${session.key}`);
    keys.add(session.key);
    assert.equal(typeof session.title, "string");
    assert.equal(typeof session.preview, "string");
    assert.equal(typeof session.createdAt, "number");
    assert.equal(typeof session.updatedAt, "number");
    assert.equal(typeof session.lastActivityAt, "number");
    assert.equal(typeof session.archived, "boolean");
    assert.equal(typeof session.hidden, "boolean");
    assert.equal(typeof session.subagent, "boolean");
    assert.equal(typeof session.capabilities.preview, "boolean");
    assert.equal(typeof session.capabilities.resume, "boolean");
    assert.equal(typeof session.capabilities.resumeInPlace, "boolean");
  }

  const noCwd = sessions.find((session) => session.id === "c2");
  assert.equal(noCwd.cwdKey, NO_CWD_KEY);
  assert.equal(noCwd.cwd, null);
  // 会话数据仍可恢复（通过 fallback），只是不能原地恢复。
  assert.equal(noCwd.capabilities.resume, true);
  assert.equal(noCwd.capabilities.resumeInPlace, false);

  const withCwd = sessions.find((session) => session.id === "c1");
  assert.equal(withCwd.cwdKey, "/tmp/project");
  assert.equal(withCwd.capabilities.resume, true);
  assert.equal(withCwd.capabilities.resumeInPlace, true);
});

test("there is no global opened/working summary in the unified model", () => {
  const data = normalizeAgentHistory(raw);
  assert.equal(data.opened, undefined);
  assert.equal(data.working, undefined);
  assert.equal(data.counts, undefined);
  assert.equal(data.unassigned, undefined);
  assert.equal(data.projects, undefined);
});

test("agent partitions never contain sessions from another agent", () => {
  const data = normalizeAgentHistory(raw);
  for (const agent of AGENTS) {
    for (const directory of data.agents[agent].directories) {
      for (const session of directory.sessions) assert.equal(session.agent, agent);
    }
  }
});
