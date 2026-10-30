import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, appHome, exec, home, panes, run, spaces, terminals, theme } from "herdr";
import { isActiveCodexAgent, isCodexAgent, matchLiveChat } from "./live-state.mjs";

const HELPER_BIN = () => `${appHome()}/data/codex-history/bin/codex-history`;
const CODEX_BIN = () => `${appHome()}/data/codex-history/bin/codex`;
const HC_BIN = () => `${appHome()}/data/codex-history/bin/hc`;
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
const pathKey = (value) => String(value ?? "").replace(/\\/g, "/").replace(/\/$/, "");

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
    this.selected = localStorage.getItem("codex-history-project") || null;
    this.refresh(cx);
    cx.timer.every(60_000, (timerCx) => this.refresh(timerCx));
    // `terminals()` and `agents()` are local snapshots; refresh their badges
    // without spawning another Codex App Server process.
    cx.timer.every(5_000, (timerCx) => timerCx.notify());
  }

  async helper() {
    return exec(HELPER_BIN(), ["sync", "--json"]);
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
        const live = this.running(chat);
        // A terminal can be reused after a Codex process exits. Always refresh
        // its label for the session currently matched to the live agent.
        if (live.terminal) await this.label(live.terminal, project, chat);
      }
      taskCx.notify();
    });
  }

  select(project, cx) {
    this.selected = project.id;
    localStorage.setItem("codex-history-project", this.selected);
    cx.notify();
  }

  running(chat) {
    return this.sessionForChat(chat, true);
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

  spaceFor(project, cwd) {
    const roots = project.roots ?? [];
    const rootsMatch = (path) => roots.some((root) => pathKey(path) === pathKey(root) || pathKey(path).startsWith(`${pathKey(root)}/`));
    return spaces().find((space) => {
      const tabIds = new Set((space.tabs ?? []).map((tab) => tab.id));
      const liveFolders = panes().filter((pane) => tabIds.has(pane.tab)).map((pane) => pane.cwd).filter(Boolean);
      return roots.includes(space.folder) || (cwd && pathKey(space.folder) === pathKey(cwd))
        || liveFolders.some((path) => rootsMatch(path) || (cwd && pathKey(path) === pathKey(cwd)));
    }) || null;
  }

  async label(terminal, project, chat) {
    const address = terminalAddress(terminal);
    if (!address) return;
    const labels = [`codex.thread.id=${chat.id}`, "codex.managed=true"];
    if (project.id) labels.push(`codex.project.id=${project.id}`);
    await exec(HC_BIN(), ["label", address, ...labels]);
  }

  resume(project, chat, cx) {
    const live = this.running(chat);
    const existing = live.terminal ? live : this.sessionForChat(chat, false);
    if (existing.pane) {
      if (existing.terminal) {
        cx.spawn(async (taskCx) => { await this.label(existing.terminal, project, chat); taskCx.notify(); });
      }
      this.activate(existing);
      return;
    }
    if (live.terminal) {
      run("terminal.keep", { terminal: terminalAddress(live.terminal), place: "tab" });
      return;
    }
    if (this.launching[chat.id]) return;
    const cwd = chat.cwd || project.roots?.[0] || home();
    const argv = [CODEX_BIN(), "resume", chat.id];
    const targetSpace = this.spaceFor(project, cwd);
    this.launching[chat.id] = true;
    if (targetSpace) run("tab.new", { name: chat.title, space: targetSpace.id, folder: cwd, argv });
    else run("space.new", { name: project.name, folder: cwd, tab: chat.title, argv });
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

  activate(live) {
    const pane = live.pane;
    if (!pane) return;
    const space = spaces().find((item) => item.tabs?.some((tab) => tab.id === pane.tab));
    if (space) run("space.select", { id: space.id });
    run("tab.select", { id: pane.tab });
    run("pane.focus", { pane: pane.pane });
  }

  reconcile(project, chat, cwd, cx, attempt) {
    const live = this.running(chat);
    if (live.terminal) {
      delete this.launching[chat.id];
      cx.spawn(async (taskCx) => { await this.label(live.terminal, project, chat); taskCx.notify(); });
      if (live.pane) run("pane.focus", { pane: live.pane.pane });
      return;
    }
    const candidate = terminals().find((terminal) => {
      const argv = terminal.argv ?? [];
      return Array.isArray(argv) && argv.includes(chat.id) && (!cwd || terminal.cwd === cwd);
    });
    if (candidate) {
      delete this.launching[chat.id];
      cx.spawn(async (taskCx) => { await this.label(candidate, project, chat); taskCx.notify(); });
      return;
    }
    if (attempt < 12) cx.timer.after(300, (timerCx) => this.reconcile(project, chat, cwd, timerCx, attempt + 1));
    else delete this.launching[chat.id];
  }

  projectButton(project, active, t) {
    return h_flex().id(`project-${project.id}`).w_full().min_w(0).h(34).px(10).gap(8).items_center().rounded(6)
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted).hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => this.select(project, cx))
      .child(svg(active ? "mods/codex-history/chevron-down.svg" : "mods/codex-history/chevron-right.svg").size(12).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(project.name))
      .child(div().text_size(11).text_color(t.dim).child(String(project.chats.length)));
  }

  unassignedButton(active, t) {
    return h_flex().id("project-unassigned").w_full().min_w(0).h(34).px(10).gap(8).items_center().rounded(6)
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted).hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => {
        this.selected = "__unassigned__";
        localStorage.setItem("codex-history-project", this.selected);
        cx.notify();
      })
      .child(svg(active ? "mods/codex-history/chevron-down.svg" : "mods/codex-history/chevron-right.svg").size(12).flex_none())
      .child(div().flex_1().min_w(0).truncate().child("Unassigned"))
      .child(div().text_size(11).text_color(t.dim).child(String(this.data.unassigned?.length ?? 0)));
  }

  chatRow(project, chat, t) {
    const live = this.running(chat);
    const liveText = liveLabel(live);
    return v_flex().id(`chat-${chat.id}`).w_full().min_w(0).px(12).py(8).gap(3).rounded(6)
      .bg(live.terminal ? t.raised : t.background).hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => this.resume(project, chat, cx))
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(chat.title))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(ago(chat.recencyAt)))
        .when(Boolean(live.terminal), (el) => el
          .child(div().flex_none().px(5).py(2).rounded(4).text_size(9.5).text_color(t[liveText.color]).bg(t[liveText.color] + "18").child(liveText.text)))
        .when(Boolean(live.agent?.status === "working"), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))));
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
        .child(div().flex_1().font_semibold().child("Codex History"))
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
