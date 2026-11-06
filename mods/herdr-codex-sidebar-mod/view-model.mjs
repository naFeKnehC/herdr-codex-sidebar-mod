// 统一会话模型：Claude / Codex 两个适配器都产出同一种 Session，
// UI 一次只渲染一个 AgentView，每个 AgentView 内再按真实 cwd 精确分组。
// 这个模块必须保持纯函数（不导入 node:fs / herdr），helper 与 UI 共用。

export const AGENTS = ["claude", "codex"];
export const AGENT_NAMES = {
  claude: "Claude",
  codex: "Codex",
};
export const NO_CWD_KEY = "__no_cwd__";
export const NO_CWD_LABEL = "No directory";
export const DEFAULT_PAGE_SIZE = 12;

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === "object" ? value : null;
const asText = (value, fallback = "") => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
};
const clean = (value) => asText(value).replace(/\s+/g, " ").trim();
const firstLine = (value) => clean(String(value ?? "").split("\n").find((line) => line.trim()) ?? "");
const nfc = (value) => String(value ?? "").normalize("NFC");

export function agentName(agent) {
  return AGENT_NAMES[agent] || "Agent";
}

export function isAgentKind(value) {
  return AGENTS.includes(value);
}

export function asTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    // 毫秒时间戳统一成秒；秒级时间戳原样保留。
    return value > 1e11 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return asTimestamp(numeric);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// cwd 规范化（纯字面层）。真实存在性 / realpath / 权限由 helper 侧的
// `inspectCwd` 补充；UI 只消费缓存里已经带上的 cwdInfo。
// ---------------------------------------------------------------------------

export function normalizeCwdLiteral(raw, { home = "/" } = {}) {
  let text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { key: NO_CWD_KEY, cwd: null, kind: "missing", relative: false, literal: "" };
  }
  text = text.replace(/\\/g, "/");
  if (text === "~") text = String(home || "/");
  else if (text.startsWith("~/")) text = `${String(home || "/").replace(/\/+$/, "")}${text.slice(1)}`;
  text = text.replace(/\/+/g, "/");
  if (text.length > 1) text = text.replace(/\/+$/, "");
  if (!text) {
    return { key: NO_CWD_KEY, cwd: null, kind: "missing", relative: false, literal: "" };
  }
  const absolute = text.startsWith("/") || /^[A-Za-z]:\//.test(text);
  if (!absolute) {
    return { key: NO_CWD_KEY, cwd: null, kind: "relative", relative: true, literal: nfc(text) };
  }
  const value = nfc(text);
  return { key: value, cwd: value, kind: "ok", relative: false, literal: value };
}

function pathSegments(value) {
  const text = nfc(value).replace(/\\/g, "/");
  if (text === "/") return [];
  return text.split("/").filter(Boolean);
}

export function displayNameForCwd(cwd) {
  if (!cwd) return NO_CWD_LABEL;
  const text = String(cwd).replace(/\\/g, "/");
  if (text === "/" || /^[A-Za-z]:\/$/.test(text)) return text;
  const segments = pathSegments(text);
  return segments.at(-1) || text || NO_CWD_LABEL;
}

// fallback 徽章里的短目录名：`Resume in <dir>`，没有目录时为 No directory。
export function displayNameForFallback(cwd) {
  return displayNameForCwd(cwd);
}

// 新建 space 的名称：目录名；根目录固定为 `root`（产品文档 10.3）。
export function spaceNameForCwd(cwd, fallback = "Agent") {
  if (!cwd) return fallback;
  const text = String(cwd).replace(/\\/g, "/");
  if (text === "/") return "root";
  return displayNameForCwd(text) || fallback;
}

// tab 标题：优先会话标题；确实没有标题时用 `Claude/Codex Untitled`。
export function tabTitleForSession(session) {
  const title = clean(session?.title);
  if (!title || title === "Untitled chat") return `${agentName(session?.agent)} Untitled`;
  return title;
}

// 同名目录冲突时，计算最短的可区分后缀；没有冲突时不加任何父级。
export function disambiguateDisplayNames(groups) {
  const list = asArray(groups);
  const byName = new Map();
  for (const group of list) {
    const name = group.displayName || displayNameForCwd(group.cwd);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(group);
  }
  const names = new Map();
  for (const [name, conflicts] of byName) {
    if (conflicts.length <= 1) {
      names.set(conflicts[0]?.key, name);
      continue;
    }
    const segments = conflicts.map((group) => pathSegments(group.cwd));
    let depth = 1;
    let labels = [];
    for (; depth <= Math.max(...segments.map((parts) => parts.length)); depth += 1) {
      labels = segments.map((parts) => parts.slice(-depth).join("/") || "/");
      if (new Set(labels).size === labels.length) break;
    }
    conflicts.forEach((group, index) => {
      names.set(group.key, labels[index] || group.cwd || name);
    });
  }
  return names;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function cwdInfoFor(raw, cwdInfo, home) {
  if (cwdInfo && cwdInfo.key) return cwdInfo;
  if (raw?.cwdInfo && raw.cwdInfo.key) return raw.cwdInfo;
  if (raw?.cwdKey) {
    return {
      key: raw.cwdKey,
      cwd: raw.cwd ?? null,
      exists: raw.exists !== false,
      accessible: raw.accessible !== false,
      status: raw.cwdStatus || (raw.exists === false ? "missing-directory" : "ok"),
    };
  }
  const literal = normalizeCwdLiteral(raw?.cwd, { home });
  return {
    ...literal,
    exists: literal.kind === "ok" ? true : false,
    accessible: literal.kind === "ok",
    status: literal.kind === "ok" ? "ok" : literal.kind === "relative" ? "relative" : "missing-cwd",
  };
}

function titleFor(raw) {
  const title = clean(raw?.title ?? raw?.name);
  if (title) return title;
  const preview = firstLine(raw?.preview);
  return preview.slice(0, 120) || "Untitled chat";
}

function completeness(session) {
  let score = 0;
  if (session.title && session.title !== "Untitled chat") score += 4;
  if (session.preview) score += 2;
  if (session.cwd) score += 2;
  if (session.live) score += 1;
  if (session.path) score += 1;
  return score;
}

export function unavailableReasonForCwd(info) {
  if (!info || info.key === NO_CWD_KEY) {
    return info?.kind === "relative" || info?.status === "relative"
      ? "Working directory unavailable"
      : "Working directory unavailable";
  }
  if (info.status === "inaccessible") return "Working directory is not accessible";
  if (info.status === "missing-directory" || info.exists === false) return "Working directory does not exist";
  return null;
}

export function normalizeSession(raw, { agent, cwdInfo = null, home } = {}) {
  const value = asObject(raw);
  if (!value) return null;
  const id = clean(value.id ?? value.sessionId ?? value.session_id);
  if (!id) return null;
  const kind = isAgentKind(agent) ? agent : value.agent;
  if (!isAgentKind(kind)) return null;
  const info = cwdInfoFor(value, cwdInfo, home);
  const createdAt = asTimestamp(value.createdAt ?? value.created_at ?? value.startedAt ?? value.started_at);
  const updatedAt = asTimestamp(value.updatedAt ?? value.updated_at ?? value.lastActivityAt ?? value.last_activity_at);
  const lastActivityAt = asTimestamp(value.lastActivityAt ?? value.last_activity_at)
    || updatedAt
    || createdAt;
  const reason = unavailableReasonForCwd(info);
  // 会话数据本身是否支持恢复；cwd 失效不再让 resume 为 false。
  const resume = value.capabilities?.resume !== false;
  return {
    ...value,
    key: `${kind}:${id}`,
    agent: kind,
    id,
    title: titleFor(value),
    preview: asText(value.preview),
    cwd: info.cwd ?? null,
    cwdKey: info.key,
    cwdInfo: info,
    createdAt,
    updatedAt,
    lastActivityAt,
    archived: Boolean(value.archived),
    hidden: Boolean(value.hidden),
    subagent: Boolean(value.subagent ?? value.parentId ?? value.parentThreadId),
    parentId: value.parentId == null && value.parentThreadId == null
      ? null
      : asText(value.parentId ?? value.parentThreadId),
    capabilities: {
      preview: value.capabilities?.preview !== false,
      resume,
      // 能否直接在原 cwd 恢复；失效时仍可通过 fallback/override 恢复。
      resumeInPlace: !reason,
    },
    unavailableReason: reason,
  };
}

export function dedupeSessions(sessions) {
  const byKey = new Map();
  for (const raw of asArray(sessions)) {
    const session = raw?.key && raw?.agent ? raw : normalizeSession(raw, { agent: raw?.agent });
    if (!session) continue;
    const existing = byKey.get(session.key);
    if (!existing
      || session.lastActivityAt > existing.lastActivityAt
      || (session.lastActivityAt === existing.lastActivityAt
        && completeness(session) > completeness(existing))) {
      byKey.set(session.key, session);
    }
  }
  return [...byKey.values()];
}

function compareSessions(left, right) {
  return (right.lastActivityAt - left.lastActivityAt)
    || (right.updatedAt - left.updatedAt)
    || String(left.title).localeCompare(String(right.title))
    || String(left.id).localeCompare(String(right.id));
}

// ---------------------------------------------------------------------------
// DirectoryGroup / AgentView
// ---------------------------------------------------------------------------

export function groupDirectories(agent, sessions) {
  const groups = new Map();
  for (const session of asArray(sessions)) {
    if (session.agent !== agent) continue;
    const key = session.cwdKey || NO_CWD_KEY;
    let group = groups.get(key);
    if (!group) {
      const info = session.cwdInfo || {};
      group = {
        agent,
        key,
        cwd: session.cwd ?? null,
        displayName: displayNameForCwd(session.cwd),
        exists: Boolean(info.exists),
        accessible: Boolean(info.accessible),
        missing: info.exists === false,
        inaccessible: info.status === "inaccessible",
        sessions: [],
        lastActivityAt: 0,
      };
      groups.set(key, group);
    }
    // 同一 key 下保留最近活动会话的字面 cwd，用于恢复时尽量使用用户原路径。
    if (session.lastActivityAt >= group.lastActivityAt && session.cwd) group.cwd = session.cwd;
    group.sessions.push(session);
    group.lastActivityAt = Math.max(group.lastActivityAt, session.lastActivityAt || 0);
  }

  const directories = [...groups.values()];
  for (const group of directories) {
    group.sessions.sort(compareSessions);
    group.sessionCount = group.sessions.length;
    group.lastActivityAt = Math.max(group.lastActivityAt, group.sessions[0]?.lastActivityAt || 0);
    group.missing = group.exists === false && group.key !== NO_CWD_KEY;
    group.inaccessible = group.accessible === false && group.exists === true;
  }

  // 活跃目录 → 失效/不可访问目录 → No directory；同层内按最近活动倒序。
  const tierOf = (group) => {
    if (group.key === NO_CWD_KEY) return 2;
    return group.exists && group.accessible ? 0 : 1;
  };
  directories.sort((left, right) => {
    const tierDelta = tierOf(left) - tierOf(right);
    if (tierDelta) return tierDelta;
    return (right.lastActivityAt - left.lastActivityAt)
      || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  });

  const names = disambiguateDisplayNames(directories);
  for (const group of directories) {
    group.displayName = group.key === NO_CWD_KEY
      ? NO_CWD_LABEL
      : names.get(group.key) || displayNameForCwd(group.cwd);
  }
  return directories;
}

// ---------------------------------------------------------------------------
// Fallback / 显式目录 override
// ---------------------------------------------------------------------------

export function normalizeFallbackValue(value, { home } = {}) {
  const literal = normalizeCwdLiteral(value, { home });
  if (literal.kind === "relative") {
    return { ok: false, cwd: null, reason: "fallback must be an absolute path" };
  }
  if (!literal.cwd || literal.key === NO_CWD_KEY) {
    return { ok: false, cwd: null, reason: "fallback directory is empty" };
  }
  return { ok: true, cwd: literal.cwd, reason: null };
}

// 读取优先级：全局用户配置 > 当前 Agent 配置 > 统计默认值。
// `exists` 由调用方注入（UI 用 test -d，统计层用 cwdInfo），保证纯函数可单测。
export function resolveFallback(settings = {}, kind, defaultInfo = null, {
  exists = () => true,
  home,
} = {}) {
  const source = asObject(settings) || {};
  const ordered = [
    { source: "user", value: source.fallbackDirectory },
    { source: "agent", value: asObject(source.agents)?.[kind]?.fallbackDirectory },
    { source: "default", value: defaultInfo?.cwd, valid: defaultInfo?.valid !== false },
  ];
  const warnings = [];
  for (const item of ordered) {
    const normalized = normalizeFallbackValue(item.value, { home });
    if (!normalized.ok) {
      if (item.value) warnings.push(`${item.source} fallback is invalid: ${normalized.reason}`);
      continue;
    }
    if (item.source === "default" && item.valid === false) {
      warnings.push(`default fallback does not exist: ${normalized.cwd}`);
      continue;
    }
    if (!exists(normalized.cwd)) {
      warnings.push(`${item.source} fallback does not exist: ${normalized.cwd}`);
      continue;
    }
    return {
      cwd: normalized.cwd,
      source: item.source,
      valid: true,
      needsUserInput: false,
      warnings,
    };
  }
  return {
    cwd: null,
    source: null,
    valid: false,
    needsUserInput: true,
    warnings,
    candidates: [...new Set([
      defaultInfo?.cwd,
      source.fallbackDirectory,
      asObject(source.agents)?.[kind]?.fallbackDirectory,
    ].map((value) => normalizeFallbackValue(value, { home }).cwd).filter(Boolean))],
  };
}

function pathParts(value) {
  return String(value ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
}

function commonParentOf(keys) {
  const lists = keys.map(pathParts);
  if (!lists.length || lists.some((parts) => !parts.length)) return "/";
  // 混合 POSIX 与 Windows 盘符时不做 LCA 推断。
  if (lists.some((parts) => /^[A-Za-z]:$/.test(parts[0]))) return null;
  const common = [];
  for (let index = 0; index < lists[0].length; index += 1) {
    const segment = lists[0][index];
    if (lists.every((parts) => parts[index] === segment)) common.push(segment);
    else break;
  }
  return common.length ? `/${common.join("/")}` : "/";
}

function compareFallbackStats(left, right) {
  return (right.count - left.count)
    || (right.lastActivityAt - left.lastActivityAt)
    || String(left.key).localeCompare(String(right.key));
}

// 统计默认备用目录：优先所有现存 cwd 的公共父目录，其次出现最多（再按最近活动）。
// 没有任何现存目录时给出一个“建议值”（valid: false），UI 必须让用户修改。
export function computeFallbackDefault(views, { home } = {}) {
  const sessions = Array.isArray(views)
    ? views
    : Object.values(asObject(views) || {}).flatMap((view) => asArray(view?.sessions));
  const stats = new Map();
  for (const session of sessions) {
    if (!session || session.hidden || session.subagent) continue;
    const rawCwd = session.cwd ?? session.cwdInfo?.cwd ?? session.originalCwd ?? null;
    const literal = normalizeCwdLiteral(rawCwd, { home });
    if (literal.kind !== "ok" || !literal.cwd || literal.key === NO_CWD_KEY) continue;
    const info = session.cwdInfo || {};
    const existing = info.status === "ok" && info.exists !== false && info.accessible !== false;
    const entry = stats.get(literal.key) || {
      key: literal.key,
      cwd: literal.cwd,
      count: 0,
      lastActivityAt: 0,
      existing: false,
    };
    entry.count += 1;
    entry.lastActivityAt = Math.max(entry.lastActivityAt, session.lastActivityAt || 0);
    entry.existing = entry.existing || existing;
    stats.set(literal.key, entry);
  }

  const all = [...stats.values()];
  const candidates = all.map((entry) => entry.cwd);
  const existing = all.filter((entry) => entry.existing);
  if (existing.length) {
    const lca = commonParentOf(existing.map((entry) => entry.key));
    if (lca && lca !== "/") {
      return { cwd: lca, source: "common-parent", valid: true, candidates };
    }
    const best = [...existing].sort(compareFallbackStats)[0];
    return { cwd: best.cwd, source: "most-frequent", valid: true, candidates };
  }
  if (all.length) {
    const best = [...all].sort(compareFallbackStats)[0];
    return { cwd: best.cwd, source: "suggested-missing", valid: false, candidates };
  }
  return { cwd: null, source: null, valid: false, candidates: [] };
}

// 应用显式“移动到目录”的本地 override：只改变本 mod 的归组和后续 effectiveCwd，
// 不写回 Claude / Codex 的原始会话数据。
export function applySessionCwdOverrides(view, overrides = {}, { agent = null } = {}) {
  const kind = agent || view?.agent;
  if (!view || !kind) return view;
  const records = asObject(overrides) || {};
  let changed = false;
  const sessions = asArray(view.sessions).map((session) => {
    const record = records[session.key];
    const cwd = typeof record === "string" ? record : record?.cwd;
    if (!cwd) return session;
    const literal = normalizeCwdLiteral(cwd);
    if (literal.kind !== "ok" || !literal.cwd || literal.key === NO_CWD_KEY) return session;
    changed = true;
    return {
      ...session,
      originalCwd: session.originalCwd ?? session.cwd,
      originalCwdInfo: session.originalCwdInfo ?? session.cwdInfo,
      originalUnavailableReason: session.originalUnavailableReason ?? session.unavailableReason,
      cwd: literal.cwd,
      cwdKey: literal.key,
      cwdInfo: {
        key: literal.key,
        cwd: literal.cwd,
        exists: true,
        accessible: true,
        status: "ok",
      },
      capabilities: { ...session.capabilities, resume: true, resumeInPlace: true },
      unavailableReason: null,
    };
  });
  if (!changed) return view;
  sessions.sort(compareSessions);
  const directories = groupDirectories(kind, sessions);
  const keys = new Set(directories.map((group) => group.key));
  const selectedDirectoryKey = view.selectedDirectoryKey && keys.has(view.selectedDirectoryKey)
    ? view.selectedDirectoryKey
    : groupsFirstKey(directories);
  return { ...view, sessions, directories, selectedDirectoryKey };
}

function groupsFirstKey(directories) {
  return asArray(directories)[0]?.key ?? null;
}

export function buildAgentView(agent, rawSessions, {
  available = true,
  reason = null,
  warnings = [],
  stale = false,
  includeArchived = false,
  includeSubagents = false,
  home,
} = {}) {
  const sessions = dedupeSessions(asArray(rawSessions)
    .map((raw) => raw?.key && raw?.agent ? raw : normalizeSession(raw, { agent, home })))
    .filter((session) => session.agent === agent)
    .filter((session) => includeArchived || !session.archived)
    .filter((session) => !session.hidden)
    .filter((session) => includeSubagents || !session.subagent)
    .sort(compareSessions);
  const directories = groupDirectories(agent, sessions);
  return {
    agent,
    available: Boolean(available),
    unavailableReason: reason || null,
    sync: {
      status: stale ? "stale" : warnings.length ? "partial" : "ready",
      stale: Boolean(stale),
      warnings: [...new Set(asArray(warnings).map(clean).filter(Boolean))],
    },
    directories,
    sessions,
    selectedDirectoryKey: null,
    selectedPage: 0,
    counts: { total: sessions.length },
  };
}

export function resolveAgentSelection(views, savedAgent) {
  const valid = isAgentKind(savedAgent);
  if (valid && views?.[savedAgent]?.available) return { agent: savedAgent, changed: false };
  const first = AGENTS.find((agent) => views?.[agent]?.available);
  if (first) return { agent: first, changed: first !== savedAgent };
  return { agent: valid ? savedAgent : AGENTS[0], changed: !valid };
}

// 空同步（可能只是临时失败）不能立刻忘记用户选中的目录；只有确实拿到了
// 目录列表、而旧 key 已不存在时才回退到第一个目录。
export function resolveDirectorySelection(view, savedKey) {
  const directories = asArray(view?.directories);
  const exists = savedKey ? directories.find((group) => group.key === savedKey) : null;
  if (exists) return { key: savedKey, changed: false, empty: false, fallback: false };
  if (directories.length) {
    const key = directories[0].key;
    return { key, changed: key !== (savedKey ?? null), empty: false, fallback: true };
  }
  return { key: savedKey ?? null, changed: false, empty: true, fallback: false };
}

export function paginate(items, selectedPage, pageSize) {
  const list = asArray(items);
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const pageCount = Math.max(1, Math.ceil(list.length / size));
  const page = Math.min(Math.max(0, Math.floor(Number(selectedPage) || 0)), pageCount - 1);
  const start = page * size;
  const end = Math.min(list.length, start + size);
  return { page, pageCount, start, end, total: list.length, items: list.slice(start, end) };
}

export function resolvePage(view, directoryKey, savedPage, pageSize = DEFAULT_PAGE_SIZE) {
  const group = asArray(view?.directories).find((item) => item.key === directoryKey);
  if (!group) return 0;
  return paginate(group.sessions, savedPage, pageSize).page;
}

export function normalizeAgentHistory(raw, {
  selectedAgent = null,
  savedDirectories = {},
  savedPages = {},
  pageSize = DEFAULT_PAGE_SIZE,
  home,
} = {}) {
  const value = asObject(raw) || {};
  const source = asObject(value.agents) || {};
  const views = {};
  for (const agent of AGENTS) {
    const entry = asObject(source[agent]) || {};
    const view = buildAgentView(agent, entry.sessions, {
      available: entry.available !== false,
      reason: entry.reason || entry.unavailableReason || null,
      warnings: entry.warnings,
      stale: Boolean(entry.stale),
      includeArchived: Boolean(entry.includeArchived),
      includeSubagents: Boolean(entry.includeSubagents),
      home,
    });
    views[agent] = view;
  }

  const selection = resolveAgentSelection(views, selectedAgent);
  const directorySelections = {};
  for (const agent of AGENTS) {
    const view = views[agent];
    const directory = resolveDirectorySelection(view, savedDirectories?.[agent]);
    view.selectedDirectoryKey = directory.key;
    const group = view.directories.find((item) => item.key === directory.key) || null;
    view.selectedPage = group
      ? paginate(group.sessions, savedPages?.[agent]?.[directory.key], pageSize).page
      : 0;
    directorySelections[agent] = directory;
  }

  const staleAgents = AGENTS.filter((agent) => views[agent].sync.stale);
  const warnings = [...new Set([
    ...asArray(value.warnings).map(clean),
    ...AGENTS.flatMap((agent) => views[agent].sync.warnings),
  ].filter(Boolean))];
  return {
    schemaVersion: 2,
    syncedAt: asTimestamp(value.syncedAt),
    agents: views,
    selectedAgent: selection.agent,
    agentSelectionChanged: selection.changed,
    staleAgents,
    warnings,
    binaries: asObject(value.binaries) || {},
    directorySelections,
  };
}

// ---------------------------------------------------------------------------
// UI 辅助
// ---------------------------------------------------------------------------

export function liveLabel(live) {
  if (!live) return null;
  if (live.ambiguous || (Array.isArray(live.instances) && live.instances.length > 1)) {
    return { text: "Confirm", color: "blocked" };
  }
  const status = live.status || live.agent?.status;
  if (status === "working") return { text: "Working", color: "working" };
  if (status === "blocked") return { text: "Needs you", color: "blocked" };
  if (status === "done") return { text: "Done", color: "done" };
  if (status === "idle") return { text: "Idle", color: "idle" };
  if (live.terminal?.state === "finished") return { text: "Exited · resumable", color: "dim" };
  if (live.terminal) return { text: "Open · unknown", color: "accent" };
  return null;
}

export function badgeColor(theme, color) {
  return theme?.[color] || theme?.accent || "#3b82f6";
}

export function translucentColor(color, alpha = "18") {
  const value = asText(color);
  if (/^#[0-9a-f]{6}$/i.test(value)) return `${value}${alpha}`;
  if (/^#[0-9a-f]{8}$/i.test(value)) return value;
  return "transparent";
}

export function stableElementId(prefix, value) {
  const text = asText(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// 目录按钮的 id 必须带上 Agent：不同 Agent 可能有同一个 cwd，
// 复用同一个 id 会让 Herdr 在切换 Agent 时复用错误的原生元素并中断重渲染。
export function directoryElementId(agent, key) {
  return stableElementId("dir", `${asText(agent)}:${asText(key)}`);
}
