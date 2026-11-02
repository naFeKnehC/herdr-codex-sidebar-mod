const timestamp = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const firstLine = (value) => clean(String(value ?? "").split("\n").find((line) => line.trim()) ?? "");
const pathOf = (value) => typeof value === "string" ? value : value?.path || null;
const projectRoots = (project) => (project?.roots ?? []).map(pathOf).filter(Boolean);
const requireSeparator = (path) => path.endsWith("/") || path.endsWith("\\") ? "" : "/";
const norm = (value) => value ? String(value) : "";
const pathKey = (value) => norm(value).replace(/\\/g, "/").replace(/\/$/, "");
const hasRoot = (project, root) => projectRoots(project).some((item) => pathKey(item) === pathKey(root));
const sharesRoot = (project, roots) => roots.some((root) => hasRoot(project, root));
const sameName = (left, right) => clean(left).toLocaleLowerCase() === clean(right).toLocaleLowerCase();
const sameRoots = (project, roots) => {
  const left = projectRoots(project).map(pathKey).sort();
  const right = roots.map(pathKey).sort();
  return left.length === right.length && left.every((root, index) => root === right[index]);
};

function desktopCounterpart(projects, local) {
  const same = projects.filter((project) => sameName(project.name, local.name));
  const overlapping = same.filter((project) => sharesRoot(project, local.roots));
  if (overlapping.length === 1) return overlapping[0];
  if (overlapping.length > 1) return overlapping.find((project) => sameRoots(project, local.roots)) || null;
  if (same.length === 1) return same[0];
  const rooted = projects.filter((project) => sameRoots(project, local.roots));
  return rooted.length === 1 ? rooted[0] : null;
}

function mergeDesktopProjects(projects, desktop) {
  const aliases = {};
  for (const local of desktop?.projects ?? []) {
    const appServerProjectId = desktop?.appServerProjectIds?.[local.id];
    let project = appServerProjectId
      ? projects.find((candidate) => candidate.id === appServerProjectId)
      : null;
    project ||= desktopCounterpart(projects, local);
    if (project) {
      project.name = local.name || project.name;
      project.roots = local.roots.length ? local.roots : project.roots;
      project.position = local.position;
    } else {
      project = {
        id: local.id,
        name: local.name || "Untitled project",
        roots: local.roots,
        position: local.position,
        recencyAt: 0,
        chats: [],
      };
      projects.push(project);
    }
    aliases[local.id] = project.id;
  }
  return aliases;
}

function projectForDesktopThread(thread, projects, desktop, aliases, projectless) {
  if (!desktop) return projectForThread(thread, projects);
  if (projectless.has(thread.id)) return null;
  const localProjectId = desktop.assignments?.[thread.id];
  if (localProjectId) {
    const projectId = aliases[localProjectId] || localProjectId;
    return projects.find((project) => project.id === projectId) || null;
  }
  return projectForThread(thread, projects);
}

export function projectForThread(thread, projects) {
  if (thread.projectId) {
    const assigned = projects.find((p) => p.id === thread.projectId);
    if (assigned) return assigned;
  }
  const cwd = norm(thread.cwd);
  if (!cwd) return null;
  const matches = projects.filter((project) => projectRoots(project).some((root) => {
    const normalized = norm(root);
    return cwd === normalized || cwd.startsWith(`${normalized}${requireSeparator(normalized)}`);
  }));
  return matches.sort((a, b) => Math.max(...projectRoots(b).map(norm).map((r) => r.length), 0) - Math.max(...projectRoots(a).map(norm).map((r) => r.length), 0))[0] || null;
}

export function normalizeHistory(projects = [], threads = [], warnings = [], desktop = null) {
  const normalizedProjects = projects.map((project) => ({
    id: String(project.id),
    name: clean(project.name) || "Untitled project",
    roots: projectRoots(project),
    position: timestamp(project.position),
    recencyAt: timestamp(project.recencyAt),
    chats: [],
  }));
  if (!normalizedProjects.length && projects.length === 0) {
    const roots = new Map();
    for (const thread of threads) {
      const cwd = thread?.cwd;
      if (cwd && !roots.has(cwd)) {
        roots.set(cwd, {
          id: `cwd:${cwd}`,
          name: cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd,
          roots: [cwd],
          position: roots.size,
          recencyAt: timestamp(thread.recencyAt) || timestamp(thread.updatedAt),
          chats: [],
        });
      }
    }
    normalizedProjects.push(...roots.values());
  }
  const desktopAliases = mergeDesktopProjects(normalizedProjects, desktop);
  const projectless = new Set(desktop?.projectless ?? []);
  const unassigned = [];
  for (const raw of threads) {
    if (!raw?.id || raw.archived) continue;
    const project = projectForDesktopThread(raw, normalizedProjects, desktop, desktopAliases, projectless);
    const updatedAt = timestamp(raw.updatedAt);
    const recencyAt = timestamp(raw.recencyAt) || updatedAt;
    const chat = {
      id: String(raw.id),
      title: clean(raw.name) || firstLine(raw.preview).slice(0, 120) || "Untitled chat",
      preview: clean(raw.preview),
      path: raw.path || null,
      cwd: raw.cwd || null,
      projectId: project?.id || raw.projectId || null,
      createdAt: timestamp(raw.createdAt),
      updatedAt,
      recencyAt,
      subagent: Boolean(raw.parentThreadId || raw.threadSource),
      archived: false,
    };
    if (project) project.chats.push(chat);
    else unassigned.push(chat);
  }
  for (const project of normalizedProjects) {
    project.chats.sort((a, b) => b.recencyAt - a.recencyAt || b.updatedAt - a.updatedAt);
    project.recencyAt = project.recencyAt || project.chats[0]?.recencyAt || 0;
  }
  normalizedProjects.sort((a, b) => a.position - b.position || b.recencyAt - a.recencyAt || a.name.localeCompare(b.name));
  unassigned.sort((a, b) => b.recencyAt - a.recencyAt || b.updatedAt - a.updatedAt);
  return { projects: normalizedProjects.filter((project) => project.chats.length || project.roots.length), unassigned, warnings };
}
