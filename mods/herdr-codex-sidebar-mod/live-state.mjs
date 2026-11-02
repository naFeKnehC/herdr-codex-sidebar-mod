export function isActiveCodexAgent(agent) {
  const isCodex = agent?.app === "codex" || agent?.program?.key === "codex";
  return isCodex && (agent.status === "working" || agent.status === "blocked");
}

export function isCodexAgent(agent) {
  return agent?.app === "codex" || agent?.program?.key === "codex";
}

export function isCodexCommand(command) {
  return /(?:^|\/)codex(?:\.exe)?$/i.test(String(command ?? ""));
}

export function containsThread(argv, threadId) {
  return Array.isArray(argv) && argv.some((part) => String(part) === String(threadId));
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
  // Once the tab no longer matches the title this mod last assigned, treat
  // the difference as a user rename and stop overwriting it.
  if (managedName && tabName !== managedName) return null;
  return chatTitle;
}

export function codexTerminalLabels(project, chat, tabTitle = null, placeholder = false) {
  const labels = [`codex.thread.id=${chat.id}`, "codex.managed=true"];
  // An empty value tells `hc label` to remove a stale project label.
  labels.push(`codex.project.id=${project?.id ?? ""}`);
  if (tabTitle) labels.push(`codex.tab.title=${tabTitle}`);
  labels.push(`codex.placeholder=${placeholder ? "true" : ""}`);
  return labels;
}

function sameFolder(left, right) {
  const a = String(left ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  const b = String(right ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function inferredByStart(session, chats) {
  const createdMs = Number(session?.terminal?.created_ms);
  if (!Number.isFinite(createdMs) || createdMs <= 0) return null;
  const liveCwd = session?.pane?.cwd
    || session?.terminal?.foreground?.cwd
    || session?.terminal?.cwd;
  const windowMs = 5 * 60 * 1000;
  const candidates = chats.filter((chat) => {
    const threadMs = Number(chat?.createdAt) * 1000;
    return !chat?.subagent
      && Number.isFinite(threadMs)
      && threadMs > 0
      && (!chat.cwd || !liveCwd || sameFolder(chat.cwd, liveCwd))
      && Math.abs(threadMs - createdMs) <= windowMs;
  }).sort((left, right) => {
    const leftDelta = Math.abs(Number(left.createdAt) * 1000 - createdMs);
    const rightDelta = Math.abs(Number(right.createdAt) * 1000 - createdMs);
    return leftDelta - rightDelta || Number(right.createdAt) - Number(left.createdAt);
  });
  return candidates[0] || null;
}

export function matchLiveChat(session, chats) {
  // `/new` keeps the original `resume <thread>` argv while the live title
  // changes. Prefer the current title over the stale launch-time argument.
  const matches = chats.filter((chat) => titleMatches(session?.agent?.title, chat.title, session?.pane?.cwd)
    && (!chat.cwd || !session?.pane?.cwd || sameFolder(session.pane.cwd, chat.cwd)));
  if (matches.length === 1) return matches[0];

  // Titles are not always available (and duplicate titles are ambiguous), so
  // retain the launch argument as a fallback for normal resumed sessions.
  const argv = session?.argv ?? [];
  return chats.find((chat) => containsThread(argv, chat.id))
    || inferredByStart(session, chats);
}
