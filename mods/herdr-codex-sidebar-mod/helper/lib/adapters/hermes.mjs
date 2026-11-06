import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asTimestamp, clean, contentToText, firstLine, truncate } from "./common.mjs";

export function defaultHermesHome({ home = homedir(), env = process.env } = {}) {
  return env.HERMES_HOME || join(home, ".hermes");
}

export function hermesDatabasePath(hermesHome) {
  return join(hermesHome, "state.db");
}

const truthy = (value) => value === true || value === 1 || value === "1" || value === "true";

function columnsOf(db, table) {
  try {
    return db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name));
  } catch {
    return [];
  }
}

function pick(columns, names) {
  return names.filter((name) => columns.includes(name));
}

function readRows(db, table, wanted) {
  const columns = columnsOf(db, table);
  if (!columns.length) return { columns, rows: [] };
  const selected = pick(columns, wanted);
  if (!selected.length) return { columns, rows: [] };
  const sql = `SELECT ${selected.map((name) => `"${name}"`).join(", ")} FROM "${table}"`;
  return { columns, rows: db.prepare(sql).all() };
}

function parseContent(value) {
  if (typeof value !== "string") return contentToText(value);
  const text = value.trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    try { return contentToText(JSON.parse(text)); } catch {}
  }
  return clean(value);
}

function messageRole(row) {
  const role = String(row?.role ?? row?.type ?? "").toLowerCase();
  if (role === "user" || role === "assistant") return role;
  if (role === "tool" || role === "tool_result") return "tool";
  return null;
}

function messageText(row) {
  const raw = row?.content ?? row?.text ?? row?.message ?? row?.body;
  const text = parseContent(raw);
  if (!text) return "";
  return text;
}

function logicalSessions(rows) {
  const usable = rows.filter((row) => Boolean(sessionIdOf(row)));
  const hasLineage = usable.some((row) => clean(row.lineage_id ?? row.root_session_id));
  if (!hasLineage) {
    return usable.map((row) => ({ tip: row, members: [row] }));
  }
  const groups = new Map();
  for (const row of usable) {
    const key = clean(row.lineage_id ?? row.root_session_id) || `id:${row.session_id ?? row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((members) => {
    const sorted = [...members].sort((left, right) => {
      const leftAt = asTimestamp(left.last_activity_at ?? left.updated_at ?? left.started_at);
      const rightAt = asTimestamp(right.last_activity_at ?? right.updated_at ?? right.started_at);
      return rightAt - leftAt;
    });
    return { tip: sorted[0], members: sorted };
  });
}

// 先按 lineage 投影成逻辑会话，再判断可见性。压缩链里的旧成员即使带
// `parent_session_id`（指向链上的前驱）也属于同一条逻辑会话，不能当作
// 独立子会话丢掉；只有单成员且 parent 非空才是真正的子会话。
function visibleLogicalSessions(rows) {
  return logicalSessions(rows).filter(({ tip, members }) => {
    if (truthy(tip.hidden) || truthy(tip.archived)) return false;
    const parent = clean(tip.parent_session_id ?? tip.parentSessionId);
    if (parent && members.length === 1) return false;
    return true;
  });
}

function sessionIdOf(row) {
  return clean(row?.id ?? row?.session_id);
}

export function applyHermesMessages(logical, messages) {
  const bySession = new Map();
  for (const message of messages) {
    const id = String(message.sessionId);
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(message);
  }
  for (const { tip, members } of logical) {
    const ids = new Set(members.map(sessionIdOf).filter(Boolean));
    const list = members.flatMap((member) => bySession.get(String(sessionIdOf(member))) || []);
    list.sort((left, right) => (asTimestamp(left.at) - asTimestamp(right.at))
      || String(left.messageId).localeCompare(String(right.messageId)));
    const textMessages = list
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, text: message.text, at: message.at }));
    const firstUser = textMessages.find((message) => message.role === "user")?.text || "";
    const existingTitle = clean(tip.title);
    tip.title = existingTitle || truncate(firstUser, 120) || "Untitled chat";
    tip.preview = truncate(firstUser || firstLine(textMessages.find((message) => message.role === "assistant")?.text), 240);
    tip.messages = textMessages;
    tip.lineageIds = [...ids];
  }
  return logical;
}

export async function readHermesActiveSessions({ hermesHome = defaultHermesHome() } = {}) {
  const path = join(hermesHome, "runtime", "active_sessions.json");
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const entries = Array.isArray(value) ? value : Object.values(value ?? {});
    return {
      entries: entries.filter((entry) => entry && typeof entry === "object"),
      warnings: [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { entries: [], warnings: [] };
    return { entries: [], warnings: [`Could not read Hermes active sessions: ${error.message || error}`] };
  }
}

export function hermesRowsToSessions(rows, { messages = [], dbPath = null } = {}) {
  const logical = applyHermesMessages(visibleLogicalSessions(rows), messages);
  return logical.map(({ tip, members }) => {
    const id = sessionIdOf(tip);
    const createdAt = asTimestamp(tip.started_at ?? tip.created_at ?? tip.startedAt);
    const updatedAt = asTimestamp(tip.last_activity_at ?? tip.updated_at ?? tip.ended_at ?? tip.started_at);
    return {
      agent: "hermes",
      id,
      title: clean(tip.title) || "Untitled chat",
      preview: clean(tip.preview),
      cwd: typeof tip.cwd === "string" && tip.cwd.trim() ? tip.cwd.trim() : null,
      createdAt,
      updatedAt: updatedAt || createdAt,
      lastActivityAt: updatedAt || createdAt,
      archived: false,
      hidden: false,
      subagent: false,
      parentId: null,
      path: dbPath,
      lineageIds: members.map(sessionIdOf).filter(Boolean),
      capabilities: { preview: true, resume: true },
    };
  });
}

export function readHermesMessages(db, columns) {
  const sessionColumn = columns.includes("session_id") ? "session_id" : columns.includes("sessionId") ? "sessionId" : null;
  if (!sessionColumn) return [];
  const selected = pick(columns, ["id", "message_id", sessionColumn, "role", "type", "content", "text", "message", "body", "timestamp", "created_at"]);
  if (!selected.length) return [];
  const order = pick(columns, ["timestamp", "created_at", "id"]);
  const sql = `SELECT ${selected.map((name) => `"${name}"`).join(", ")} FROM "messages"`
    + (order.length ? ` ORDER BY ${order.map((name) => `"${name}"`).join(", ")}` : "");
  let rows;
  try { rows = db.prepare(sql).all(); }
  catch { return []; }
  return rows.map((row) => ({
    sessionId: clean(row[sessionColumn]),
    messageId: clean(row.id ?? row.message_id),
    role: messageRole(row),
    text: messageText(row),
    at: row.timestamp ?? row.created_at ?? null,
  })).filter((message) => message.sessionId && message.role && message.text && message.role !== "tool");
}

export async function readHermesSessions({
  hermesHome = defaultHermesHome(),
  exists = existsSync,
  openDatabase = (path) => new DatabaseSync(path, { readOnly: true }),
  readMessages = readFile,
} = {}) {
  const dbPath = hermesDatabasePath(hermesHome);
  if (!exists(dbPath)) {
    return {
      available: false,
      reason: "Hermes state.db not found",
      sessions: [],
      warnings: [],
    };
  }

  let db;
  try {
    db = openDatabase(dbPath);
  } catch (error) {
    const locked = /busy|locked/i.test(String(error?.message || ""));
    return {
      available: !locked,
      reason: locked ? null : "Hermes database is not accessible",
      stale: locked,
      sessions: [],
      warnings: [locked ? "Hermes database is locked; no new sessions were read." : `Could not open Hermes state.db: ${error.message || error}`],
    };
  }

  try {
    const sessionsTable = readRows(db, "sessions", [
      "id", "session_id", "cwd", "title", "hidden", "archived",
      "parent_session_id", "parentSessionId",
      "started_at", "created_at", "last_activity_at", "updated_at", "ended_at",
      "lineage_id", "root_session_id",
    ]);
    if (!sessionsTable.rows.length) {
      const hasTable = sessionsTable.columns.length > 0;
      return {
        available: true,
        sessions: [],
        warnings: hasTable ? [] : ["Hermes state.db has no sessions table"],
      };
    }
    const messagesTable = readRows(db, "messages", [
      "id", "message_id", "session_id", "sessionId", "role", "type",
      "content", "text", "message", "body", "timestamp", "created_at",
    ]);
    const messages = readHermesMessages(db, messagesTable.columns);
    const sessions = hermesRowsToSessions(sessionsTable.rows, { messages, dbPath });
    const active = await readHermesActiveSessions({ hermesHome });
    const activeIds = new Set(active.entries.map((entry) => clean(
      entry.session_id ?? entry.sessionId ?? entry.id,
    )).filter(Boolean));
    for (const session of sessions) {
      if (activeIds.has(session.id)) session.activeHint = true;
    }
    return {
      available: true,
      sessions,
      warnings: [...active.warnings, ...messagesTable.columns.length ? [] : ["Hermes state.db has no messages table"]],
    };
  } finally {
    try { db.close(); } catch {}
  }
}

export async function readHermesPreview({ hermesHome = defaultHermesHome(), sessionId } = {}) {
  const dbPath = hermesDatabasePath(hermesHome);
  if (!existsSync(dbPath)) throw new Error(`Hermes state.db not found at ${dbPath}`);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(`Could not open Hermes state.db: ${error.message || error}`);
  }
  try {
    const columns = columnsOf(db, "messages");
    const messages = readHermesMessages(db, columns);
    const scope = new Set([String(sessionId)]);
    // lineage 会话预览时把同一逻辑会话的成员消息一起投影。
    const sessionsTable = readRows(db, "sessions", ["id", "session_id", "lineage_id", "root_session_id"]);
    for (const row of sessionsTable.rows) {
      const lineage = clean(row.lineage_id ?? row.root_session_id);
      if (lineage && sessionsTable.rows.some((other) => clean(other.lineage_id ?? other.root_session_id) === lineage
        && sessionIdOf(other) === String(sessionId))) {
        scope.add(sessionIdOf(row));
      }
    }
    const selected = messages.filter((message) => scope.has(String(message.sessionId)));
    const sessionRow = sessionsTable.rows.find((row) => sessionIdOf(row) === String(sessionId));
    const firstUser = selected.find((message) => message.role === "user")?.text || "";
    const title = clean(sessionRow?.title) || truncate(firstUser, 120) || "Untitled chat";
    return { path: dbPath, messages: selected, title };
  } finally {
    try { db.close(); } catch {}
  }
}
