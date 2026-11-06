import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "../codex-app-server.mjs";
import { readThreadName, readThreadTranscript } from "../transcript.mjs";
import { asTimestamp, clean, firstLine, truncate } from "./common.mjs";

export function defaultCodexHome({ home = homedir(), env = process.env } = {}) {
  return env.CODEX_HOME || join(home, ".codex");
}

function sourceOf(thread) {
  return clean(thread?.threadSource ?? thread?.thread_source);
}

export function isUserThread(thread) {
  if (!thread?.id) return false;
  if (thread.archived) return false;
  if (thread.parentThreadId ?? thread.parent_thread_id) return false;
  const source = sourceOf(thread);
  if (source && source !== "user") return false;
  return true;
}

export function threadToSession(thread) {
  const id = clean(thread?.id);
  if (!id) return null;
  const createdAt = asTimestamp(thread.createdAt ?? thread.created_at ?? thread.created_at_ms);
  const updatedAt = asTimestamp(
    thread.updatedAt
    ?? thread.updated_at
    ?? thread.lastActivityAt
    ?? thread.last_activity_at
    ?? thread.recencyAt
    ?? thread.recency_at,
  );
  const preview = clean(thread.preview);
  const title = clean(thread.name)
    || clean(thread.title)
    || truncate(firstLine(preview), 120)
    || "Untitled chat";
  return {
    agent: "codex",
    id,
    title,
    preview: truncate(preview, 240),
    cwd: typeof thread.cwd === "string" && thread.cwd.trim() ? thread.cwd.trim() : null,
    createdAt,
    updatedAt,
    lastActivityAt: updatedAt || createdAt,
    archived: Boolean(thread.archived),
    hidden: false,
    subagent: Boolean(thread.parentThreadId ?? thread.parent_thread_id),
    parentId: thread.parentThreadId ?? thread.parent_thread_id ?? null,
    originator: thread.originator ?? null,
    threadSource: sourceOf(thread) || null,
    path: typeof thread.path === "string" && thread.path.trim() ? thread.path.trim() : null,
    capabilities: { preview: true, resume: true },
  };
}

export async function readCodexSessions({
  codexHome = defaultCodexHome(),
  codex,
  timeoutMs,
  exists = existsSync,
} = {}) {
  // 数据根不存在时该 Agent 标记 unavailable；不启动 app-server，也不报致命错误。
  if (!codexHome || !exists(codexHome)) {
    return {
      available: false,
      reason: "Codex data directory not found",
      sessions: [],
      warnings: [],
    };
  }
  const server = new CodexAppServer({ codexHome, codex, timeoutMs });
  try {
    await server.initialize();
    try { server.child.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n'); } catch {}
    // 不再调用 project/list；项目/assignment 不参与目录分组。
    const threads = await server.list("thread/list", {
      limit: 100,
      archived: false,
      useStateDbOnly: true,
    });
    const sessions = threads.filter(isUserThread).map(threadToSession).filter(Boolean);
    for (const session of sessions) {
      // 只有本机存在 rollout（含 Codex 新版的 .jsonl.zst）时才提供预览；
      // 云端 / 已清理的会话不再让点击进入必然失败的预览 tab。
      session.capabilities.preview = Boolean(session.path
        && (exists(session.path) || exists(`${session.path}.zst`)));
    }
    return { available: true, sessions, warnings: [] };
  } finally {
    server.close();
  }
}

export async function readCodexPreview({ codexHome = defaultCodexHome(), sessionId, path = null } = {}) {
  const title = await readThreadName({ codexHome, threadId: sessionId }).catch(() => null);
  const transcript = await readThreadTranscript({ codexHome, threadId: sessionId, path });
  const firstUser = transcript.messages.find((message) => message.role === "user")?.text || "";
  return {
    path: transcript.path,
    messages: transcript.messages,
    title: title || truncate(firstLine(firstUser), 120) || null,
  };
}
