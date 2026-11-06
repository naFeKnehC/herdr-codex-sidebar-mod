import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  agents,
  appHome,
  exec,
  home,
  panes,
  pickFolder,
  run,
  spaces,
  terminals,
  theme,
} from "herdr";
import {
  findDirectorySpaceMatches,
  previewAvailability,
  previewShellCommand,
  resolveEffectiveCwd,
  resumeArgv,
  resumeAvailability,
  resumeShellCommand,
} from "./launch-target.mjs";
import {
  agentTerminalLabels,
  agentKindOf,
  labelValue,
  managedTabTitle,
  matchLiveSession,
  resumedSessionId,
  sessionIdentity,
  titleKey,
} from "./live-state.mjs";
import {
  AGENTS,
  DEFAULT_PAGE_SIZE,
  NO_CWD_KEY,
  agentName,
  applySessionCwdOverrides,
  badgeColor,
  computeFallbackDefault,
  directoryElementId,
  displayNameForFallback,
  liveLabel,
  normalizeAgentHistory,
  normalizeFallbackValue,
  paginate,
  resolveFallback,
  spaceNameForCwd,
  stableElementId,
  tabTitleForSession,
  translucentColor,
} from "./view-model.mjs";

const MOD_DIR = () => `${appHome()}/mods/herdr-codex-sidebar-mod`;
const CHAT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
const HELPER_BIN = () => `${MOD_DIR()}/bin/codex-history`;
const HC_BIN = () => `${MOD_DIR()}/bin/hc`;
const SAVED_AGENT = "herdr-agent-history-agent";
const savedDirectoryKey = (agent) => `herdr-agent-history-directory-${agent}`;
const savedPageKey = (agent) => `herdr-agent-history-pages-${agent}`;
const FALLBACK_GLOBAL = "herdr-agent-history-fallback-directory";
const fallbackAgentKey = (agent) => `${FALLBACK_GLOBAL}-${agent}`;
const STRICT_RESUME = "herdr-agent-history-strict-resume";
const SESSION_CWD_OVERRIDES = "herdr-agent-history-cwd-overrides";
const missingExpandedKey = (agent) => `herdr-agent-history-missing-expanded-${agent}`;

const ago = (seconds) => {
  if (!seconds) return "";
  const delta = Math.max(0, Date.now() / 1000 - Number(seconds));
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.round(delta / 86400)}d`;
  return `${Math.round(delta / (86400 * 30))}mo`;
};
const terminalAddress = (terminal) => terminal?.address ?? terminal?.id ?? terminal?.name ?? null;
const terminalState = (terminal) => terminal?.state ?? terminal?.status?.state ?? (typeof terminal?.status === "string" ? terminal.status : null);
const isLiveTerminal = (terminal) => terminalState(terminal) === "live";
const storageGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const storageSet = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const loadJson = (key) => {
  try {
    const value = JSON.parse(storageGet(key) || "null");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

export default class AgentHistory extends View {
  init(_props, cx) {
    this.data = normalizeAgentHistory(null);
    this.loading = false;
    this.actions = {};
    this.failures = {};
    this.placeholders = {};
    this.pages = Object.fromEntries(AGENTS.map((agent) => [agent, loadJson(savedPageKey(agent))]));
    this.savedDirs = Object.fromEntries(AGENTS.map((agent) => [agent, storageGet(savedDirectoryKey(agent))]));
    this.selectedAgent = storageGet(SAVED_AGENT);
    this.agentMenuOpen = false;
    this.binaries = {};
    this.labelsScheduled = false;
    this.titleSignature = null;
    this.lastUnmatchedRefresh = 0;
    this.fallbackSettings = this.loadFallbackSettings();
    this.strictResume = storageGet(STRICT_RESUME) === "true";
    this.overrides = loadJson(SESSION_CWD_OVERRIDES);
    this.validOverrides = {};
    this.fallbackInfo = Object.fromEntries(AGENTS.map((agent) => [agent, null]));
    this.missingExpanded = Object.fromEntries(
      AGENTS.map((agent) => [agent, storageGet(missingExpandedKey(agent)) === "true"]),
    );
    this.fallbackEditor = null;
    this.sessionMenuKey = null;
    this.pendingTargets = new Set();
    this.spaceLocks = new Map();
    this.folderChecks = new Map();
    this.syncWarnings = [];
    this.actionWarnings = [];
    this.refresh(cx);
    cx.timer.every(60_000, (timerCx) => this.refresh(timerCx));
    // 任一 Agent 的标题变化都可能意味着历史摘要变化；刷新不切换当前 AgentView。
    cx.timer.every(5_000, (timerCx) => {
      const signature = agents()
        .filter((agent) => agentKindOf(agent))
        .map((agent) => `${agent.address}:${agentKindOf(agent)}:${titleKey(agent.title)}`)
        .sort()
        .join("\n");
      if (this.titleSignature === null) this.titleSignature = signature;
      else if (signature !== this.titleSignature) {
        this.titleSignature = signature;
        this.refresh(timerCx);
      } else if (this.unmatchedRecentAgent() && Date.now() - this.lastUnmatchedRefresh > 15_000) {
        this.lastUnmatchedRefresh = Date.now();
        this.refresh(timerCx);
      }
      timerCx.notify();
    });
  }

  async helper() {
    return exec(HELPER_BIN(), [
      "sync",
      "--json",
      "--cache",
      `${appHome()}/data/herdr-agent-history/history.json`,
    ]);
  }

  // -------------------------------------------------------------------------
  // fallback / override 配置与目录验证
  // -------------------------------------------------------------------------

  loadFallbackSettings() {
    return {
      fallbackDirectory: storageGet(FALLBACK_GLOBAL) || null,
      agents: Object.fromEntries(AGENTS.map((agent) => [
        agent,
        { fallbackDirectory: storageGet(fallbackAgentKey(agent)) || null },
      ])),
      strictResume: storageGet(STRICT_RESUME) === "true",
    };
  }

  saveFallbackDirectory(cwd, { onlyAgent = null, strict = this.strictResume } = {}) {
    if (onlyAgent) storageSet(fallbackAgentKey(onlyAgent), cwd);
    else storageSet(FALLBACK_GLOBAL, cwd);
    storageSet(STRICT_RESUME, strict ? "true" : "false");
    this.strictResume = Boolean(strict);
    this.fallbackSettings = this.loadFallbackSettings();
  }

  // 按唯一路径缓存 `test -d` 结果；同一 refresh 周期内不重复 stat。
  folderExists(path) {
    if (!path) return Promise.resolve(false);
    const key = String(path);
    if (!this.folderChecks) this.folderChecks = new Map();
    const cached = this.folderChecks.get(key);
    if (cached !== undefined) return cached;
    if (!this.folderCheckResults) this.folderCheckResults = new Map();
    const pending = exec("test", ["-d", key])
      .then((result) => {
        const value = result.code === 0;
        this.folderCheckResults.set(key, value);
        return value;
      })
      .catch(() => {
        this.folderCheckResults.set(key, false);
        return false;
      });
    this.folderChecks.set(key, pending);
    return pending;
  }

  async checkFolderFresh(path) {
    if (!path) return false;
    this.folderChecks?.delete(String(path));
    return this.folderExists(path);
  }

  fallbackFor(agent) {
    const info = this.fallbackInfo?.[agent];
    if (!info?.valid || !info.cwd) return null;
    return { cwd: info.cwd, valid: true, source: info.source };
  }

  overrideFor(session) {
    const record = this.validOverrides?.[session.key];
    if (!record?.cwd) return null;
    return { cwd: record.cwd, valid: true };
  }

  // 渲染与 live 匹配共用的同步 effectiveCwd（使用 refresh 时验证过的缓存）。
  effectiveCwdFor(session) {
    return resolveEffectiveCwd({
      session,
      fallback: this.fallbackFor(session.agent),
      override: this.overrideFor(session),
      strictResume: this.strictResume,
    });
  }

  // 恢复动作前重新验证原目录 / override / fallback，不信任 stale 缓存。
  async resolveSessionTarget(session) {
    const originalCwd = session.originalCwd ?? session.cwd ?? null;
    const originalInfo = session.originalCwdInfo ?? session.cwdInfo ?? {};
    let effectiveSession = session;
    if (originalCwd) {
      const exists = await this.checkFolderFresh(originalCwd);
      const accessible = exists && originalInfo.accessible !== false;
      const status = !exists ? "missing-directory" : !accessible ? "inaccessible" : "ok";
      effectiveSession = {
        ...session,
        cwd: originalCwd,
        cwdKey: originalInfo.key ?? originalCwd,
        cwdInfo: {
          ...originalInfo,
          key: originalInfo.key ?? originalCwd,
          cwd: originalCwd,
          exists,
          accessible,
          status,
        },
        unavailableReason: !exists
          ? "Working directory does not exist"
          : !accessible
            ? "Working directory is not accessible"
            : null,
      };
    }

    let override = null;
    const record = this.overrides?.[session.key];
    const overrideCwd = typeof record === "string" ? record : record?.cwd;
    if (overrideCwd) {
      const normalized = normalizeFallbackValue(overrideCwd, { home: home() });
      if (!normalized.ok) {
        this.pushWarning(`Moved directory is invalid: ${normalized.reason}`);
      } else if (await this.checkFolderFresh(normalized.cwd)) {
        override = { cwd: normalized.cwd, valid: true };
      } else {
        this.pushWarning(`Moved directory no longer exists: ${normalized.cwd}`);
      }
    }

    let fallback = null;
    const info = this.fallbackInfo?.[session.agent];
    if (info?.cwd) {
      const normalized = normalizeFallbackValue(info.cwd, { home: home() });
      if (!normalized.ok) {
        this.pushWarning(`Fallback directory is invalid: ${normalized.reason}`);
      } else if (await this.checkFolderFresh(normalized.cwd)) {
        fallback = { cwd: normalized.cwd, valid: true, source: info.source };
      } else {
        this.pushWarning(`Fallback directory no longer exists: ${normalized.cwd}`);
      }
    }

    return resolveEffectiveCwd({
      session: effectiveSession,
      fallback,
      override,
      strictResume: this.strictResume,
    });
  }

  async withSpaceLock(cwd, fn) {
    const key = String(cwd || "");
    const previous = this.spaceLocks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.spaceLocks.set(key, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.spaceLocks.get(key) === tail) this.spaceLocks.delete(key);
    }
  }

  async waitForSpace(cwd, cx, attempts = 10) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const found = await this.spaceFor(cwd);
      if (found) return found;
      await new Promise((resolve) => cx.timer.after(100, resolve));
    }
    return null;
  }

  async createSpace(cwd, title, argv, cx, agent = this.selectedAgent) {
    run("space.new", {
      name: spaceNameForCwd(cwd, agentName(agent)),
      folder: cwd,
      tab: title,
      ...(argv ? { argv } : {}),
    });
    const created = await this.waitForSpace(cwd, cx);
    if (!created) this.pushWarning(`Created a space for ${cwd}, but Herdr has not reported it yet.`);
    return created;
  }

  currentView() {
    return this.data.agents?.[this.selectedAgent] || null;
  }

  allSessions() {
    return AGENTS.flatMap((agent) => this.data.agents?.[agent]?.sessions || []);
  }

  beginAction(session, phase, cx, timeoutMs = 30_000) {
    const current = this.actions[session.key];
    if (current) return current;
    delete this.failures[session.key];
    const action = { phase, startedAt: Date.now(), pendingResume: false };
    this.actions[session.key] = action;
    cx.timer.after(timeoutMs, (timerCx) => {
      if (this.actions[session.key] !== action) return;
      delete this.actions[session.key];
      this.pushWarning(`Timed out while ${phase} this conversation. Retry is available.`);
      timerCx.notify();
    });
    return action;
  }

  endAction(session, action, error = null) {
    if (this.actions[session.key] !== action) return;
    delete this.actions[session.key];
    if (error) {
      this.failures[session.key] = String(error);
      this.pushWarning(error);
    }
  }

  pushWarning(message) {
    const text = String(message ?? "").trim();
    if (!text) return;
    this.actionWarnings = [...new Set([...(this.actionWarnings ?? []), text])];
    this.rebuildError();
  }

  setSyncWarnings(warnings, stale = false) {
    this.syncWarnings = [...new Set([
      ...(warnings ?? []),
      ...(stale ? ["Showing cached history because the latest sync failed for at least one agent."] : []),
    ])];
    this.rebuildError();
  }

  rebuildError() {
    this.warnings = [...new Set([...(this.syncWarnings ?? []), ...(this.actionWarnings ?? [])])];
    this.error = this.warnings.join(" · ") || null;
  }

  clearActionError() {
    this.syncWarnings = [];
    this.actionWarnings = [];
    this.failures = {};
    this.rebuildError();
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.clearActionError();
    this.folderChecks = new Map();
    this.folderCheckResults = new Map();
    cx.spawn(async (taskCx) => {
      try {
        const result = await this.helper();
        const parsed = JSON.parse(result.stdout);
        this.binaries = { ...(parsed.binaries || {}) };
        const data = normalizeAgentHistory(parsed, {
          selectedAgent: this.selectedAgent,
          savedDirectories: this.savedDirs,
          savedPages: this.pages,
          pageSize: CHAT_PAGE_SIZE,
        });
        this.selectedAgent = data.selectedAgent;

        // 显式“移动到目录”的 override：目录失效时回退到 original/fallback 并 warning。
        const validOverrides = {};
        for (const [key, record] of Object.entries(this.overrides || {})) {
          const cwd = typeof record === "string" ? record : record?.cwd;
          if (!cwd) continue;
          const normalized = normalizeFallbackValue(cwd, { home: home() });
          if (!normalized.ok) {
            this.pushWarning(`Moved directory is invalid: ${normalized.reason}`);
            continue;
          }
          if (await this.folderExists(normalized.cwd)) {
            validOverrides[key] = {
              cwd: normalized.cwd,
              updatedAt: Number(record?.updatedAt) || 0,
            };
          } else {
            this.pushWarning(`Moved directory no longer exists: ${normalized.cwd}`);
          }
        }
        this.validOverrides = validOverrides;
        for (const agent of AGENTS) {
          data.agents[agent] = applySessionCwdOverrides(data.agents[agent], validOverrides);
        }

        // 统计默认 fallback（跨 Agent），再按 user > agent > default 解析并验证。
        const defaultInfo = computeFallbackDefault(data.agents, { home: home() });
        const candidates = new Set([
          this.fallbackSettings.fallbackDirectory,
          ...AGENTS.map((agent) => this.fallbackSettings.agents?.[agent]?.fallbackDirectory),
          defaultInfo.cwd,
        ].filter(Boolean));
        for (const candidate of candidates) {
          const normalized = normalizeFallbackValue(candidate, { home: home() });
          if (normalized.ok) await this.folderExists(normalized.cwd);
        }
        const nextFallback = {};
        for (const agent of AGENTS) {
          const info = resolveFallback(this.fallbackSettings, agent, defaultInfo, {
            exists: (path) => Boolean(this.folderCheckResults?.get(String(path))),
            home: home(),
          });
          nextFallback[agent] = { ...info, defaultInfo };
          for (const warning of info.warnings) this.pushWarning(warning);
        }
        this.fallbackInfo = nextFallback;

        this.data = data;
        storageSet(SAVED_AGENT, this.selectedAgent);
        for (const agent of AGENTS) {
          const key = data.agents[agent].selectedDirectoryKey;
          if (key && data.agents[agent].directories.length) {
            this.savedDirs[agent] = key;
            storageSet(savedDirectoryKey(agent), key);
          }
        }
        this.setSyncWarnings(data.warnings, data.staleAgents.length > 0);
        this.scheduleLiveLabels(taskCx);
      } catch (error) {
        this.pushWarning(`Could not sync history: ${error.message || error}`);
      } finally {
        this.loading = false;
        taskCx.notify();
      }
    });
  }

  // -------------------------------------------------------------------------
  // 实时事实：Herdr agents()/terminals()/panes() -> 每个 Session 的匹配结果
  // -------------------------------------------------------------------------

  localAgents(kind) {
    const spaceById = new Map(spaces().map((space) => [space.id, space]));
    return agents()
      .filter((agent) => agentKindOf(agent) === kind)
      .filter((agent) => spaceById.get(agent.space)?.machine == null);
  }

  liveCandidates(kind) {
    const allTerminals = terminals();
    const allPanes = panes();
    return this.localAgents(kind).map((agent) => {
      const terminal = allTerminals.find((item) => terminalAddress(item) === agent.address) || null;
      const argv = terminal?.foreground?.argv ?? terminal?.argv ?? [];
      return {
        agent,
        terminal,
        pane: allPanes.find((item) => item.pane === agent.pane) || null,
        argv,
        foregroundArgv: terminal?.foreground?.argv ?? null,
      };
    }).filter((item) => item.terminal && isLiveTerminal(item.terminal));
  }

  sessionLive(session) {
    const view = this.data.agents?.[session.agent];
    const sessions = view?.sessions || [];
    const matches = [];
    const ambiguousIds = new Set();
    const cwdForSession = (item) => this.effectiveCwdFor(item).cwd
      ?? this.fallbackFor(item.agent)?.cwd
      ?? item.cwd;
    for (const live of this.liveCandidates(session.agent)) {
      const result = matchLiveSession(live, sessions, { kind: session.agent, cwdForSession });
      if (result.confidence === "ambiguous") {
        for (const candidate of result.candidates || []) ambiguousIds.add(candidate.id);
        continue;
      }
      if (result.session?.id === session.id && result.confidence !== "ambiguous") {
        matches.push({ live, result });
      }
    }
    if (matches.length > 1) {
      return {
        ...(session.live || {}),
        confidence: "ambiguous",
        ambiguous: true,
        terminal: null,
        pane: null,
        agent: null,
        instances: matches.map(({ live }) => live),
      };
    }
    if (matches.length === 1) {
      const { live, result } = matches[0];
      return {
        ...(session.live || {}),
        ...live,
        status: live.agent?.status ?? session.live?.status,
        confidence: result.confidence,
        source: "herdr",
      };
    }
    if (ambiguousIds.has(session.id)) {
      return {
        ...(session.live || {}),
        confidence: "ambiguous",
        ambiguous: true,
        terminal: null,
        pane: null,
        agent: null,
      };
    }
    return session.live
      ? { ...session.live, confidence: "inferred" }
      : { confidence: "none", terminal: null, pane: null, agent: null };
  }

  unmatchedRecentAgent() {
    const now = Date.now();
    return AGENTS.some((kind) => {
      const view = this.data.agents?.[kind];
      if (!view) return false;
      return this.liveCandidates(kind).some((live) => {
        const createdMs = Number(live.terminal?.created_ms);
        if (!Number.isFinite(createdMs) || now - createdMs > 10 * 60 * 1000) return false;
        const result = matchLiveSession(live, view.sessions, {
          kind,
          cwdForSession: (item) => this.effectiveCwdFor(item).cwd
            ?? this.fallbackFor(item.agent)?.cwd
            ?? item.cwd,
        });
        return result.confidence === "none" || result.confidence === "ambiguous";
      });
    });
  }

  resumeState(session) {
    // 只使用 helper 检测到的真实二进制；内置 wrapper 不代表对应 Agent 已安装。
    const binary = this.binaries[session.agent] || null;
    return resumeAvailability({
      kind: session.agent,
      session,
      binary,
      fallback: this.fallbackFor(session.agent),
      override: this.overrideFor(session),
      strictResume: this.strictResume,
    });
  }

  // -------------------------------------------------------------------------
  // 标签 / tab 标题 / 挂回
  // -------------------------------------------------------------------------

  tabsWithSpaces() {
    return spaces().flatMap((space) => (space.tabs ?? []).map((tab) => ({ space, tab })));
  }

  tabEntry(tabId) {
    return this.tabsWithSpaces().find(({ tab }) => tab.id === tabId) || null;
  }

  placeholderFor(session) {
    const saved = this.placeholders[session.key];
    if (saved) {
      const entry = this.tabEntry(saved.tabId);
      if (entry) {
        const pane = (saved.terminal && panes().find((item) => item.terminal === saved.terminal))
          || panes().find((item) => item.tab === entry.tab.id && item.terminal)
          || null;
        const terminal = saved.terminal
          ? terminals().find((item) => terminalAddress(item) === saved.terminal)
          : terminals().find((item) => terminalAddress(item) === pane?.terminal);
        return { ...saved, ...entry, pane, terminal: terminal ?? null };
      }
      delete this.placeholders[session.key];
    }

    // 内存 map 不跨热重载；标签能跨。
    const terminal = terminals().find((item) => {
      if (!isLiveTerminal(item)) return false;
      const identity = sessionIdentity(item);
      const kindOk = identity.agent === session.agent
        || (identity.agent === null && session.agent === "codex");
      const placeholder = labelValue(item, "agent.placeholder") === "true"
        || labelValue(item, "codex.placeholder") === "true";
      // 从预览 tab 恢复后，Agent 退出时 resume 命令会写入退出码；此时 shell
      // 仍是本 mod 的占位 tab，可以再次预览/恢复。运行中的 Agent 该标签为空。
      const exitedResume = Boolean(
        labelValue(item, "agent.resume.exit")
        || labelValue(item, "codex.resume.exit"),
      );
      return kindOk && (placeholder || exitedResume) && String(identity.id ?? "") === String(session.id);
    });
    const address = terminalAddress(terminal);
    const pane = address ? panes().find((item) => item.terminal === address) : null;
    const entry = pane ? this.tabEntry(pane.tab) : null;
    if (!entry) return null;
    const savedNext = {
      tabId: entry.tab.id,
      spaceId: entry.space.id,
      cwd: pane.cwd,
      terminal: address,
    };
    this.placeholders[session.key] = savedNext;
    return { ...savedNext, ...entry, pane, terminal };
  }

  // 复用 space 前验证候选 folder 仍存在；失效 space 不重用。
  async spaceFor(cwd) {
    if (!cwd) return null;
    const matches = findDirectorySpaceMatches(spaces(), panes(), terminals(), cwd);
    for (const match of matches) {
      if (await this.folderExists(match.folder || cwd)) return match.space;
    }
    return null;
  }

  async label(terminal, session, tabTitle = null, placeholder = false, cwd = undefined) {
    const address = terminalAddress(terminal);
    if (!address || !isLiveTerminal(terminal)) return;
    const effectiveCwd = cwd !== undefined
      ? cwd
      : (this.effectiveCwdFor(session).cwd ?? session.cwd);
    const labels = agentTerminalLabels({
      kind: session.agent,
      sessionId: session.id,
      cwd: effectiveCwd,
      tabTitle,
      placeholder,
    });
    const unchanged = labels.every((pair) => {
      const separator = pair.indexOf("=");
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      return String(labelValue(terminal, key) ?? "") === value;
    });
    if (unchanged) return;
    await exec(HC_BIN(), ["label", address, ...labels]);
  }

  syncTabTitle(live, session) {
    const tabId = live?.pane?.tab;
    if (!tabId) return null;
    const tab = spaces().flatMap((space) => space.tabs ?? []).find((item) => item.id === tabId);
    const nextTitle = managedTabTitle({
      tabName: tab?.name,
      managedName: labelValue(live.terminal, "agent.tab.title")
        ?? labelValue(live.terminal, "codex.tab.title"),
      chatTitle: tabTitleForSession(session),
    });
    if (nextTitle && tab && nextTitle !== tab.name) run("tab.rename", { id: tabId, name: nextTitle });
    return nextTitle;
  }

  scheduleLiveLabels(cx) {
    if (this.labelsScheduled) return;
    this.labelsScheduled = true;
    cx.timer.after(250, (timerCx) => {
      this.labelsScheduled = false;
      this.syncLiveLabels(timerCx);
    });
  }

  syncLiveLabels(cx) {
    cx.spawn(async (taskCx) => {
      for (const session of this.allSessions()) {
        const live = this.sessionLive(session);
        if (!live.terminal) continue;
        try {
          const tabTitle = this.syncTabTitle(live, session);
          await this.label(live.terminal, session, tabTitle);
        } catch (error) {
          this.pushWarning(`Could not update terminal labels: ${error.message || error}`);
        }
      }
      taskCx.notify();
    });
  }

  // -------------------------------------------------------------------------
  // 选择（只切换侧栏视图，不切换 Herdr 焦点）
  // -------------------------------------------------------------------------

  selectAgent(agent, cx) {
    const view = this.data.agents?.[agent];
    if (!view?.available) return;
    this.selectedAgent = agent;
    this.agentMenuOpen = false;
    storageSet(SAVED_AGENT, agent);
    cx.notify();
  }

  toggleAgentMenu(cx) {
    this.agentMenuOpen = !this.agentMenuOpen;
    cx.notify();
  }

  selectDirectory(agent, key, cx) {
    const view = this.data.agents?.[agent];
    if (!view) return;
    view.selectedDirectoryKey = key;
    this.savedDirs[agent] = key;
    storageSet(savedDirectoryKey(agent), key);
    cx.notify();
  }

  pageFor(agent, key) {
    if (!this.pages[agent]) this.pages[agent] = {};
    return this.pages[agent][key] || 0;
  }

  setPage(agent, key, page, persist = true) {
    if (!this.pages[agent]) this.pages[agent] = {};
    this.pages[agent][key] = page;
    if (persist) storageSet(savedPageKey(agent), JSON.stringify(this.pages[agent]));
  }

  // -------------------------------------------------------------------------
  // 单击 / 双击编排
  // -------------------------------------------------------------------------

  sessionClick(session, event, cx) {
    if (Number(event?.click_count ?? 1) >= 2) {
      const action = this.actions[session.key];
      if (action) {
        action.pendingResume = true;
        cx.notify();
      } else {
        this.resume(session, cx);
      }
      return;
    }
    this.openTab(session, cx);
  }

  openTab(session, cx) {
    if (this.actions[session.key]) return;
    const preview = previewAvailability(session);
    if (!preview.ok) {
      this.pushWarning(preview.reason);
      cx.notify();
      return;
    }
    const existing = this.sessionLive(session);
    if (existing.confidence === "ambiguous" || existing.ambiguous) {
      this.pushWarning(`Multiple ${agentName(session.agent)} sessions match this conversation. Choose one in Herdr; no new tab was opened.`);
      cx.notify();
      return;
    }
    if (existing.terminal) {
      if (existing.pane) this.activate(existing);
      else if (isLiveTerminal(existing.terminal)) run("terminal.keep", { terminal: terminalAddress(existing.terminal), place: "tab" });
      if (isLiveTerminal(existing.terminal)) return;
    }
    const placeholder = this.placeholderFor(session);
    if (placeholder?.terminal && isLiveTerminal(placeholder.terminal)) {
      this.activate(placeholder);
      const exit = labelValue(placeholder.terminal, "agent.preview.exit")
        ?? labelValue(placeholder.terminal, "codex.preview.exit");
      if (exit !== "0") this.startPreview(session, placeholder, cx);
      return;
    }
    this.createPlaceholder(session, cx);
  }

  resume(session, cx) {
    const action = this.actions[session.key];
    if (action) {
      if (action.phase === "restoring") return;
      action.pendingResume = true;
      return;
    }
    if (this.fallbackEditor?.sessionKey === session.key) {
      cx.notify();
      return;
    }
    const availability = this.resumeState(session);
    if (availability.mode === "unavailable") {
      this.pushWarning(availability.reason);
      cx.notify();
      return;
    }
    if (availability.mode === "preview-only") {
      this.openTab(session, cx);
      return;
    }
    const existing = this.sessionLive(session);
    if (existing.confidence === "ambiguous" || existing.ambiguous) {
      this.pushWarning(`Multiple ${agentName(session.agent)} sessions match this conversation. Choose one in Herdr; nothing was resumed.`);
      cx.notify();
      return;
    }
    if (existing.terminal && isLiveTerminal(existing.terminal)) {
      if (existing.pane) this.activate(existing);
      else run("terminal.keep", { terminal: terminalAddress(existing.terminal), place: "tab" });
      return;
    }
    const placeholder = this.placeholderFor(session);
    if (placeholder?.terminal && isLiveTerminal(placeholder.terminal)) {
      this.activate(placeholder);
      this.startPlaceholder(session, placeholder, cx);
      return;
    }

    // 恢复前重新验证目录，避免 stale 缓存或刚刚被删除的 fallback。
    if (this.pendingTargets.has(session.key)) return;
    this.pendingTargets.add(session.key);
    cx.spawn(async (taskCx) => {
      try {
        const target = await this.resolveSessionTarget(session);
        if (target.mode === "preview-only") {
          this.openTab(session, taskCx);
          return;
        }
        if (!target.cwd) {
          this.openFallbackEditor(session, taskCx, target.reason);
          return;
        }
        this.launchSession(session, taskCx, target);
      } catch (error) {
        this.pushWarning(`Could not resolve a resume directory: ${error.message || error}`);
      } finally {
        this.pendingTargets.delete(session.key);
        taskCx.notify();
      }
    });
  }

  launchSession(session, cx, target = null) {
    if (this.actions[session.key]) return;
    const action = this.beginAction(session, "restoring", cx, 15_000);
    cx.spawn(async (taskCx) => {
      try {
        const resolved = target || await this.resolveSessionTarget(session);
        if (this.actions[session.key] !== action) return;
        if (resolved.mode === "preview-only") {
          this.endAction(session, action);
          this.openTab(session, taskCx);
          return;
        }
        if (!resolved.cwd) {
          this.endAction(session, action);
          this.openFallbackEditor(session, taskCx, resolved.reason);
          return;
        }
        const cwd = resolved.cwd;
        action.cwd = cwd;
        action.mode = resolved.mode;
        action.beforeTabs = new Set(this.tabsWithSpaces().map(({ tab }) => tab.id));
        action.beforeTerminals = new Set(terminals().map(terminalAddress));
        const bin = this.binaries[session.agent] || null;
        const argv = resumeArgv(session.agent, {
          bin,
          cwd,
          sessionId: session.id,
          mode: resolved.mode,
        });
        const title = tabTitleForSession(session);
        await this.withSpaceLock(cwd, async () => {
          const space = await this.spaceFor(cwd);
          if (space) {
            run("tab.new", { name: title, space: space.id, folder: cwd, argv });
          } else {
            await this.createSpace(cwd, title, argv, taskCx, session.agent);
          }
        });
        if (this.actions[session.key] !== action) return;
        action.phase = "restoring";
        this.watchLaunch(session, action, taskCx, 0);
      } catch (error) {
        this.endAction(session, action, `Could not start ${agentName(session.agent)}: ${error.message || error}`);
        taskCx.notify();
      }
    });
  }

  watchLaunch(session, action, cx, attempt) {
    if (this.actions[session.key] !== action) return;
    const candidates = terminals().filter((terminal) => {
      const address = terminalAddress(terminal);
      if (action.beforeTerminals?.has(address)) return false;
      const id = resumedSessionId(terminal?.argv ?? [], session.agent);
      if (String(id ?? "") !== String(session.id)) return false;
      return !action.cwd || !terminal.cwd || terminal.cwd === action.cwd;
    });
    if (candidates.length === 1) {
      const terminal = candidates[0];
      cx.spawn(async (taskCx) => {
        try {
          await this.label(terminal, session, tabTitleForSession(session), false, action.cwd);
          const pane = panes().find((item) => item.terminal === terminalAddress(terminal)) || null;
          const entry = pane ? this.tabEntry(pane.tab) : null;
          this.endAction(session, action);
          if (entry && pane) this.activate({ ...entry, pane });
        } catch (error) {
          this.pushWarning(`${agentName(session.agent)} started, but terminal labels could not be saved: ${error.message || error}`);
          this.endAction(session, action);
        }
        taskCx.notify();
      });
      return;
    }
    if (candidates.length > 1) {
      this.endAction(session, action, `Multiple new ${agentName(session.agent)} terminals matched this conversation. Choose one in Herdr; no additional session was started.`);
      cx.notify();
      return;
    }
    if (attempt >= 24) {
      this.endAction(session, action, `Could not confirm the new ${agentName(session.agent)} terminal. Retry is available.`);
      cx.notify();
      return;
    }
    cx.timer.after(250, (timerCx) => this.watchLaunch(session, action, timerCx, attempt + 1));
  }

  createPlaceholder(session, cx) {
    const preview = previewAvailability(session);
    if (!preview.ok) {
      this.pushWarning(preview.reason);
      cx.notify();
      return;
    }
    const action = this.beginAction(session, "opening", cx, 12_000);
    action.beforeTabs = new Set(this.tabsWithSpaces().map(({ tab }) => tab.id));
    action.beforeTerminals = new Set(terminals().map(terminalAddress));
    cx.spawn(async (taskCx) => {
      try {
        // 预览 tab 优先使用 effectiveCwd（含 fallback）；没有可用目录时仍可只读预览。
        const target = await this.resolveSessionTarget(session);
        if (this.actions[session.key] !== action) return;
        const cwd = target.cwd || null;
        action.cwd = cwd;
        const title = tabTitleForSession(session);
        if (!cwd) {
          run("tab.new", { name: title });
        } else {
          await this.withSpaceLock(cwd, async () => {
            const space = await this.spaceFor(cwd);
            if (space) {
              run("tab.new", { name: title, space: space.id, folder: cwd });
            } else {
              await this.createSpace(cwd, title, null, taskCx, session.agent);
            }
          });
        }
        if (this.actions[session.key] !== action) return;
        this.watchOpen(session, action, taskCx, 0);
      } catch (error) {
        this.endAction(session, action, `Could not open a preview tab: ${error.message || error}`);
        taskCx.notify();
      }
    });
  }

  watchOpen(session, action, cx, attempt) {
    if (this.actions[session.key] !== action) return;
    const entries = this.tabsWithSpaces().filter(({ tab }) => !action.beforeTabs.has(tab.id));
    const matches = entries.filter(({ tab }) => panes().some((pane) => pane.tab === tab.id
      && pane.terminal
      && (!action.cwd || pane.cwd === action.cwd)));
    if (matches.length === 1) {
      const entry = matches[0];
      const pane = panes().find((item) => item.tab === entry.tab.id && item.terminal);
      const terminal = terminals().find((item) => terminalAddress(item) === pane?.terminal);
      if (!pane || !terminal) {
        cx.timer.after(150, (timerCx) => this.watchOpen(session, action, timerCx, attempt + 1));
        return;
      }
      const placeholder = { ...entry, pane, terminal, cwd: pane.cwd || action.cwd };
      this.placeholders[session.key] = {
        tabId: entry.tab.id,
        spaceId: entry.space.id,
        cwd: placeholder.cwd,
        terminal: terminalAddress(terminal),
      };
      this.activate(placeholder);
      cx.spawn(async (taskCx) => {
        try {
          await this.label(terminal, session, tabTitleForSession(session), true, placeholder.cwd);
          if (this.actions[session.key] !== action) return;
          const resume = action.pendingResume;
          this.endAction(session, action);
          if (resume) this.startPlaceholder(session, placeholder, taskCx);
          else this.startPreview(session, placeholder, taskCx);
        } catch (error) {
          this.endAction(session, action, `Could not label the preview tab: ${error.message || error}`);
        }
        taskCx.notify();
      });
      return;
    }
    if (matches.length > 1) {
      this.endAction(session, action, "Could not uniquely identify the newly opened tab. No command was sent to any terminal.");
      cx.notify();
      return;
    }
    if (attempt >= 32) {
      this.endAction(session, action, "Could not find the new Herdr tab. Retry is available.");
      cx.notify();
      return;
    }
    cx.timer.after(250, (timerCx) => this.watchOpen(session, action, timerCx, attempt + 1));
  }

  startPlaceholder(session, placeholder, cx) {
    const address = terminalAddress(placeholder?.terminal);
    if (!address || !isLiveTerminal(placeholder.terminal)) {
      this.pushWarning("The preview shell has ended. Open the conversation again to restore it.");
      cx.notify();
      return;
    }
    const availability = this.resumeState(session);
    if (availability.mode === "unavailable") {
      this.pushWarning(availability.reason);
      cx.notify();
      return;
    }
    const action = this.beginAction(session, "restoring", cx, 30_000);
    cx.spawn(async (taskCx) => {
      try {
        const target = await this.resolveSessionTarget(session);
        if (this.actions[session.key] !== action) return;
        if (target.mode === "preview-only") {
          this.endAction(session, action);
          this.openTab(session, taskCx);
          return;
        }
        if (!target.cwd) {
          this.endAction(session, action);
          this.openFallbackEditor(session, taskCx, target.reason);
          return;
        }
        const cwd = target.cwd;
        // placeholder 所在 space 必须就是 effectiveCwd；失效或不同目录时不复用，
        // 改为在目标目录新建 tab，原预览 tab 保留。
        const entry = this.tabEntry(placeholder.tabId);
        const spaceFolder = normalizeFallbackValue(entry?.space?.folder, { home: home() }).cwd;
        const targetFolder = normalizeFallbackValue(cwd, { home: home() }).cwd;
        // space.folder 为空时，退回原有行为：用 placeholder pane 的 cwd 判断。
        const paneFolder = normalizeFallbackValue(placeholder.pane?.cwd, { home: home() }).cwd;
        const folderMatches = Boolean(targetFolder && (
          (spaceFolder && spaceFolder === targetFolder)
          || (!spaceFolder && paneFolder && paneFolder === targetFolder)
        ));
        const reuse = Boolean(folderMatches && await this.folderExists(targetFolder));
        if (!reuse) {
          this.endAction(session, action);
          this.launchSession(session, taskCx, target);
          return;
        }
        action.cwd = cwd;
        action.mode = target.mode;
        action.terminal = address;
        const bin = this.binaries[session.agent] || null;
        const command = resumeShellCommand(session.agent, bin, cwd, session.id, {
          hcBin: HC_BIN(),
          terminal: address,
          mode: target.mode,
        });
        // 标签写入只是元数据，失败不应阻塞恢复；下次刷新会重试。
        try {
          await this.label(placeholder.terminal, session, tabTitleForSession(session), false, cwd);
        } catch (error) {
          this.pushWarning(`Could not update terminal labels: ${error.message || error}`);
        }
        const result = await exec(HC_BIN(), ["send", address, command]);
        if (result.code !== 0) throw new Error((result.stderr || result.stdout || `hc send exited ${result.code}`).trim());
        // Agent 运行期间不再把该 tab 当作占位；退出后由 resume.exit 标签重新识别。
        delete this.placeholders[session.key];
        action.phase = "restoring";
        action.terminal = address;
        this.watchResume(session, placeholder, action, taskCx, 0);
      } catch (error) {
        this.endAction(session, action, `Could not resume ${agentName(session.agent)}: ${error.message || error}`);
        taskCx.notify();
      }
    });
  }

  watchResume(session, placeholder, action, cx, attempt) {
    if (this.actions[session.key] !== action) return;
    const live = this.sessionLive(session);
    if (live.confidence === "ambiguous" || live.ambiguous) {
      this.endAction(session, action, `Multiple ${agentName(session.agent)} sessions match this conversation. Choose one in Herdr; no additional session was started.`);
      cx.notify();
      return;
    }
    if (live.terminal) {
      cx.spawn(async (taskCx) => {
        try {
          await this.label(live.terminal, session, this.syncTabTitle(live, session), false, action.cwd);
          this.endAction(session, action);
          if (live.pane) this.activate(live);
        } catch (error) {
          this.endAction(session, action, `${agentName(session.agent)} resumed, but terminal labels could not be saved: ${error.message || error}`);
        }
        taskCx.notify();
      });
      return;
    }
    const terminal = terminals().find((item) => terminalAddress(item) === action.terminal);
    const exitCode = labelValue(terminal, "agent.resume.exit")
      ?? labelValue(terminal, "codex.resume.exit");
    if (exitCode && exitCode !== "0") {
      this.endAction(session, action, `${agentName(session.agent)} resume exited with status ${exitCode}. Retry is available.`);
      cx.notify();
      return;
    }
    if (!isLiveTerminal(terminal) || attempt >= 100) {
      this.endAction(session, action, `Could not confirm ${agentName(session.agent)} resumed. The original tab is retained; retry is available.`);
      cx.notify();
      return;
    }
    cx.timer.after(250, (timerCx) => this.watchResume(session, placeholder, action, timerCx, attempt + 1));
  }

  startPreview(session, placeholder, cx) {
    const address = terminalAddress(placeholder?.terminal);
    if (!address || !isLiveTerminal(placeholder.terminal)) return;
    const preview = previewAvailability(session);
    if (!preview.ok) {
      this.pushWarning(preview.reason);
      cx.notify();
      return;
    }
    const action = this.beginAction(session, "previewing", cx, 35_000);
    const command = previewShellCommand(HELPER_BIN(), {
      agent: session.agent,
      sessionId: session.id,
      cwd: session.cwd,
      path: session.path,
      title: tabTitleForSession(session),
      hcBin: HC_BIN(),
      terminal: address,
    });
    cx.spawn(async (taskCx) => {
      try {
        if (this.actions[session.key] !== action) return;
        // 标签写入只是元数据，失败不应阻塞预览；下次刷新会重试。
        try {
          await this.label(placeholder.terminal, session, tabTitleForSession(session), true, placeholder.cwd);
        } catch (error) {
          this.pushWarning(`Could not update terminal labels: ${error.message || error}`);
        }
        const result = await exec(HC_BIN(), ["send", address, command]);
        if (result.code !== 0) throw new Error((result.stderr || result.stdout || `hc send exited ${result.code}`).trim());
        action.terminal = address;
        this.watchPreview(session, action, taskCx, 0);
      } catch (error) {
        this.endAction(session, action, `Could not preview ${agentName(session.agent)} history: ${error.message || error}`);
        taskCx.notify();
      }
    });
  }

  watchPreview(session, action, cx, attempt) {
    if (this.actions[session.key] !== action) return;
    const terminal = terminals().find((item) => terminalAddress(item) === action.terminal);
    const exitCode = labelValue(terminal, "agent.preview.exit")
      ?? labelValue(terminal, "codex.preview.exit");
    if (exitCode === "0") {
      this.endAction(session, action);
      cx.notify();
      return;
    }
    if (exitCode && exitCode !== "0") {
      this.endAction(session, action, `History preview exited with status ${exitCode}. Retry is available.`);
      cx.notify();
      return;
    }
    if (!isLiveTerminal(terminal) || attempt >= 120) {
      this.endAction(session, action, "Could not confirm the history preview completed. Retry is available.");
      cx.notify();
      return;
    }
    cx.timer.after(250, (timerCx) => this.watchPreview(session, action, timerCx, attempt + 1));
  }

  // -------------------------------------------------------------------------
  // fallback 编辑器 / 会话菜单 / missing 折叠
  // -------------------------------------------------------------------------

  openFallbackEditor(session, cx, reason = null) {
    if (this.fallbackEditor?.sessionKey === session.key) {
      cx.notify();
      return;
    }
    const info = this.fallbackInfo?.[session.agent];
    const prefill = info?.candidates?.[0] || info?.cwd || "";
    const state = InputState.new({ placeholder: "/absolute/path", value: prefill });
    const editor = {
      sessionKey: session.key,
      agent: session.agent,
      session,
      state,
      onlyAgent: Boolean(storageGet(fallbackAgentKey(session.agent))),
      strict: this.strictResume,
      reason: reason ? String(reason) : null,
      error: null,
      saving: false,
    };
    this.fallbackEditor = editor;
    this.selectedAgent = session.agent;
    storageSet(SAVED_AGENT, session.agent);
    state.on("change", () => {
      if (this.fallbackEditor === editor && editor.error) editor.error = null;
    });
    state.on("submit", (_event, eventCx) => this.saveFallback(eventCx));
    cx.notify();
  }

  toggleFallbackOnlyAgent(cx) {
    if (!this.fallbackEditor) return;
    this.fallbackEditor.onlyAgent = !this.fallbackEditor.onlyAgent;
    cx.notify();
  }

  toggleFallbackStrict(cx) {
    if (!this.fallbackEditor) return;
    this.fallbackEditor.strict = !this.fallbackEditor.strict;
    cx.notify();
  }

  chooseFallbackFolder(cx) {
    const editor = this.fallbackEditor;
    if (!editor) return;
    cx.spawn(async (taskCx) => {
      try {
        const folder = await pickFolder({ prompt: "Choose fallback directory" });
        if (folder && this.fallbackEditor === editor) {
          editor.state.set_value(folder);
          editor.error = null;
        }
      } catch (error) {
        if (this.fallbackEditor === editor) editor.error = String(error.message || error);
      }
      taskCx.notify();
    });
  }

  saveFallback(cx) {
    const editor = this.fallbackEditor;
    if (!editor || editor.saving) return;
    const normalized = normalizeFallbackValue(String(editor.state.value() || "").trim(), { home: home() });
    if (!normalized.ok) {
      editor.error = "Enter an absolute directory path.";
      cx.notify();
      return;
    }
    editor.saving = true;
    cx.spawn(async (taskCx) => {
      try {
        const exists = await this.checkFolderFresh(normalized.cwd);
        if (this.fallbackEditor !== editor) return;
        if (!exists) {
          editor.error = "That directory does not exist.";
          editor.saving = false;
          taskCx.notify();
          return;
        }
        const session = this.allSessions().find((item) => item.key === editor.sessionKey)
          || editor.session;
        this.saveFallbackDirectory(normalized.cwd, {
          onlyAgent: editor.onlyAgent ? editor.agent : null,
          strict: editor.strict,
        });
        this.fallbackInfo[editor.agent] = {
          cwd: normalized.cwd,
          source: editor.onlyAgent ? "agent" : "user",
          valid: true,
          needsUserInput: false,
          warnings: [],
          candidates: [normalized.cwd],
        };
        this.fallbackEditor = null;
        taskCx.notify();
        if (session) this.resume(session, taskCx);
      } catch (error) {
        editor.error = String(error.message || error);
        editor.saving = false;
        taskCx.notify();
      }
    });
  }

  previewFromFallbackEditor(cx) {
    const editor = this.fallbackEditor;
    if (!editor) return;
    const session = this.allSessions().find((item) => item.key === editor.sessionKey)
      || editor.session;
    this.fallbackEditor = null;
    cx.notify();
    if (session) this.openTab(session, cx);
  }

  cancelFallbackEditor(cx) {
    this.fallbackEditor = null;
    cx.notify();
  }

  toggleSessionMenu(session, cx) {
    this.sessionMenuKey = this.sessionMenuKey === session.key ? null : session.key;
    cx.notify();
  }

  closeSessionMenu(cx) {
    this.sessionMenuKey = null;
    cx.notify();
  }

  applyOverridesToData() {
    for (const agent of AGENTS) {
      if (!this.data?.agents?.[agent]) continue;
      this.data.agents[agent] = applySessionCwdOverrides(
        this.data.agents[agent],
        this.validOverrides,
      );
    }
  }

  moveSessionToDirectory(session, cx) {
    this.sessionMenuKey = null;
    cx.spawn(async (taskCx) => {
      try {
        const folder = await pickFolder({ prompt: "Move conversation to directory" });
        if (!folder) {
          taskCx.notify();
          return;
        }
        const normalized = normalizeFallbackValue(folder, { home: home() });
        if (!normalized.ok) {
          this.pushWarning(`Cannot move conversation: ${normalized.reason}`);
          taskCx.notify();
          return;
        }
        if (!await this.checkFolderFresh(normalized.cwd)) {
          this.pushWarning(`Cannot move conversation: ${normalized.cwd} does not exist`);
          taskCx.notify();
          return;
        }
        // 只写本 mod 的本地 override，不迁移 Agent 原始会话数据。
        const record = { cwd: normalized.cwd, updatedAt: Date.now() };
        this.overrides[session.key] = record;
        this.validOverrides[session.key] = record;
        storageSet(SESSION_CWD_OVERRIDES, JSON.stringify(this.overrides));
        this.applyOverridesToData();
      } catch (error) {
        this.pushWarning(`Could not move conversation: ${error.message || error}`);
      }
      taskCx.notify();
    });
  }

  forgetOverride(session, cx) {
    this.sessionMenuKey = null;
    delete this.overrides[session.key];
    delete this.validOverrides[session.key];
    storageSet(SESSION_CWD_OVERRIDES, JSON.stringify(this.overrides));
    this.refresh(cx);
  }

  toggleMissingExpanded(agent, cx) {
    this.missingExpanded[agent] = !this.missingExpanded[agent];
    storageSet(missingExpandedKey(agent), this.missingExpanded[agent] ? "true" : "false");
    cx.notify();
  }

  resumeBadge(session) {
    const availability = this.resumeState(session);
    if (availability.ok) {
      if (availability.mode === "fallback" || availability.mode === "override") {
        return {
          text: `Resume in ${displayNameForFallback(availability.effectiveCwd)}`,
          color: "accent",
        };
      }
      return null;
    }
    if (availability.mode === "preview-only") return { text: "Preview only", color: "dim" };
    if (availability.mode === "fallback-required") return { text: "Set fallback", color: "accent" };
    return { text: "Unavailable", color: "dim" };
  }

  resumeTooltip(session, availability) {
    const original = session.originalCwd ?? session.cwd;
    const originalReason = session.originalUnavailableReason ?? session.unavailableReason;
    if (availability.mode === "fallback" || availability.mode === "override") {
      return `Resume in ${availability.effectiveCwd}. Original directory ${original || "(none)"}`
        + `${originalReason ? ` is unavailable (${originalReason})` : " is not the resume target"}.`;
    }
    if (availability.mode === "fallback-required") {
      return `Original directory ${original || "(none)"} is unavailable. Double-click to choose a fallback directory.`;
    }
    if (availability.mode === "preview-only") {
      return "Strict mode: this conversation can only be previewed.";
    }
    if (availability.mode === "unavailable") {
      return `Unavailable: ${availability.reason}`;
    }
    return `Click: history preview / Double-click: resume ${agentName(session.agent)}`;
  }

  activate(live) {
    if (!live?.pane) return;
    const entry = this.tabEntry(live.pane.tab);
    const space = entry?.space || spaces().find((item) => item.tabs?.some((tab) => tab.id === live.pane.tab));
    if (space) run("space.select", { id: space.id });
    run("tab.select", { id: live.pane.tab });
    run("pane.focus", { pane: live.pane.pane });
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  agentSwitcher(t) {
    const view = this.currentView();
    const count = view?.counts?.total ?? 0;
    return h_flex().id("agent-switcher").flex_none().px(8).py(4).gap(5).items_center().rounded(5)
      .bg(this.agentMenuOpen ? t.hover : t.background)
      .text_color(t.muted)
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => this.toggleAgentMenu(cx))
      .child(div().text_size(12).child(`${agentName(this.selectedAgent)} ${count}`))
      .child(div().text_size(9).text_color(t.dim).child("▾"));
  }

  agentMenu(t) {
    return v_flex().id("agent-menu").w_full().px(12).py(4).gap(2).flex_none()
      .bg(t.raised).border_b(1).border_color(t.border)
      .children(AGENTS.map((agent) => {
        const view = this.data.agents?.[agent];
        const available = Boolean(view?.available);
        const selected = agent === this.selectedAgent;
        const count = view?.counts?.total ?? 0;
        const reason = view?.unavailableReason || "No data";
        return h_flex().id(`agent-option-${agent}`).w_full().min_w(0).h(30).px(8).gap(6).items_center().rounded(5)
          .bg(selected ? t.selected : t.background)
          .text_color(available ? t.foreground : t.dim)
          .when(available, (el) => el.cursor_pointer()
            .hover((style) => style.bg(t.hover))
            .on_click((_event, cx) => this.selectAgent(agent, cx)))
          .child(div().w(12).text_size(11).text_color(selected ? t.accent : t.dim).child(selected ? "✓" : ""))
          .child(div().flex_1().min_w(0).truncate().child(agentName(agent)))
          .child(div().text_size(11).text_color(t.dim).child(String(count)))
          .when(!available, (el) => el.child(div().min_w(0).truncate().text_size(10).text_color(t.dim).child(reason)));
      }))
      .child(h_flex().id("agent-menu-close").w_full().h(26).px(8).items_center().rounded(5)
        .text_size(10).text_color(t.dim).hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => { this.agentMenuOpen = false; cx.notify(); })
        .child("Close"));
  }

  directoryButton(group, active, t) {
    const marker = group.key !== NO_CWD_KEY && group.inaccessible
      ? "no access"
      : group.key !== NO_CWD_KEY && group.missing
        ? "missing"
        : null;
    return h_flex().id(directoryElementId(group.agent, group.key)).w_full().min_w(0).h(34).px(10).gap(6).items_center().rounded(6)
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted)
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .tooltip(group.cwd || "No directory")
      .on_click((_event, cx) => this.selectDirectory(group.agent, group.key, cx))
      .child(div().flex_1().min_w(0).truncate().child(group.displayName))
      .when(Boolean(marker), (el) => el.child(div().text_size(9).text_color(t.dim).child(marker)))
      .child(div().text_size(11).text_color(t.dim).child(String(group.sessions.length)));
  }

  sessionEntry(session, t, cx) {
    const menuOpen = this.sessionMenuKey === session.key;
    return v_flex().w_full().min_w(0).gap(2)
      .child(this.sessionRow(session, t, cx, menuOpen))
      .when(menuOpen, (el) => el.child(this.sessionMenu(session, t, cx)));
  }

  sessionMenu(session, t, cx) {
    const item = (id, label, handler) => h_flex()
      .id(stableElementId("session-menu", `${session.key}:${id}`))
      .w_full().h(26).px(8).items_center().rounded(4).text_size(11).text_color(t.muted)
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click((_event, eventCx) => handler(eventCx))
      .child(label);
    return v_flex().w_full().px(4).py(3).gap(1).rounded(5)
      .bg(t.raised).border(1).border_color(t.border)
      .child(item("preview", "Preview", (eventCx) => {
        this.closeSessionMenu(eventCx);
        this.openTab(session, eventCx);
      }))
      .child(item("resume", "Resume", (eventCx) => {
        this.closeSessionMenu(eventCx);
        this.resume(session, eventCx);
      }))
      .child(item("move", "Move to directory…", (eventCx) => {
        this.moveSessionToDirectory(session, eventCx);
      }))
      .when(Boolean(this.overrides?.[session.key]), (el) => el
        .child(item("forget", "Forget override", (eventCx) => {
          this.forgetOverride(session, eventCx);
        })))
      .child(item("close", "Close menu", (eventCx) => this.closeSessionMenu(eventCx)));
  }

  sessionRow(session, t, cx, menuOpen = false) {
    const live = this.sessionLive(session);
    const liveText = liveLabel(live);
    const statusColor = badgeColor(t, liveText?.color);
    const action = this.actions[session.key];
    const placeholder = live.terminal ? null : this.placeholderFor(session);
    const ambiguous = live.confidence === "ambiguous" || live.ambiguous;
    const failure = this.failures[session.key];
    const actionLabel = action ? `${action.phase[0].toUpperCase()}${action.phase.slice(1)}…` : null;
    const availability = this.resumeState(session);
    const badge = this.resumeBadge(session);
    const tooltip = failure ? `Failed: ${failure}` : this.resumeTooltip(session, availability);
    return v_flex().id(stableElementId("session", session.key)).w_full().min_w(0).px(12).py(8).gap(3).rounded(6)
      .bg(live.terminal || placeholder || menuOpen ? t.raised : t.background).hover((style) => style.bg(t.hover))
      .tooltip(tooltip)
      .on_click((event, eventCx) => this.sessionClick(session, event, eventCx))
      .on_mouse_down("right", (_event, eventCx) => {
        this.sessionMenuKey = session.key;
        eventCx.notify();
      })
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(session.title))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(ago(session.lastActivityAt)))
        .child(div().id(stableElementId("session-more", session.key)).flex_none().px(3)
          .text_size(12).text_color(menuOpen ? t.foreground : t.dim)
          .hover((style) => style.text_color(t.foreground))
          .on_mouse_down("left", (_event, eventCx) => eventCx.stop_propagation())
          .on_click((_event, eventCx) => {
            eventCx.stop_propagation();
            this.toggleSessionMenu(session, eventCx);
          })
          .child("⋯"))
        .when(Boolean(actionLabel), (el) => el
          .child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5).text_color(t.accent).bg(translucentColor(t.accent)).child(actionLabel)))
        .when(Boolean(!action && failure), (el) => el
          .child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5).text_color(t.blocked).bg(translucentColor(t.blocked)).child("Failed")))
        .when(Boolean(!action && !failure && ambiguous), (el) => el
          .child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5).text_color(t.blocked).bg(translucentColor(t.blocked)).child("Confirm")))
        .when(Boolean(!action && !failure && !ambiguous && liveText), (el) => el
          .child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5).text_color(statusColor).bg(translucentColor(statusColor)).child(liveText.text)))
        .when(Boolean(!action && !failure && !ambiguous && !liveText && placeholder), (el) => el
          .child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5).text_color(t.dim).bg(t.hover).child("Preview")))
        .when(Boolean(!action && !failure && !ambiguous && !liveText && !placeholder && badge), (el) => {
          const color = badgeColor(t, badge.color);
          return el.child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5)
            .text_color(color).bg(translucentColor(color)).child(badge.text));
        })
        .when(Boolean(!failure && live.agent?.status === "working"), (el) => el
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))));
  }

  fallbackEditorCard(t, cx) {
    const editor = this.fallbackEditor;
    if (!editor || editor.agent !== this.selectedAgent) return null;
    const option = (id, label, checked, handler) => h_flex()
      .id(id).gap(4).items_center().rounded(4).px(4).py(2).text_size(10).text_color(t.muted)
      .hover((style) => style.bg(t.hover))
      .on_click((_event, eventCx) => handler(eventCx))
      .child(div().text_size(10).text_color(checked ? t.accent : t.dim).child(checked ? "[x]" : "[ ]"))
      .child(label);
    const button = (id, label, handler, primary = false) => h_flex()
      .id(id).h(24).px(9).items_center().rounded(4).text_size(10.5)
      .text_color(primary ? t.accent_foreground ?? t.foreground : t.muted)
      .when(primary, (el) => el.bg(t.accent))
      .when(!primary, (el) => el.bg(t.hover))
      .hover((style) => style.bg(primary ? t.accent : t.selected))
      .on_click((_event, eventCx) => handler(eventCx))
      .child(label);
    return v_flex().id("fallback-editor").w_full().p(8).gap(5).flex_none().rounded(6)
      .bg(t.raised).border(1).border_color(t.input ?? t.border)
      .child(div().text_size(11.5).font_semibold().child("Fallback directory required"))
      .when(Boolean(editor.reason), (el) => el
        .child(div().text_size(10).text_color(t.dim).child(editor.reason)))
      .child(h_flex().gap(4).items_center()
        .child(Input.new(editor.state).flex_1().min_w(0).h(26).px(6).rounded(4)
          .border(1).border_color(t.input ?? t.border).bg(t.background)
          .text_size(11).text_color(t.foreground))
        .child(button("fallback-choose", "Choose…", (eventCx) => this.chooseFallbackFolder(eventCx))))
      .child(h_flex().gap(8).items_center()
        .child(option("fallback-only-agent", "Only this Agent", editor.onlyAgent, (eventCx) => this.toggleFallbackOnlyAgent(eventCx)))
        .child(option("fallback-strict", "Strict: preview only", editor.strict, (eventCx) => this.toggleFallbackStrict(eventCx))))
      .when(Boolean(editor.error), (el) => el
        .child(div().text_size(10).text_color(t.blocked).child(editor.error)))
      .child(h_flex().gap(4).items_center()
        .child(button("fallback-save", editor.saving ? "Saving…" : "Save and resume", (eventCx) => this.saveFallback(eventCx), true))
        .child(button("fallback-preview", "Preview only", (eventCx) => this.previewFromFallbackEditor(eventCx)))
        .child(button("fallback-cancel", "Cancel", (eventCx) => this.cancelFallbackEditor(eventCx))));
  }

  sessionPager(agent, directoryKey, { page, pageCount, start, end, total }, t, cx) {
    const scope = stableElementId("page", `${agent}:${directoryKey}`);
    const button = (id, label, target, enabled) => div().id(id).px(5).py(2).rounded(4)
      .text_color(enabled ? t.muted : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((style) => style.bg(t.hover).text_color(t.foreground))
        .on_click((_event, eventCx) => {
          this.setPage(agent, directoryKey, target);
          eventCx.notify();
        }))
      .child(label);
    return h_flex().w_full().px(8).py(1).gap(4).items_center().flex_none().text_size(10)
      .child(button(`${scope}-prev`, "Prev", page - 1, page > 0))
      .child(div().flex_1().text_color(t.dim).child(`${start + 1}-${end} / ${total}`))
      .child(button(`${scope}-next`, "Next", page + 1, page + 1 < pageCount));
  }

  render(cx) {
    try {
      return this.renderView(cx);
    } catch (error) {
      return this.renderFailure(error, cx);
    }
  }

  renderView(cx) {
    const t = theme();
    const view = this.currentView();
    const agentsInView = view?.directories ?? [];
    const selectedKey = view?.selectedDirectoryKey;
    const group = agentsInView.find((item) => item.key === selectedKey) || agentsInView[0] || null;
    const savedPage = group ? this.pageFor(this.selectedAgent, group.key) : 0;
    const paged = paginate(group?.sessions ?? [], savedPage, CHAT_PAGE_SIZE);
    if (group && this.pageFor(this.selectedAgent, group.key) !== paged.page) {
      this.setPage(this.selectedAgent, group.key, paged.page);
    }
    if (group && group.key !== view.selectedDirectoryKey) view.selectedDirectoryKey = group.key;

    const header = h_flex().w_full().h(42).px(12).gap(8).items_center().flex_none().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().child("Agent History"))
      .child(this.agentSwitcher(t))
      .child(div().id("agent-history-refresh").px(7).py(4).rounded(5).text_size(11)
        .text_color(t.muted)
        .hover((style) => style.bg(t.hover).text_color(t.foreground))
        .on_click((_event, eventCx) => this.refresh(eventCx))
        .child(this.loading ? "..." : "Refresh"));

    const activeDirs = agentsInView.filter((item) => item.key !== NO_CWD_KEY && item.exists && item.accessible);
    const brokenDirs = agentsInView.filter((item) => item.key !== NO_CWD_KEY && !(item.exists && item.accessible));
    const noCwdDirs = agentsInView.filter((item) => item.key === NO_CWD_KEY);
    const selectedMissing = brokenDirs.some((item) => item.key === group?.key);
    const showMissing = Boolean(this.missingExpanded[this.selectedAgent]) || selectedMissing;

    const directoryPane = v_flex().w(132).min_w(0).p(6).gap(2).overflow_y_scrollbar()
      .children(activeDirs.map((item) => this.directoryButton(item, item.key === group?.key, t)))
      .when(brokenDirs.length > 0, (el) => el
        .child(h_flex().id(stableElementId("missing", this.selectedAgent)).w_full().h(26).px(8).gap(4)
          .items_center().rounded(5).text_size(10).text_color(t.dim)
          .hover((style) => style.bg(t.hover).text_color(t.foreground))
          .on_click((_event, eventCx) => this.toggleMissingExpanded(this.selectedAgent, eventCx))
          .child(div().child(`${showMissing ? "▾" : "▸"} Missing (${brokenDirs.length})`))))
      .when(showMissing, (el) => el
        .children(brokenDirs.map((item) => this.directoryButton(item, item.key === group?.key, t))))
      .children(noCwdDirs.map((item) => this.directoryButton(item, item.key === group?.key, t)))
      .when(!agentsInView.length, (el) => el.child(div().px(8).py(8).text_size(11).text_color(t.dim)
        .child(view?.available === false ? "Unavailable" : this.loading ? "Loading…" : "No directories")));

    // 会话列表只渲染标题/时间/状态/分页；当前目录由左侧选中项标明，
    // 不在列表上方重复显示目录名或 cwd 路径行。fallback 编辑器固定在列表顶部。
    const fallbackCard = this.fallbackEditorCard(t, cx);
    let emptyText = null;
    if (view?.available === false) emptyText = `${agentName(this.selectedAgent)} is unavailable${view.unavailableReason ? `: ${view.unavailableReason}` : ""}`;
    else if (!view || view.counts.total === 0) emptyText = this.loading ? "Loading…" : `No ${agentName(this.selectedAgent)} sessions`;
    else if (!group) emptyText = "No sessions in this directory";
    else if (!group.sessions.length) emptyText = fallbackCard ? null : "No sessions in this directory";
    const sessionPane = v_flex().flex_1().min_w(0).min_h(0).p(6).gap(2).overflow_y_scrollbar()
      .when(Boolean(fallbackCard), (el) => el.child(fallbackCard))
      .when(Boolean(group && paged.pageCount > 1), (el) => el
        .child(this.sessionPager(this.selectedAgent, group.key, paged, t, cx)))
      .children(paged.items.map((session) => this.sessionEntry(session, t, cx)))
      .when(Boolean(emptyText), (el) => el.child(div().px(8).py(12).text_size(11).text_color(t.dim).child(emptyText)));

    return v_flex().id("agent-history").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13).overflow_hidden()
      .child(header)
      .when(this.agentMenuOpen, (el) => el.child(this.agentMenu(t)))
      .when(Boolean(this.error), (el) => el.child(div().w_full().px(12).py(6).text_size(11).text_color(t.blocked).truncate().child(this.error)))
      .child(h_flex().flex_1().min_h(0).children([directoryPane, sessionPane]));
  }

  renderFailure(error, cx) {
    const t = theme();
    const message = String(error?.message || error || "Unknown render error");
    return v_flex().id("agent-history").size_full().min_h(0).p(12).gap(8)
      .bg(t.surface).text_color(t.foreground).text_size(13).overflow_hidden()
      .child(div().font_semibold().child("Agent History"))
      .child(div().text_size(11).text_color(t.blocked).child(`Could not render history: ${message}`))
      .child(div().id("agent-history-retry").self_start().px(8).py(4).rounded(5)
        .text_color(t.muted).bg(t.hover).cursor_pointer()
        .on_click((_event, eventCx) => this.refresh(eventCx)).child("Retry"));
  }
}
