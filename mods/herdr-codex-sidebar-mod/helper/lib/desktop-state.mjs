import { readFile } from "node:fs/promises";
import { join } from "node:path";

const clean = (value) => String(value ?? "").trim();

function localProject(id, value, position) {
  return {
    id: clean(id || value?.id),
    name: clean(value?.name),
    roots: (value?.rootPaths ?? []).map(clean).filter(Boolean),
    position,
  };
}

export async function readCodexDesktopState({ codexHome } = {}) {
  if (!codexHome) return null;
  try {
    const state = JSON.parse(await readFile(join(codexHome, ".codex-global-state.json"), "utf8"));
    const projectOrder = Array.isArray(state["project-order"]) ? state["project-order"].map(String) : [];
    const order = new Map(projectOrder.map((id, index) => [id, index]));
    const projects = Object.entries(state["local-projects"] ?? {})
      .map(([id, project], index) => localProject(id, project, order.get(String(id)) ?? projectOrder.length + index))
      .filter((project) => project.id);

    const assignments = {};
    for (const [threadId, assignment] of Object.entries(state["thread-project-assignments"] ?? {})) {
      if (assignment?.projectKind === "local" && assignment.projectId) {
        assignments[threadId] = String(assignment.projectId);
      }
    }

    const hostKey = `local:${String(codexHome).replace(/\/$/, "")}`;
    const appServerProjectIds = state["app-server-project-id-by-legacy-project-id-by-host"]?.[hostKey] ?? {};

    return {
      projects,
      assignments,
      projectless: (state["projectless-thread-ids"] ?? []).map(String),
      appServerProjectIds,
    };
  } catch {
    return null;
  }
}
