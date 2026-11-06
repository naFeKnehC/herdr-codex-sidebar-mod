import { normalizeCwdLiteral } from "./view-model.mjs";

const AGENT_NAMES = ["claude", "codex"];

export function agentKindOf(agentOrKind) {
  if (typeof agentOrKind === "string") {
    const value = agentOrKind.toLowerCase();
    if (AGENT_NAMES.includes(value)) return value;
    if (value.includes("claude")) return "claude";
    if (value.includes("codex")) return "codex";
    return null;
  }
  const value = String(
    agentOrKind?.app
    ?? agentOrKind?.program?.key
    ?? agentOrKind?.kind
    ?? agentOrKind?.agent
    ?? "",
  ).toLowerCase();
  if (!value) return null;
  if (value.includes("claude")) return "claude";
  if (value.includes("codex") || value.includes("openai")) return "codex";
  return null;
}

export function isAgent(agent, kind = null) {
  const detected = agentKindOf(agent);
  return kind ? detected === kind : Boolean(detected);
}

export function isActiveAgent(agent) {
  return isAgent(agent) && (agent.status === "working" || agent.status === "blocked");
}

export function isAgentCommand(command, kind = null) {
  if (kind) {
    const pattern = kind === "codex"
      ? /(?:^|\/)codex(?:\.exe)?$/i
      : /(?:^|\/)claude(?:\.exe)?$/i;
    return pattern.test(String(command ?? ""));
  }
  return /(?:^|\/)(?:claude|codex)(?:\.exe)?$/i.test(String(command ?? ""));
}

// 兼容旧 API 名称。
export const isCodexAgent = (agent) => isAgent(agent, "codex");
export const isActiveCodexAgent = (agent) => isCodexAgent(agent) && (agent.status === "working" || agent.status === "blocked");
export const isCodexCommand = (command) => isAgentCommand(command, "codex");

export function labelValue(terminal, key) {
  const labels = terminal?.labels;
  if (Array.isArray(labels)) {
    const pair = labels.find((item) => String(item).startsWith(`${key}=`));
    return pair ? String(pair).slice(key.length + 1) : null;
  }
  return labels?.[key] ?? null;
}

// 新标签优先，旧 codex.* 只读兼容。
export function sessionIdentity(terminal) {
  const legacyId = labelValue(terminal, "codex.thread.id");
  const kind = agentKindOf(labelValue(terminal, "agent.kind")) || (legacyId ? "codex" : null);
  const id = labelValue(terminal, "agent.session.id") || (kind === "codex" ? legacyId : null);
  const cwd = labelValue(terminal, "agent.cwd")
    || (kind === "codex" ? labelValue(terminal, "codex.cwd") : null);
  return { agent: kind, id: id || null, cwd: cwd || null };
}

export function titleKey(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .toLocaleLowerCase()
    .replace(/[\s·•…]+/g, " ")
    .trim();
}

function terminalTitleKey(value, cwd) {
  const key = titleKey(value);
  const folder = String(cwd ?? "").replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
  const suffix = folder ? ` | ${titleKey(folder)}` : "";
  return suffix && key.endsWith(suffix) ? key.slice(0, -suffix.length).trim() : key;
}

export function titleMatches(left, right, cwd) {
  const a = terminalTitleKey(left, cwd);
  const b = titleKey(right);
  return Boolean(a && b && a === b);
}

export function managedTabTitle({ tabName, managedName, chatTitle }) {
  if (!chatTitle) return null;
  // tab 名已不再是本 mod 上次写入的值，说明用户手动改过名，停止覆盖。
  if (managedName && tabName !== managedName) return null;
  return chatTitle;
}

export function agentTerminalLabels({
  kind,
  sessionId,
  cwd = null,
  tabTitle = null,
  placeholder = false,
}) {
  return [
    `agent.kind=${kind}`,
    `agent.session.id=${sessionId ?? ""}`,
    `agent.cwd=${cwd ?? ""}`,
    "agent.managed=true",
    `agent.placeholder=${placeholder ? "true" : ""}`,
    `agent.tab.title=${tabTitle ?? ""}`,
    "agent.preview.exit=",
    "agent.resume.exit=",
    // 复用旧终端时清理历史遗留标签，避免两套标签互相干扰。
    "codex.thread.id=",
    "codex.project.id=",
    "codex.tab.title=",
    "codex.placeholder=",
    "codex.preview.exit=",
    "codex.resume.exit=",
  ];
}

// 兼容旧测试/调用方；新代码应使用 agentTerminalLabels。
export function codexTerminalLabels(project, chat, tabTitle = null, placeholder = false) {
  return agentTerminalLabels({
    kind: "codex",
    sessionId: chat?.id,
    cwd: chat?.cwd ?? null,
    tabTitle,
    placeholder,
  });
}

function normalizedKey(value) {
  return normalizeCwdLiteral(value, { home: "/" }).key;
}

function sameFolder(left, right) {
  const a = normalizedKey(left);
  const b = normalizedKey(right);
  if (!a || !b || a === "__no_cwd__" || b === "__no_cwd__") return false;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function liveCwdOf(live) {
  return live?.pane?.cwd
    || live?.terminal?.foreground?.cwd
    || live?.terminal?.cwd
    || null;
}

function cwdForSessionOf(session, cwdForSession) {
  return typeof cwdForSession === "function" ? cwdForSession(session) : session?.cwd;
}

function cwdCompatible(live, session, cwdForSession) {
  const liveCwd = liveCwdOf(live);
  const expected = cwdForSessionOf(session, cwdForSession);
  return Boolean(expected && liveCwd && sameFolder(expected, liveCwd));
}

function titleCandidates(live, sessions, cwdForSession) {
  const title = live?.agent?.title;
  if (!titleKey(title)) return [];
  const liveCwd = liveCwdOf(live);
  return sessions.filter((session) => {
    const expected = cwdForSessionOf(session, cwdForSession);
    return titleMatches(title, session.title, liveCwd)
      && (!expected || !liveCwd || cwdCompatible(live, session, cwdForSession));
  });
}

export function resumedSessionId(argv, kind = null) {
  if (!Array.isArray(argv)) return null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--resume" && argv[index + 1]) return String(argv[index + 1]);
    if (token === "resume" && argv[index + 1]) {
      // codex: ... -C <cwd> resume <id>；其他 Agent 也兼容裸 resume。
      return String(argv[index + 1]);
    }
  }
  return null;
}

function inferredByStart(live, sessions, cwdForSession) {
  const createdMs = Number(live?.terminal?.created_ms);
  if (!Number.isFinite(createdMs) || createdMs <= 0) return null;
  const liveCwd = liveCwdOf(live);
  if (!liveCwd) return null;
  const windowMs = 5 * 60 * 1000;
  const candidates = sessions.filter((session) => {
    const sessionMs = Number(session?.createdAt) * 1000;
    return !session?.subagent
      && Number.isFinite(sessionMs)
      && sessionMs > 0
      && cwdForSessionOf(session, cwdForSession)
      && cwdCompatible(live, session, cwdForSession)
      && Math.abs(sessionMs - createdMs) <= windowMs;
  }).sort((left, right) => {
    const leftDelta = Math.abs(Number(left.createdAt) * 1000 - createdMs);
    const rightDelta = Math.abs(Number(right.createdAt) * 1000 - createdMs);
    return leftDelta - rightDelta || Number(right.createdAt) - Number(left.createdAt);
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const firstDelta = Math.abs(Number(candidates[0].createdAt) * 1000 - createdMs);
    const secondDelta = Math.abs(Number(candidates[1].createdAt) * 1000 - createdMs);
    return firstDelta < secondDelta ? candidates[0] : null;
  }
  return null;
}

export function matchLiveSession(live, sessions, { kind = null, cwdForSession = null } = {}) {
  const liveKind = kind || agentKindOf(live?.agent);
  if (!liveKind) return { session: null, chat: null, confidence: "none", candidates: [] };
  const available = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => (session?.agent ?? liveKind) === liveKind && !session?.subagent);
  const identity = sessionIdentity(live?.terminal);
  const labelsMatchKind = !identity.agent || identity.agent === liveKind;
  const labelId = labelsMatchKind ? identity.id : null;
  const titles = titleCandidates(live, available, cwdForSession);
  const titleMatch = titles.length === 1 ? titles[0] : null;
  const currentTitle = titleKey(live?.agent?.title);
  const genericNames = ["claude", "claude code", "codex", "codex cli", "openai codex"];
  const genericTitle = !currentTitle || genericNames.includes(currentTitle);
  const labeled = labelId
    ? available.find((session) => String(session.id) === String(labelId))
    : null;
  const foregroundId = resumedSessionId(live?.foregroundArgv, liveKind);
  const launchId = resumedSessionId(live?.argv, liveKind);

  const result = (session, confidence, candidates) => ({
    session,
    chat: session,
    confidence,
    candidates,
  });

  if (foregroundId) {
    const byForeground = available.find((session) => String(session.id) === String(foregroundId));
    if (byForeground && !titleMatch) return result(byForeground, "confirmed", [byForeground]);
  }

  if (titleMatch && labeled && titleMatch.id !== labeled.id) {
    return result(titleMatch, "inferred", [titleMatch]);
  }
  if (labeled && (genericTitle || titleMatch?.id === labeled.id)) {
    return result(labeled, "confirmed", [labeled]);
  }
  if (labelId && currentTitle && !genericTitle && !titleMatch) {
    return result(null, "none", []);
  }

  if (launchId && (!currentTitle || genericTitle)) {
    const byArgv = available.find((session) => String(session.id) === String(launchId));
    if (byArgv) return result(byArgv, "inferred", [byArgv]);
  }
  if (titleMatch) return result(titleMatch, "inferred", [titleMatch]);
  if (titles.length > 1) return result(null, "ambiguous", titles);

  const byTime = inferredByStart(live, available, cwdForSession);
  if (byTime) return result(byTime, "inferred", [byTime]);
  return result(null, "none", []);
}

export function matchLiveChat(live, sessions, options) {
  return matchLiveSession(live, sessions, options).session;
}
