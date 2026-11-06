import { access, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const ANSI_PATTERN = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_PREVIEW_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 8_000;

const clean = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim();

export function sanitizeTerminalText(value) {
  return String(value ?? "")
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .trim();
}

const AGENT_NAMES = { claude: "Claude", codex: "Codex", hermes: "Hermes" };
export const agentDisplayName = (agent) => AGENT_NAMES[agent] || "Agent";

function contentText(content) {
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  return clean(content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.text) return part.text;
    if (part?.type === "local_image" && part.path) return `[image: ${basename(part.path)}]`;
    if (part?.type === "input_image" || part?.type === "image") return "[image]";
    if (part?.type === "tool_use" || part?.type === "tool_result" || part?.type === "tool") return "[tool]";
    return "";
  }).filter(Boolean).join("\n"));
}

function itemMessage(row) {
  if (row?.type !== "event_msg" || row?.payload?.type !== "item_completed") return null;
  const item = row.payload.item;
  if (item?.type === "UserMessage") {
    return { role: "user", text: contentText(item.content), at: row.timestamp };
  }
  if (item?.type === "AgentMessage") {
    return { role: "assistant", text: contentText(item.content), at: row.timestamp };
  }
  return null;
}

function responseMessage(row) {
  if (row?.type !== "response_item" || row?.payload?.type !== "message") return null;
  const role = row.payload.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = contentText(row.payload.content);
  if (!text) return null;
  if (role === "user" && (
    text.includes("<environment_context>")
    || text.includes("# AGENTS.md instructions")
    || text.startsWith("<system-reminder>")
  )) return null;
  return { role, text, at: row.timestamp };
}

export function parseTranscriptLines(lines) {
  const eventMessages = [];
  const fallbackMessages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { continue; }
    const eventMessage = itemMessage(row);
    if (eventMessage?.text) eventMessages.push(eventMessage);
    const fallback = responseMessage(row);
    if (fallback) fallbackMessages.push(fallback);
  }
  const messages = eventMessages.length ? eventMessages : fallbackMessages;
  return messages.filter((message) => message.text);
}

async function walkJsonl(directory, suffix, output) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, suffix, output);
    else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(suffix)) {
      output.push(path);
    }
  }
}

export async function findTranscriptPath({ codexHome, threadId, path = null }) {
  if (path) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  if (!codexHome || !threadId) return null;
  const found = [];
  await walkJsonl(join(codexHome, "sessions"), String(threadId), found);
  return found.sort()[0] || null;
}

export async function readThreadName({ codexHome, threadId }) {
  if (!codexHome || !threadId) return null;
  try {
    const lines = (await readFile(join(codexHome, "session_index.jsonl"), "utf8")).split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].trim()) continue;
      try {
        const row = JSON.parse(lines[index]);
        if (String(row.id) === String(threadId)) return row.thread_name || null;
      } catch {}
    }
  } catch {}
  return null;
}

export async function readThreadTranscript({ codexHome, threadId, path = null }) {
  const transcriptPath = await findTranscriptPath({ codexHome, threadId, path });
  if (!transcriptPath) throw new Error(`No local transcript found for thread ${threadId}`);
  const lines = (await readFile(transcriptPath, "utf8")).split("\n");
  return { path: transcriptPath, messages: parseTranscriptLines(lines) };
}

function terminalTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function renderTranscript({
  agent = "codex",
  title,
  sessionId,
  threadId,
  cwd,
  messages,
  color = true,
}) {
  const paint = (code, value) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const name = agentDisplayName(agent);
  const line = "-".repeat(76);
  const id = sessionId ?? threadId ?? "";
  const allMessages = Array.isArray(messages) ? messages : [];
  const visible = allMessages.slice(0, MAX_PREVIEW_MESSAGES);
  const out = [
    paint("1;36", `${name} history: ${sanitizeTerminalText(title) || "Untitled chat"}`),
    paint("2", `Session ${id}`),
  ];
  if (cwd) out.push(paint("2", `CWD ${cwd}`));
  out.push(line, "");

  for (const message of visible) {
    const role = message.role === "user" ? "You" : name;
    const roleColor = message.role === "user" ? "1;34" : "1;32";
    const at = terminalTime(message.at);
    const text = sanitizeTerminalText(message.text).slice(0, MAX_MESSAGE_CHARS);
    out.push(paint(roleColor, `${role}${at ? `  ${at}` : ""}`));
    out.push(text, "");
  }

  if (allMessages.length > visible.length) {
    out.push(paint("2", `… ${allMessages.length - visible.length} more message(s) not shown.`), "");
  }
  if (!allMessages.length) out.push(paint("2", "No readable messages in this local transcript."), "");
  out.push(line, paint("2", `History preview only. Double-click the chat in the sidebar to resume ${name}.`));
  return `${out.join("\n")}\n`;
}
