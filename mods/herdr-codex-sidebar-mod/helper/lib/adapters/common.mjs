import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { asTimestamp } from "../../../view-model.mjs";

export { asTimestamp };

export const clean = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim();

export function firstLine(value) {
  return clean(String(value ?? "").split("\n").find((line) => line.trim()) ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value, length = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text;
}

// 通用 transcript 文本提取：文本保留，工具/图片折叠成可读占位。
export function contentToText(content, { toolPlaceholder = "[tool]" } = {}) {
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const type = String(part.type ?? "").toLowerCase();
    if (type === "tool_use" || type === "tool_result" || type === "tool") {
      parts.push(toolPlaceholder);
    } else if (type === "image" || type === "input_image" || type === "local_image") {
      parts.push("[image]");
    } else if (typeof part.text === "string") {
      parts.push(part.text);
    } else if (typeof part.content === "string") {
      parts.push(part.content);
    }
  }
  return clean(parts.join("\n"));
}

export function roleMessage(row) {
  const role = row?.role
    ?? row?.message?.role
    ?? row?.payload?.role
    ?? (row?.type === "user" || row?.type === "assistant" ? row.type : null);
  if (role !== "user" && role !== "assistant") return null;
  const content = row?.content
    ?? row?.message?.content
    ?? row?.payload?.content
    ?? row?.payload?.message?.content
    ?? row?.text;
  const text = contentToText(content);
  if (!text) return null;
  return {
    role,
    text,
    at: row?.timestamp ?? row?.createdAt ?? row?.created_at ?? row?.message?.timestamp ?? null,
  };
}

export function isMetaUserText(text) {
  const value = String(text ?? "");
  return value.startsWith("<environment_context>")
    || value.startsWith("<local-command-")
    || value.startsWith("<command-name>")
    || value.includes("# AGENTS.md instructions")
    || value.startsWith("<system-reminder>");
}

export function detectBinary(name, {
  env = process.env,
  access = (path, mode = constants.X_OK) => accessSync(path, mode),
  existsIsEnough = false,
} = {}) {
  if (!name) return null;
  if (name.includes("/")) {
    try {
      access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const extensions = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat"]
    : [""];
  const directories = String(env.PATH || "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        access(candidate, existsIsEnough ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

export function isProcessAlive(pid, { kill = process.kill } = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    kill(value, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在，只是当前用户没有信号权限。
    return error?.code === "EPERM";
  }
}

export function errorMessage(error) {
  return String(error?.message || error || "unknown error");
}

export function dirnameOf(path) {
  return dirname(path);
}
