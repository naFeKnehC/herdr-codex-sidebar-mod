import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  hermesRowsToSessions,
  readHermesPreview,
  readHermesSessions,
} from "../mods/herdr-codex-sidebar-mod/helper/lib/adapters/hermes.mjs";

async function fixture({ sessions = [], messages = [], extraTables = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hermes-adapter-"));
  const hermesHome = join(root, ".hermes");
  await mkdir(hermesHome, { recursive: true });
  const db = new DatabaseSync(join(hermesHome, "state.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      hidden INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      parent_session_id TEXT,
      started_at INTEGER,
      last_activity_at INTEGER,
      ended_at INTEGER,
      lineage_id TEXT
    );
    CREATE TABLE messages (
      id TEXT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      timestamp INTEGER
    );
  `);
  if (extraTables) db.exec("CREATE TABLE projects (id TEXT, name TEXT, folder TEXT)");
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, cwd, title, hidden, archived, parent_session_id, started_at, last_activity_at, ended_at, lineage_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const session of sessions) {
    insertSession.run(
      session.id,
      session.cwd ?? null,
      session.title ?? null,
      session.hidden ?? 0,
      session.archived ?? 0,
      session.parent_session_id ?? null,
      session.started_at ?? null,
      session.last_activity_at ?? null,
      session.ended_at ?? null,
      session.lineage_id ?? null,
    );
  }
  const insertMessage = db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
  for (const message of messages) {
    insertMessage.run(message.id, message.session_id, message.role, message.content, message.timestamp ?? null);
  }
  db.close();
  return { root, hermesHome };
}

test("discovers sessions with id, cwd and title", async () => {
  const { hermesHome } = await fixture({
    sessions: [
      { id: "h1", cwd: "/tmp/project", title: "Named", started_at: 100, last_activity_at: 200 },
      { id: "h2", cwd: "/tmp/other", title: null, started_at: 150, last_activity_at: null },
    ],
    messages: [
      { id: "m1", session_id: "h2", role: "user", content: "First user message", timestamp: 160 },
    ],
  });
  const result = await readHermesSessions({ hermesHome });
  assert.equal(result.available, true);
  assert.deepEqual(result.sessions.map((session) => session.id).sort(), ["h1", "h2"]);
  const h2 = result.sessions.find((session) => session.id === "h2");
  assert.equal(h2.title, "First user message");
  assert.equal(h2.lastActivityAt, 150);
});

test("filters hidden, archived and child sessions by default", async () => {
  const { hermesHome } = await fixture({
    sessions: [
      { id: "keep", cwd: "/tmp/a", title: "Keep" },
      { id: "hidden", cwd: "/tmp/a", title: "Hidden", hidden: 1 },
      { id: "archived", cwd: "/tmp/a", title: "Archived", archived: 1 },
      { id: "child", cwd: "/tmp/a", title: "Child", parent_session_id: "keep" },
    ],
  });
  const result = await readHermesSessions({ hermesHome });
  assert.deepEqual(result.sessions.map((session) => session.id), ["keep"]);
});

test("cwd may be null and must not be inferred from projects.db", async () => {
  const { hermesHome } = await fixture({
    extraTables: true,
    sessions: [{ id: "onboarding", cwd: null, title: "Onboarding" }],
  });
  const result = await readHermesSessions({ hermesHome });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].cwd, null);
});

test("titles fall back to first user message then Untitled chat", async () => {
  const { hermesHome } = await fixture({
    sessions: [
      { id: "a", cwd: "/tmp/a", title: "" },
      { id: "b", cwd: "/tmp/b", title: "" },
    ],
    messages: [
      { id: "m1", session_id: "a", role: "user", content: "Question", timestamp: 10 },
      { id: "m2", session_id: "b", role: "assistant", content: "Answer", timestamp: 11 },
    ],
  });
  const result = await readHermesSessions({ hermesHome });
  assert.equal(result.sessions.find((session) => session.id === "a").title, "Question");
  assert.equal(result.sessions.find((session) => session.id === "b").title, "Untitled chat");
});

test("does not infer running state from an empty ended_at", async () => {
  const { hermesHome } = await fixture({
    sessions: [{ id: "h1", cwd: "/tmp/a", title: "History", started_at: 10, last_activity_at: 20, ended_at: null }],
  });
  const result = await readHermesSessions({ hermesHome });
  assert.equal(result.sessions[0].live, undefined);
});

test("uses runtime/active_sessions.json only as a hint", async () => {
  const { hermesHome } = await fixture({
    sessions: [{ id: "h1", cwd: "/tmp/a", title: "History" }],
  });
  await mkdir(join(hermesHome, "runtime"), { recursive: true });
  await writeFile(join(hermesHome, "runtime", "active_sessions.json"), JSON.stringify([{ session_id: "h1" }]));
  const result = await readHermesSessions({ hermesHome });
  assert.equal(result.sessions[0].activeHint, true);
  assert.equal(result.sessions[0].live, undefined);
});

test("projects compressed lineage into one logical session using the latest tip", async () => {
  const { hermesHome } = await fixture({
    sessions: [
      { id: "old", cwd: "/tmp/a", title: "Old tip", lineage_id: "line", started_at: 10, last_activity_at: 20 },
      { id: "new", cwd: "/tmp/a", title: "New tip", lineage_id: "line", started_at: 30, last_activity_at: 40 },
    ],
    messages: [
      { id: "m1", session_id: "new", role: "user", content: "From new", timestamp: 41 },
    ],
  });
  const result = await readHermesSessions({ hermesHome });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, "new");
  assert.equal(result.sessions[0].title, "New tip");
  assert.deepEqual(result.sessions[0].lineageIds.sort(), ["new", "old"]);
});

test("keeps lineage members that carry a parent id inside one logical session", async () => {
  const { hermesHome } = await fixture({
    sessions: [
      {
        id: "old", cwd: "/tmp/a", title: "Old tip", lineage_id: "line",
        parent_session_id: "root", started_at: 10, last_activity_at: 20,
      },
      {
        id: "new", cwd: "/tmp/a", title: "New tip", lineage_id: "line",
        parent_session_id: "old", started_at: 30, last_activity_at: 40,
      },
    ],
    messages: [
      { id: "m1", session_id: "old", role: "user", content: "Old question", timestamp: 21 },
      { id: "m2", session_id: "new", role: "user", content: "New question", timestamp: 41 },
    ],
  });
  const result = await readHermesSessions({ hermesHome });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, "new");
  assert.deepEqual(result.sessions[0].lineageIds.sort(), ["new", "old"]);

  const preview = await readHermesPreview({ hermesHome, sessionId: "new" });
  assert.deepEqual(preview.messages.map((message) => message.text), ["Old question", "New question"]);
});

test("hides an archived lineage tip even when older members remain", async () => {
  const { hermesHome } = await fixture({
    sessions: [
      { id: "old", cwd: "/tmp/a", lineage_id: "line", started_at: 10, last_activity_at: 20 },
      { id: "new", cwd: "/tmp/a", lineage_id: "line", archived: 1, started_at: 30, last_activity_at: 40 },
    ],
  });
  const result = await readHermesSessions({ hermesHome });
  assert.deepEqual(result.sessions, []);
});

test("renders only user/assistant preview and folds tool payloads", async () => {
  const { hermesHome } = await fixture({
    sessions: [{ id: "h1", cwd: "/tmp/a", title: "Chat" }],
    messages: [
      { id: "m1", session_id: "h1", role: "user", content: "Question", timestamp: 1 },
      { id: "m2", session_id: "h1", role: "tool", content: "{\"huge\":true}", timestamp: 2 },
      { id: "m3", session_id: "h1", role: "assistant", content: "[{\"type\":\"tool_use\"},{\"type\":\"text\",\"text\":\"Answer\"}]", timestamp: 3 },
    ],
  });
  const preview = await readHermesPreview({ hermesHome, sessionId: "h1" });
  assert.deepEqual(preview.messages.map((message) => message.text), ["Question", "[tool]\nAnswer"]);
});

test("does not write to state.db during read-only sync", async () => {
  const { hermesHome } = await fixture({
    sessions: [{ id: "h1", cwd: "/tmp/a", title: "Chat" }],
  });
  const path = join(hermesHome, "state.db");
  const before = await stat(path);
  await readHermesSessions({ hermesHome });
  const after = await stat(path);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("reports a missing database as unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-missing-"));
  const result = await readHermesSessions({ hermesHome: join(root, "missing") });
  assert.equal(result.available, false);
  assert.match(result.reason, /not found/);
});

test("hermesRowsToSessions tolerates missing timestamps without NaN", () => {
  const [session] = hermesRowsToSessions([{ id: "h1", cwd: null, title: null }]);
  assert.equal(session.createdAt, 0);
  assert.equal(session.updatedAt, 0);
  assert.equal(session.lastActivityAt, 0);
  assert.equal(Number.isNaN(session.lastActivityAt), false);
});
