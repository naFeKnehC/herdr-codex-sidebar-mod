const timestamp = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const firstLine = (value) => clean(String(value ?? "").split("\n").find((line) => line.trim()) ?? "");
const pathOf = (value) => typeof value === "string" ? value : value?.path || null;
const projectRoots = (project) => (project?.roots ?? []).map(pathOf).filter(Boolean);
const requireSeparator = (path) => path.endsWith("/") || path.endsWith("\\") ? "" : "/";
const norm = (value) => value ? String(value) : "";

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

export function normalizeHistory(projects = [], threads = [], warnings = []) {
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
  const unassigned = [];
  for (const raw of threads) {
    if (!raw?.id || raw.archived) continue;
    const project = projectForThread(raw, normalizedProjects);
    const updatedAt = timestamp(raw.updatedAt);
    const recencyAt = timestamp(raw.recencyAt) || updatedAt;
    const chat = {
      id: String(raw.id),
      title: clean(raw.name) || firstLine(raw.preview).slice(0, 120) || "Untitled chat",
      preview: clean(raw.preview),
      cwd: raw.cwd || null,
      projectId: raw.projectId || project?.id || null,
      updatedAt,
      recencyAt,
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
