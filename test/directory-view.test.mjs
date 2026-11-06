import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS,
  NO_CWD_KEY,
  normalizeAgentHistory,
} from "../mods/herdr-codex-sidebar-mod/view-model.mjs";

test("switching agents shows only that agent's directories and sessions", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: { sessions: [{ id: "c1", cwd: "/shared" }, { id: "c2", cwd: "/claude-only" }] },
      codex: { sessions: [{ id: "x1", cwd: "/shared" }] },
    },
  });
  assert.deepEqual(data.agents.claude.directories.map((group) => group.key).sort(), ["/claude-only", "/shared"]);
  assert.deepEqual(data.agents.codex.directories.map((group) => group.key), ["/shared"]);
  assert.ok(data.agents.claude.sessions.every((session) => session.agent === "claude"));
  assert.ok(data.agents.codex.sessions.every((session) => session.agent === "codex"));
});

test("an agent with zero sessions does not borrow another agent's directories", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: { sessions: [{ id: "c1", cwd: "/claude" }] },
      codex: { sessions: [] },
    },
  }, { selectedAgent: "codex" });
  assert.equal(data.selectedAgent, "codex");
  assert.equal(data.agents.codex.counts.total, 0);
  assert.deepEqual(data.agents.codex.directories, []);
});

test("directory rows count total sessions, not the current page", () => {
  const sessions = Array.from({ length: 13 }, (_, index) => ({
    id: `s-${index}`,
    cwd: "/project",
    lastActivityAt: index,
  }));
  const data = normalizeAgentHistory({ agents: { codex: { sessions } } }, { selectedAgent: "codex" });
  assert.equal(data.agents.codex.directories[0].sessions.length, 13);
  assert.equal(data.agents.codex.counts.total, 13);
  assert.equal(data.agents.codex.selectedPage, 0);
});

test("page numbers converge when the session list shrinks", () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `s-${index}`, cwd: "/p" }));
  const first = normalizeAgentHistory({ agents: { codex: { sessions: many } } }, {
    selectedAgent: "codex",
    savedDirectories: { codex: "/p" },
    savedPages: { codex: { "/p": 2 } },
  });
  assert.equal(first.agents.codex.selectedPage, 2);

  const shrunk = normalizeAgentHistory({ agents: { codex: { sessions: many.slice(0, 2) } } }, {
    selectedAgent: "codex",
    savedDirectories: { codex: "/p" },
    savedPages: { codex: { "/p": 2 } },
  });
  assert.equal(shrunk.agents.codex.selectedPage, 0);
});

test("No directory sorts last for the selected agent only", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: { sessions: [{ id: "c", cwd: "/a" }] },
      codex: {
        sessions: [
          { id: "n", cwd: null, lastActivityAt: 100 },
          { id: "x", cwd: "/a", lastActivityAt: 1 },
        ],
      },
    },
  }, { selectedAgent: "codex" });
  assert.equal(data.agents.codex.directories.at(-1).key, NO_CWD_KEY);
  assert.notEqual(data.agents.claude.directories.at(-1).key, NO_CWD_KEY);
});

test("orders active -> missing/inaccessible -> No directory", () => {
  const info = (cid, status, exists, accessible) => ({ key: cid, cwd: cid, exists, accessible, status });
  const data = normalizeAgentHistory({
    agents: {
      codex: {
        sessions: [
          {
            id: "active",
            cwd: "/active",
            lastActivityAt: 1,
            cwdInfo: info("/active", "ok", true, true),
          },
          {
            id: "missing",
            cwd: "/missing",
            lastActivityAt: 99,
            cwdInfo: info("/missing", "missing-directory", false, false),
          },
          {
            id: "private",
            cwd: "/private",
            lastActivityAt: 98,
            cwdInfo: info("/private", "inaccessible", true, false),
          },
          { id: "none", cwd: null, lastActivityAt: 100 },
        ],
      },
    },
  }, { selectedAgent: "codex" });

  assert.deepEqual(data.agents.codex.directories.map((group) => group.key), [
    "/active",
    "/missing",
    "/private",
    NO_CWD_KEY,
  ]);
  const missing = data.agents.codex.directories.find((group) => group.key === "/missing");
  const inaccessible = data.agents.codex.directories.find((group) => group.key === "/private");
  assert.equal(missing.missing, true);
  assert.equal(inaccessible.inaccessible, true);
});

test("missing directories are not merged into No directory", () => {
  const data = normalizeAgentHistory({
    agents: {
      codex: {
        sessions: [
          {
            id: "missing",
            cwd: "/missing",
            cwdInfo: { key: "/missing", cwd: "/missing", exists: false, accessible: false, status: "missing-directory" },
          },
          { id: "none", cwd: null },
        ],
      },
    },
  }, { selectedAgent: "codex" });
  const keys = data.agents.codex.directories.map((group) => group.key);
  assert.ok(keys.includes("/missing"));
  assert.notEqual(data.agents.codex.directories.find((group) => group.key === "/missing").displayName, "No directory");
});

test("unavailable agent stays selected in the menu but cannot be shown as mixed data", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: { sessions: [] },
      codex: { available: false, reason: "Codex data directory not found", sessions: [] },
    },
  }, { selectedAgent: "codex" });
  assert.equal(data.selectedAgent, "claude");
  assert.equal(data.agents.codex.available, false);
  assert.match(data.agents.codex.unavailableReason, /not found/);
  assert.equal(data.agents.codex.counts.total, 0);
  assert.equal(data.agents.claude.counts.total, 0);
});

test("same title across agents is never merged or deduped together", () => {
  const data = normalizeAgentHistory({
    agents: {
      claude: { sessions: [{ id: "same", cwd: "/a", title: "Same" }] },
      codex: { sessions: [{ id: "same", cwd: "/a", title: "Same" }] },
    },
  });
  for (const agent of ["claude", "codex"]) {
    assert.equal(data.agents[agent].sessions.length, 1);
    assert.equal(data.agents[agent].sessions[0].key, `${agent}:same`);
  }
});

test("each agent view reports independent availability and stale warnings", () => {
  const data = normalizeAgentHistory({
    agents: Object.fromEntries(AGENTS.map((agent) => [agent, {
      sessions: [{ id: `${agent}-1`, cwd: `/tmp/${agent}` }],
      stale: agent === "claude",
      warnings: agent === "claude" ? ["Claude sync failed"] : [],
      available: agent !== "codex",
      reason: agent === "codex" ? "Codex data directory not found" : null,
    }])),
  });
  assert.equal(data.agents.claude.sync.status, "stale");
  assert.equal(data.agents.codex.available, false);
  assert.deepEqual(data.staleAgents, ["claude"]);
});
