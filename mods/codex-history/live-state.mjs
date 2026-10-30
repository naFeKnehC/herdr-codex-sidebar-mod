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

export function titleMatches(left, right) {
  const a = titleKey(left);
  const b = titleKey(right);
  return Boolean(a && b && a === b);
}

function sameFolder(left, right) {
  const a = String(left ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  const b = String(right ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export function matchLiveChat(session, chats) {
  const argv = session?.argv ?? [];
  const byId = chats.find((chat) => containsThread(argv, chat.id));
  if (byId) return byId;

  const matches = chats.filter((chat) => titleMatches(session?.agent?.title, chat.title)
    && (!chat.cwd || !session?.pane?.cwd || sameFolder(session.pane.cwd, chat.cwd)));
  return matches.length === 1 ? matches[0] : null;
}
