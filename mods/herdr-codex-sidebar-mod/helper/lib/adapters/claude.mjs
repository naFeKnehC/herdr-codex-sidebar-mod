import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  asTimestamp,
  clean,
  contentToText,
  firstLine,
  isMetaUserText,
  isProcessAlive,
  truncate,
} from "./common.mjs";

export function defaultClaudeHome({ home = homedir(), env = process.env } = {}) {
  return env.CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

function textOf(row) {
  return contentToText(
    row?.content
    ?? row?.message?.content
    ?? row?.payload?.content
    ?? row?.payload?.message?.content
    ?? row?.text,
  );
}

function roleOf(row) {
  return row?.message?.role
    ?? row?.payload?.role
    ?? row?.payload?.message?.role
    ?? (row?.type === "user" || row?.type === "assistant" ? row.type : null);
}

function kindOf(row) {
  return String(row?.type ?? row?.kind ?? "").toLowerCase();
}

function titleEventValue(row) {
  const kind = kindOf(row);
  if (kind === "custom-title" || kind === "custom_title" || kind === "customtitle") {
    return { channel: "custom", value: clean(row.customTitle ?? row.custom_title ?? row.title ?? row.name) };
  }
  if (kind === "ai-title" || kind === "ai_title" || kind === "aititle") {
    return { channel: "ai", value: clean(row.aiTitle ?? row.ai_title ?? row.title) };
  }
  if (kind === "last-prompt" || kind === "last_prompt" || kind === "lastprompt") {
    return { channel: "last", value: clean(row.lastPrompt ?? row.last_prompt ?? row.prompt ?? row.text) };
  }
  return null;
}

function setLatest(holder, value, at) {
  if (!value) return holder;
  // 时间不可信时，后出现的有效值算“更新”。
  if (!holder || at >= holder.at || !at || !holder.at) return { value, at: at || 0 };
  return holder;
}

function realUserText(row, text) {
  if (roleOf(row) !== "user") return null;
  if (row?.isSidechain || row?.is_sidechain || row?.isMeta || row?.is_meta) return null;
  const value = clean(text);
  if (!value || value === "[tool]" || value.startsWith("[tool]\n")) {
    // 纯工具结果不是真实用户文本；若文本块与工具混在一起，取工具之前/之后的人类文本。
    const human = value.split("\n").filter((line) => line.trim() && line.trim() !== "[tool]").join("\n");
    if (!human) return null;
    return isMetaUserText(human) ? null : human;
  }
  return isMetaUserText(value) ? null : value;
}

export function parseClaudeJsonl(lines, { path = null, mtime = 0 } = {}) {
  const warnings = [];
  let sessionId = null;
  let cwd = null;
  let createdAt = 0;
  let updatedAt = 0;
  let customTitle = null;
  let aiTitle = null;
  let lastPrompt = null;
  let firstUserText = null;
  const messages = [];
  let badLines = 0;

  for (const line of Array.isArray(lines) ? lines : String(lines ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch {
      badLines += 1;
      continue;
    }
    if (!row || typeof row !== "object") continue;

    if (!sessionId) sessionId = clean(row.sessionId ?? row.session_id) || null;
    if (!cwd) cwd = typeof row.cwd === "string" && row.cwd.trim() ? row.cwd.trim() : null;

    const at = asTimestamp(row.timestamp ?? row.createdAt ?? row.created_at ?? row.updatedAt ?? row.time);
    if (at > 0) {
      createdAt = createdAt > 0 ? Math.min(createdAt, at) : at;
      updatedAt = Math.max(updatedAt, at);
    }

    const event = titleEventValue(row);
    if (event?.value) {
      if (event.channel === "custom") customTitle = setLatest(customTitle, event.value, at);
      else if (event.channel === "ai") aiTitle = setLatest(aiTitle, event.value, at);
      else lastPrompt = setLatest(lastPrompt, event.value, at);
    }

    const role = roleOf(row);
    if ((role === "user" || role === "assistant") && !row?.isSidechain && !row?.is_sidechain) {
      const text = textOf(row);
      if (text) {
        if (role === "assistant" || realUserText(row, text)) {
          messages.push({ role, text, at: row.timestamp ?? null });
        }
        if (!firstUserText) firstUserText = realUserText(row, text);
      }
    }
  }

  if (badLines > 0) warnings.push(`Skipped ${badLines} malformed line(s) in ${path || "Claude transcript"}`);
  const id = sessionId || (path ? basename(path).replace(/\.jsonl$/i, "") : null);
  if (!id) return { session: null, messages, warnings };

  if (!updatedAt && mtime > 0) updatedAt = Math.floor(mtime / 1000);
  if (!createdAt) createdAt = updatedAt;

  const title = clean(customTitle?.value)
    || clean(aiTitle?.value)
    || truncate(firstUserText, 120)
    || truncate(lastPrompt?.value, 120)
    || "Untitled chat";

  const session = {
    agent: "claude",
    id,
    title,
    preview: truncate(firstUserText || firstLine(messages.find((item) => item.role === "assistant")?.text), 240),
    cwd,
    createdAt,
    updatedAt,
    lastActivityAt: updatedAt || createdAt,
    archived: false,
    hidden: false,
    subagent: false,
    parentId: null,
    path,
    capabilities: { preview: true, resume: true },
    titleSource: customTitle?.value
      ? "custom-title"
      : aiTitle?.value
        ? "ai-title"
        : firstUserText
          ? "first-user"
          : lastPrompt?.value
            ? "last-prompt"
            : "untitled",
  };
  return { session, messages, warnings };
}

function liveStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (status === "busy" || status === "working") return "working";
  if (status === "idle") return "idle";
  if (status === "blocked") return "blocked";
  if (status === "done") return "done";
  return "unknown";
}

export async function readClaudeLiveEntries({
  claudeHome = defaultClaudeHome(),
  alive = isProcessAlive,
  readdirFn = readdir,
  readFileFn = readFile,
} = {}) {
  const directory = join(claudeHome, "sessions");
  let entries;
  try { entries = await readdirFn(directory, { withFileTypes: true }); }
  catch { return { entries: [], warnings: [] }; }
  const live = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    let value;
    try { value = JSON.parse(await readFileFn(path, "utf8")); }
    catch {
      warnings.push(`Could not read Claude live session ${entry.name}`);
      continue;
    }
    const pid = Number(value?.pid ?? entry.name.replace(/\.json$/i, ""));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!alive(pid)) continue;
    const sessionId = clean(value?.sessionId ?? value?.session_id);
    if (!sessionId) continue;
    live.push({
      sessionId,
      pid,
      status: liveStatus(value?.status),
      cwd: typeof value?.cwd === "string" ? value.cwd : null,
      updatedAt: asTimestamp(value?.updatedAt ?? value?.updated_at ?? value?.lastActivityAt),
    });
  }
  return { entries: live, warnings };
}

export function applyClaudeLive(sessions, entries) {
  const bySession = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.sessionId) continue;
    if (!bySession.has(entry.sessionId)) bySession.set(entry.sessionId, []);
    bySession.get(entry.sessionId).push(entry);
  }
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const instances = bySession.get(String(session.id)) || [];
    if (!instances.length) continue;
    instances.sort((left, right) => (right.updatedAt - left.updatedAt) || (right.pid - left.pid));
    const latest = instances[0];
    session.live = {
      status: latest.status,
      pid: latest.pid,
      updatedAt: latest.updatedAt,
      cwd: latest.cwd,
      source: "claude-static",
      ambiguous: instances.length > 1,
      instances: instances.map((item) => ({
        pid: item.pid,
        status: item.status,
        cwd: item.cwd,
        updatedAt: item.updatedAt,
      })),
      terminal: null,
    };
  }
  return sessions;
}

export async function readClaudeSessions({
  claudeHome = defaultClaudeHome(),
  liveStatus = true,
  alive = isProcessAlive,
  readdirFn = readdir,
  readFileFn = readFile,
  statFn = stat,
} = {}) {
  const projectsRoot = join(claudeHome, "projects");
  let projectDirs;
  try { projectDirs = await readdirFn(projectsRoot, { withFileTypes: true }); }
  catch (error) {
    return {
      available: false,
      reason: error?.code === "EACCES"
        ? "Claude data directory is not accessible"
        : "Claude data directory not found",
      sessions: [],
      warnings: [],
    };
  }

  const warnings = [];
  const sessions = [];
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue;
    const directory = join(projectsRoot, project.name);
    let files;
    try { files = await readdirFn(directory, { withFileTypes: true }); }
    catch {
      warnings.push(`Could not read Claude project directory ${project.name}`);
      continue;
    }
    for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
      // 只读 <encoded>/<session-id>.jsonl 顶层文件；<id>/subagents/*.jsonl 不建立独立会话。
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(directory, file.name);
      try {
        const [text, info] = await Promise.all([readFileFn(path, "utf8"), statFn(path)]);
        const parsed = parseClaudeJsonl(text.split("\n"), {
          path,
          mtime: Number(info?.mtimeMs) || 0,
        });
        warnings.push(...parsed.warnings);
        if (parsed.session) sessions.push(parsed.session);
      } catch (error) {
        warnings.push(`Could not read Claude transcript ${file.name}: ${error.message || error}`);
      }
    }
  }

  if (liveStatus) {
    const live = await readClaudeLiveEntries({ claudeHome, alive, readdirFn, readFileFn });
    warnings.push(...live.warnings);
    applyClaudeLive(sessions, live.entries);
  }
  return { available: true, sessions, warnings };
}

export async function findClaudeTranscript({ claudeHome = defaultClaudeHome(), sessionId, path = null, readdirFn = readdir } = {}) {
  if (path) return path;
  if (!claudeHome || !sessionId) return null;
  const projectsRoot = join(claudeHome, "projects");
  let dirs;
  try { dirs = await readdirFn(projectsRoot, { withFileTypes: true }); }
  catch { return null; }
  const wanted = `${sessionId}.jsonl`;
  const matches = [];
  for (const project of dirs) {
    if (!project.isDirectory()) continue;
    let files;
    try { files = await readdirFn(join(projectsRoot, project.name), { withFileTypes: true }); }
    catch { continue; }
    const file = files.find((item) => item.isFile() && item.name === wanted);
    if (file) matches.push(join(projectsRoot, project.name, file.name));
  }
  return matches.sort()[0] || null;
}

export async function readClaudePreview({ claudeHome = defaultClaudeHome(), sessionId, path = null } = {}) {
  const transcriptPath = await findClaudeTranscript({ claudeHome, sessionId, path });
  if (!transcriptPath) throw new Error(`No local transcript found for Claude session ${sessionId}`);
  const text = await readFile(transcriptPath, "utf8");
  const parsed = parseClaudeJsonl(text.split("\n"), { path: transcriptPath });
  if (!parsed.session) throw new Error(`Claude transcript ${transcriptPath} is empty or unreadable`);
  return { path: transcriptPath, messages: parsed.messages, title: parsed.session.title };
}
