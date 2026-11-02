const pathKey = (value) => {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || (String(value ?? "").trim().startsWith("/") ? "/" : "");
};

const isWithin = (path, root) => {
  const target = pathKey(path);
  const base = pathKey(root);
  if (!target || !base) return false;
  return target === base || (base === "/" ? target.startsWith("/") : target.startsWith(`${base}/`));
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

export function launchCwd(project, chat, fallback = null) {
  const roots = (project?.roots ?? []).map((root) => String(root ?? "").trim()).filter(Boolean);
  const cwd = String(chat?.cwd ?? "").trim();
  if (cwd && roots.some((root) => isWithin(cwd, root))) return cwd;
  return roots[0] || cwd || fallback;
}

export function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
}

export function resumeShellCommand(cwd, threadId) {
  const dir = shellQuote(cwd);
  return `cd ${dir} && codex resume ${shellQuote(threadId)}`;
}

export function previewShellCommand(helper, cwd, threadId, { path = null, title = null } = {}) {
  const args = [shellQuote(helper), "preview", "--thread", shellQuote(threadId), "--cwd", shellQuote(cwd)];
  if (path) args.push("--path", shellQuote(path));
  if (title) args.push("--title", shellQuote(title));
  return `cd ${shellQuote(cwd)} && ${args.join(" ")}`;
}

export function findProjectSpace(allSpaces, allPanes, project, cwd, allTerminals = []) {
  const roots = (project?.roots ?? []).filter(Boolean);
  const inProject = (path) => roots.some((root) => isWithin(path, root));
  const candidates = allSpaces.filter(Boolean);
  if (!project?.id && roots.length === 0) {
    const unassigned = candidates.filter((space) => space.name === "Unassigned");
    const target = pathKey(cwd);
    const byFolder = unassigned.find((space) => target && pathKey(space.folder) === target);
    if (byFolder) return byFolder;
    const byPane = unassigned.find((space) => {
      const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
      return target && allPanes.some((pane) => tabs.has(pane.tab) && pathKey(pane.cwd) === target);
    });
    return byPane || unassigned[0] || null;
  }

  // A project root is a stronger ownership signal than an old thread cwd.
  const byFolder = candidates.find((space) => space.folder && inProject(space.folder));
  if (byFolder) return byFolder;

  if (project?.id) {
    const byLabel = candidates.find((space) => {
      const addresses = new Set((space.tabs ?? []).flatMap((tab) => (tab.terminals ?? [])
        .map((terminal) => typeof terminal === "string" ? terminal : terminal.terminal)));
      return allTerminals.some((terminal) => addresses.has(terminal?.address)
        && String(labelValue(terminal, "codex.project.id")) === String(project.id));
    });
    if (byLabel) return byLabel;
  }

  const sameName = candidates.filter((space) => space.name && space.name === project?.name);
  if (sameName.length === 1) return sameName[0];

  const byLivePane = candidates.find((space) => {
    const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
    return allPanes.some((pane) => tabs.has(pane.tab) && pane.cwd && inProject(pane.cwd));
  });
  if (byLivePane) return byLivePane;

  if (!cwd) return null;
  const target = pathKey(cwd);
  const byCwd = candidates.find((space) => pathKey(space.folder) === target);
  if (byCwd) return byCwd;

  return candidates.find((space) => {
    const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
    return allPanes.some((pane) => tabs.has(pane.tab) && pathKey(pane.cwd) === target);
  }) || null;
}
