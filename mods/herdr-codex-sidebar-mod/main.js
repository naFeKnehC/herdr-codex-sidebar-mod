import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, appHome, exec, home, panes, run, spaces, terminals, theme } from "herdr";
import {
  findProjectSpace,
  launchCwd,
  previewShellCommand,
  resumeShellCommand,
} from "./launch-target.mjs";
import {
  codexTerminalLabels,
  isActiveCodexAgent,
  isCodexAgent,
  managedTabTitle,
  matchLiveChat,
  titleKey,
} from "./live-state.mjs";

const MOD_DIR = () => `${appHome()}/mods/herdr-codex-sidebar-mod`;
const HELPER_BIN = () => `${MOD_DIR()}/bin/codex-history`;
const CODEX_BIN = () => `${MOD_DIR()}/bin/codex`;
const HC_BIN = () => `${MOD_DIR()}/bin/hc`;
const esc = (value) => String(value ?? "").replace(/[\\/:]+/g, "-").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "codex";
const folder = (value) => value ? String(value).replace(/^.*\//, "") : "";
const ago = (seconds) => {
  if (!seconds) return "";
  const delta = Math.max(0, Date.now() / 1000 - Number(seconds));
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.round(delta / 86400)}d`;
  return `${Math.round(delta / (86400 * 30))}mo`;
};
const labelValue = (terminal, key) => {
  const labels = terminal?.labels;
  if (!labels) return null;
  if (Array.isArray(labels)) {
    const pair = labels.find((item) => String(item).startsWith(`${key}=`));
    return pair ? String(pair).slice(key.length + 1) : null;
  }
  return labels[key] ?? null;
};
const terminalAddress = (terminal) => terminal?.address ?? terminal?.id ?? terminal?.name ?? null;

function liveLabel(live) {
  if (!live?.terminal) return null;
  const status = live.agent?.status || live.terminal.status?.state || live.terminal.status;
  if (status === "working") return { text: "Working", color: "working" };
  if (status === "blocked") return { text: "Needs you", color: "blocked" };
  if (status === "done") return { text: "Done", color: "done" };
  if (status === "idle") return { text: "Idle", color: "idle" };
  return { text: "Live", color: "accent" };
}

export default class CodexHistory extends View {
  init(_props, cx) {
    this.data = { projects: [], unassigned: [], warnings: [] };
    this.loading = false;
    this.launching = {};
    this.placeholders = {};
    this.opening = {};
    this.pendingStarts = {};
    this.previewed = {};
    this.previewing = {};
    this.titleSignature = null;
    this.lastUnmatchedRefresh = 0;
    this.selected = localStorage.getItem("herdr-codex-sidebar-mod-project") || null;
    this.refresh(cx);
    cx.timer.every(60_000, (timerCx) => this.refresh(timerCx));
    // `terminals()` and `agents()` are local snapshots. A changed Codex title
    // means its thread summary may have changed, so reload history promptly.
    cx.timer.every(5_000, (timerCx) => {
      const signature = agents().filter(isCodexAgent)
        .map((agent) => `${agent.address}:${titleKey(agent.title)}`)
        .sort()
        .join("\n");
      if (this.titleSignature === null) this.titleSignature = signature;
      else if (signature !== this.titleSignature) {
        this.titleSignature = signature;
        this.refresh(timerCx);
      } else if (this.unmatchedRecentCodex() && Date.now() - this.lastUnmatchedRefresh > 15_000) {
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
      `${appHome()}/data/herdr-codex-sidebar-mod/threads.json`,
    ]);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (taskCx) => {
      try {
        const result = await this.helper();
        const parsed = JSON.parse(result.stdout);
        this.data = parsed;
        this.error = parsed.warnings?.length ? parsed.warnings[parsed.warnings.length - 1] : null;
        this.syncLiveLabels(taskCx);
      } catch (error) {
        this.error = String(error);
      } finally {
        this.loading = false;
        taskCx.notify();
      }
    });
    cx.notify();
  }

  syncLiveLabels(cx) {
    const chats = (this.data.projects ?? []).flatMap((project) => project.chats.map((chat) => ({ project, chat })))
      .concat((this.data.unassigned ?? []).map((chat) => ({ project: { id: null, name: "Unassigned", roots: [] }, chat })));
    cx.spawn(async (taskCx) => {
      for (const { project, chat } of chats) {
        const live = this.sessionForChat(chat, false);
        // A terminal can be reused after a Codex process exits. Always refresh
        // its label for the session currently matched to the live agent.
        if (live.terminal) {
          const tabTitle = this.syncTabTitle(live, chat);
          await this.label(live.terminal, project, chat, tabTitle);
        }
      }
      taskCx.notify();
    });
  }

  syncTabTitle(live, chat) {
    const tabId = live.pane?.tab;
    if (!tabId) return null;
    const tab = spaces().flatMap((space) => space.tabs ?? []).find((item) => item.id === tabId);
    const nextTitle = managedTabTitle({
      tabName: tab?.name,
      managedName: labelValue(live.terminal, "codex.tab.title"),
      chatTitle: chat.title,
    });
    if (nextTitle && tab && nextTitle !== tab.name) run("tab.rename", { id: tabId, name: nextTitle });
    return nextTitle;
  }

  select(project, cx) {
    this.selected = project.id;
    localStorage.setItem("herdr-codex-sidebar-mod-project", this.selected);
    cx.notify();
  }

  running(chat) {
    return this.sessionForChat(chat, true);
  }

  tabsWithSpaces() {
    return spaces().flatMap((space) => (space.tabs ?? []).map((tab) => ({ space, tab })));
  }

  tabEntry(tabId) {
    return this.tabsWithSpaces().find(({ tab }) => tab.id === tabId) || null;
  }

  existingSession(chat) {
    const live = this.running(chat);
    return live.terminal ? live : this.sessionForChat(chat, false);
  }

  unmatchedRecentCodex() {
    const chats = (this.data.projects ?? []).flatMap((project) => project.chats)
      .concat(this.data.unassigned ?? []);
    const allTerminals = terminals();
    const allPanes = panes();
    const now = Date.now();
    return agents().filter(isCodexAgent).some((agent) => {
      const terminal = allTerminals.find((item) => terminalAddress(item) === agent.address);
      const createdMs = Number(terminal?.created_ms);
      if (!terminal || !Number.isFinite(createdMs) || now - createdMs > 10 * 60 * 1000) return false;
      const pane = allPanes.find((item) => item.pane === agent.pane) || null;
      const argv = terminal?.foreground?.argv ?? terminal?.argv ?? [];
      return !matchLiveChat({ agent, terminal, pane, argv }, chats);
    });
  }

  sessionForChat(chat, activeOnly) {
    const allTerminals = terminals();
    const allPanes = panes();
    const chats = (this.data.projects ?? []).flatMap((project) => project.chats)
      .concat(this.data.unassigned ?? []);
    const agentList = agents().filter(activeOnly ? isActiveCodexAgent : isCodexAgent);
    const sessions = agentList.map((agent) => {
      const terminal = allTerminals.find((item) => terminalAddress(item) === agent.address) || null;
      const argv = terminal?.foreground?.argv ?? terminal?.argv ?? [];
      const pane = allPanes.find((item) => item.pane === agent.pane) || null;
      return { agent, terminal, pane, argv };
    }).filter((session) => session.terminal);

    // Match against the full history so a shared title cannot mark several
    // old chats live for one reused Herdr pane.
    const match = sessions.map((session) => ({ session, chat: matchLiveChat(session, chats) }))
      .find(({ chat: matched }) => matched?.id === chat.id);
    return match?.session ?? { terminal: null, pane: null, agent: null };
  }

  placeholderFor(chat) {
    const saved = this.placeholders[chat.id];
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
      delete this.placeholders[chat.id];
    }

    // The in-memory map does not survive a mod reload. The terminal label does.
    const terminal = terminals().find((item) =>
      String(labelValue(item, "codex.thread.id") ?? "") === String(chat.id)
      && labelValue(item, "codex.placeholder") === "true");
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
    this.placeholders[chat.id] = savedNext;
    return { ...savedNext, ...entry, pane, terminal };
  }

  spaceFor(project, cwd) {
    return findProjectSpace(spaces(), panes(), project, cwd, terminals());
  }

  async label(terminal, project, chat, tabTitle = null, placeholder = false) {
    const address = terminalAddress(terminal);
    if (!address) return;
    await exec(HC_BIN(), ["label", address, ...codexTerminalLabels(project, chat, tabTitle, placeholder)]);
  }

  chatClick(project, chat, event, cx) {
    if (Number(event?.click_count ?? 1) >= 2) this.resume(project, chat, cx);
    else this.openTab(project, chat, cx);
  }

  openTab(project, chat, cx) {
    const existing = this.existingSession(chat);
    if (existing.pane) {
      this.activate(existing);
      return;
    }
    if (existing.terminal) {
      run("terminal.keep", { terminal: terminalAddress(existing.terminal), place: "tab" });
      return;
    }
    const placeholder = this.placeholderFor(chat);
    if (placeholder) {
      this.activate(placeholder);
      if (placeholder.terminal && !this.previewed[terminalAddress(placeholder.terminal)]) {
        this.startPreview(project, chat, placeholder, cx);
      }
      return;
    }
    if (this.opening[chat.id]) return;
    this.createPlaceholder(project, chat, cx);
  }

  resume(project, chat, cx) {
    const live = this.running(chat);
    const existing = this.existingSession(chat);
    if (existing.pane) {
      if (existing.terminal) {
        cx.spawn(async (taskCx) => {
          await this.label(existing.terminal, project, chat, this.syncTabTitle(existing, chat));
          taskCx.notify();
        });
      }
      this.activate(existing);
      return;
    }
    if (live.terminal) {
      run("terminal.keep", { terminal: terminalAddress(live.terminal), place: "tab" });
      return;
    }
    const placeholder = this.placeholderFor(chat);
    if (placeholder) {
      this.activate(placeholder);
      this.startPlaceholder(project, chat, placeholder, cx);
      return;
    }
    if (this.opening[chat.id]) {
      // The first click of a double-click may still be creating the tab.
      this.pendingStarts[chat.id] = true;
      return;
    }
    this.launchChat(project, chat, cx);
  }

  launchChat(project, chat, cx) {
    if (this.launching[chat.id]) return;
    const cwd = launchCwd(project, chat, home());
    const argv = [CODEX_BIN(), "resume", "-C", cwd, chat.id];
    const targetSpace = this.spaceFor(project, cwd);
    this.launching[chat.id] = true;
    if (targetSpace) run("tab.new", { name: chat.title, space: targetSpace.id, folder: cwd, argv });
    else run("space.new", { name: project?.name || "Unassigned", folder: cwd, tab: chat.title, argv });
    // Structural commands do not return a terminal id. Match the newly-created
    // terminal once core has reported it, then attach stable thread labels.
    cx.timer.after(400, (timerCx) => this.reconcile(project, chat, cwd, timerCx, 0));
    cx.timer.after(8_000, (timerCx) => {
      if (this.launching[chat.id]) {
        delete this.launching[chat.id];
        timerCx.notify();
      }
    });
  }

  createPlaceholder(project, chat, cx) {
    const cwd = launchCwd(project, chat, home());
    const targetSpace = this.spaceFor(project, cwd);
    const opening = {
      beforeTabs: this.tabsWithSpaces().map(({ tab }) => tab.id),
      cwd,
      name: chat.title,
    };
    this.opening[chat.id] = opening;
    if (targetSpace) run("tab.new", { name: chat.title, space: targetSpace.id, folder: cwd });
    else run("space.new", { name: project?.name || "Unassigned", folder: cwd, tab: chat.title });
    cx.timer.after(100, (timerCx) => this.reconcilePlaceholder(project, chat, opening, timerCx, 0));
  }

  createdTab(opening) {
    const entries = this.tabsWithSpaces();
    return entries.find(({ tab }) => !opening.beforeTabs.includes(tab.id) && tab.name === opening.name)
      || entries.find(({ tab }) => !opening.beforeTabs.includes(tab.id))
      || null;
  }

  reconcilePlaceholder(project, chat, opening, cx, attempt) {
    if (this.opening[chat.id] !== opening) return;
    const saved = this.placeholderFor(chat);
    const entry = saved ? this.tabEntry(saved.tabId) : this.createdTab(opening);
    if (entry) {
      const pane = saved?.pane
        || panes().find((item) => item.tab === entry.tab.id && item.terminal)
        || null;
      const terminal = saved?.terminal
        || (pane ? terminals().find((item) => terminalAddress(item) === pane.terminal) : null)
        || null;
      this.placeholders[chat.id] = {
        tabId: entry.tab.id,
        spaceId: entry.space.id,
        cwd: pane?.cwd || opening.cwd,
        terminal: terminalAddress(terminal),
      };
      opening.tabId = entry.tab.id;
      if (pane) this.activate({ ...entry, pane });
      if (terminal) {
        delete this.opening[chat.id];
        cx.spawn(async (taskCx) => {
          await this.label(terminal, project, chat, chat.title, true);
          if (this.pendingStarts[chat.id]) {
            delete this.pendingStarts[chat.id];
            this.resume(project, chat, taskCx);
          } else {
            this.startPreview(project, chat, this.placeholderFor(chat), taskCx);
          }
          taskCx.notify();
        });
        return;
      }
    }
    if (attempt < 24) {
      cx.timer.after(250, (timerCx) => this.reconcilePlaceholder(project, chat, opening, timerCx, attempt + 1));
    } else {
      delete this.opening[chat.id];
      delete this.pendingStarts[chat.id];
      this.error = "Could not find the new Herdr tab";
      cx.notify();
    }
  }

  startPlaceholder(project, chat, placeholder, cx) {
    const address = terminalAddress(placeholder.terminal);
    if (!address) {
      this.pendingStarts[chat.id] = true;
      return;
    }
    if (this.launching[chat.id]) return;
    if (this.previewing[chat.id]) {
      this.pendingStarts[chat.id] = true;
      return;
    }
    if (agents().some((agent) => agent.address === address && isCodexAgent(agent))) {
      cx.spawn(async (taskCx) => {
        await this.label(placeholder.terminal, project, chat, this.syncTabTitle(placeholder, chat), false);
        taskCx.notify();
      });
      return;
    }
    const cwd = placeholder.cwd || launchCwd(project, chat, home());
    const command = resumeShellCommand(cwd, chat.id);
    this.launching[chat.id] = true;
    cx.spawn(async (taskCx) => {
      try {
        const result = await exec(HC_BIN(), ["send", address, command]);
        if (result.code !== 0) {
          throw new Error((result.stderr || result.stdout || `hc send exited ${result.code}`).trim());
        }
        await this.label(placeholder.terminal, project, chat, chat.title, false);
        this.reconcile(project, chat, cwd, taskCx, 0);
      } catch (error) {
        delete this.launching[chat.id];
        this.error = `Could not resume Codex: ${error.message || error}`;
        taskCx.notify();
      }
    });
  }

  startPreview(project, chat, placeholder, cx) {
    const address = terminalAddress(placeholder?.terminal);
    if (!address || this.previewed[address] || this.previewing[chat.id] || this.pendingStarts[chat.id]) return;
    if (agents().some((agent) => agent.address === address && isCodexAgent(agent))) return;
    const cwd = placeholder.cwd || launchCwd(project, chat, home());
    const command = previewShellCommand(HELPER_BIN(), cwd, chat.id, {
      path: chat.path,
      title: chat.title,
    });
    this.previewing[chat.id] = true;
    cx.spawn(async (taskCx) => {
      try {
        const result = await exec(HC_BIN(), ["send", address, command]);
        if (result.code !== 0) {
          throw new Error((result.stderr || result.stdout || `hc send exited ${result.code}`).trim());
        }
        this.watchPreview(project, chat, address, taskCx, 0, Date.now());
      } catch (error) {
        delete this.previewing[chat.id];
        this.error = `Could not preview Codex history: ${error.message || error}`;
        if (this.pendingStarts[chat.id]) {
          delete this.pendingStarts[chat.id];
          this.resume(project, chat, taskCx);
        }
        taskCx.notify();
      }
    });
  }

  watchPreview(project, chat, address, cx, attempt, startedAt) {
    const terminal = terminals().find((item) => terminalAddress(item) === address);
    const argv = terminal?.foreground?.argv ?? [];
    const running = argv.includes("preview")
      && argv.some((part) => String(part).includes("codex-history"));
    const elapsed = Date.now() - startedAt;
    if (running || elapsed < 600) {
      if (attempt < 60) {
        cx.timer.after(100, (timerCx) => this.watchPreview(project, chat, address, timerCx, attempt + 1, startedAt));
        return;
      }
    }
    delete this.previewing[chat.id];
    this.previewed[address] = true;
    if (this.pendingStarts[chat.id]) {
      delete this.pendingStarts[chat.id];
      this.resume(project, chat, cx);
    }
    cx.notify();
  }

  activate(live) {
    const pane = live.pane;
    if (!pane) return;
    const space = live.space || spaces().find((item) => item.tabs?.some((tab) => tab.id === pane.tab));
    if (space) run("space.select", { id: space.id });
    run("tab.select", { id: pane.tab });
    run("pane.focus", { pane: pane.pane });
  }

  reconcile(project, chat, cwd, cx, attempt) {
    const live = this.running(chat);
    if (live.terminal) {
      delete this.launching[chat.id];
      cx.spawn(async (taskCx) => {
        await this.label(live.terminal, project, chat, this.syncTabTitle(live, chat));
        taskCx.notify();
      });
      if (live.pane) run("pane.focus", { pane: live.pane.pane });
      return;
    }
    const candidate = terminals().find((terminal) => {
      const argv = terminal.argv ?? [];
      return Array.isArray(argv) && argv.includes(chat.id) && (!cwd || terminal.cwd === cwd);
    });
    if (candidate) {
      delete this.launching[chat.id];
      cx.spawn(async (taskCx) => { await this.label(candidate, project, chat, chat.title); taskCx.notify(); });
      return;
    }
    if (attempt < 12) cx.timer.after(300, (timerCx) => this.reconcile(project, chat, cwd, timerCx, attempt + 1));
    else delete this.launching[chat.id];
  }

  projectButton(project, active, t) {
    return h_flex().id(`project-${project.id}`).w_full().min_w(0).h(34).px(10).gap(8).items_center().rounded(6)
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted).hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => this.select(project, cx))
      .child(svg(active ? "mods/herdr-codex-sidebar-mod/chevron-down.svg" : "mods/herdr-codex-sidebar-mod/chevron-right.svg").size(12).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(project.name))
      .child(div().text_size(11).text_color(t.dim).child(String(project.chats.length)));
  }

  unassignedButton(active, t) {
    return h_flex().id("project-unassigned").w_full().min_w(0).h(34).px(10).gap(8).items_center().rounded(6)
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted).hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => {
        this.selected = "__unassigned__";
        localStorage.setItem("herdr-codex-sidebar-mod-project", this.selected);
        cx.notify();
      })
      .child(svg(active ? "mods/herdr-codex-sidebar-mod/chevron-down.svg" : "mods/herdr-codex-sidebar-mod/chevron-right.svg").size(12).flex_none())
      .child(div().flex_1().min_w(0).truncate().child("Unassigned"))
      .child(div().text_size(11).text_color(t.dim).child(String(this.data.unassigned?.length ?? 0)));
  }

  chatRow(project, chat, t) {
    const active = this.running(chat);
    const session = active.terminal ? active : this.sessionForChat(chat, false);
    const liveText = liveLabel(session);
    const placeholder = session.terminal ? null : this.placeholderFor(chat);
    return v_flex().id(`chat-${chat.id}`).w_full().min_w(0).px(12).py(8).gap(3).rounded(6)
      .bg(session.terminal || placeholder ? t.raised : t.background).hover((style) => style.bg(t.hover))
      .tooltip("Click: history preview / Double-click: resume Codex")
      .on_click((event, cx) => this.chatClick(project, chat, event, cx))
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(chat.title))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(ago(chat.recencyAt)))
        .when(Boolean(session.terminal), (el) => el
          .child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5).text_color(t[liveText.color]).bg(t[liveText.color] + "18").child(liveText.text)))
        .when(Boolean(placeholder), (el) => el
          .child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5).text_color(t.dim).bg(t.hover).child("Preview")))
        .when(Boolean(session.agent?.status === "working"), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))));
  }

  render(cx) {
    const t = theme();
    const projects = this.data.projects ?? [];
    const selected = this.selected === "__unassigned__" ? null : (projects.find((project) => project.id === this.selected) || projects[0] || null);
    if (selected && this.selected !== selected.id) this.selected = selected.id;
    const unassigned = this.selected === "__unassigned__";
    const chats = unassigned ? (this.data.unassigned ?? []) : (selected?.chats ?? []);
    const liveCount = chats.filter((chat) => this.running(chat).terminal).length;
    return v_flex().id("codex-history").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13).overflow_hidden()
      .child(h_flex().w_full().h(42).px(12).gap(8).items_center().flex_none().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child("codex desktop"))
        .child(div().text_size(11).text_color(t.dim).child(liveCount ? `${liveCount} live` : ""))
        .child(div().id("codex-history-refresh").px(7).py(4).rounded(5).text_color(t.muted).hover((style) => style.bg(t.hover).text_color(t.foreground)).on_click((_event, eventCx) => this.refresh(eventCx)).child(this.loading ? "..." : "Refresh")))
      .when(Boolean(this.error), (el) => el.child(div().w_full().px(12).py(6).text_size(11).text_color(t.blocked).truncate().child(this.error)))
      .child(h_flex().flex_1().min_h(0).children([
        v_flex().w(132).min_w(0).p(6).gap(2).overflow_y_scrollbar()
          .children(projects.map((project) => this.projectButton(project, selected?.id === project.id, t)))
          .child(this.unassignedButton(unassigned, t)),
        v_flex().flex_1().min_w(0).min_h(0).p(6).gap(2).overflow_y_scrollbar()
          .child(selected || unassigned ? h_flex().w_full().px(8).py(5).gap(6).items_center().flex_none()
            .child(div().flex_1().min_w(0).truncate().font_medium().child(unassigned ? "Unassigned" : selected.name))
            .child(div().truncate().text_size(10).text_color(t.dim).child(folder(selected?.roots?.[0]))) : div().px(8).py(8).text_color(t.dim).child("No Codex projects"))
          .children(chats.map((chat) => this.chatRow(selected || { id: null, name: "Unassigned", roots: [] }, chat, t)))
          .when(Boolean((selected || unassigned) && !chats.length), (el) => el.child(div().px(8).py(12).text_color(t.dim).child("No chats in this project"))),
      ]));
  }
}
