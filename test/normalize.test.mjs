import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHistory } from "../mods/herdr-codex-sidebar-mod/helper/lib/normalize.mjs";

const fixtures = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./fixtures/sample.json", import.meta.url), "utf8"));

test("assigns chats by project id and roots", () => {
  const result = normalizeHistory(fixtures.projects, fixtures.threads);
  assert.equal(result.projects.length, 2);
  const onlyChat = result.projects.find((p) => p.name === "onlyChat");
  assert.equal(onlyChat.chats.length, 2);
  assert.deepEqual(onlyChat.chats.map((c) => c.id), ["t-new", "t-old"]);
  assert.equal(result.unassigned.length, 1);
  assert.equal(result.unassigned[0].id, "t-orphan");
});

test("normalizes titles and timestamps", () => {
  const result = normalizeHistory(fixtures.projects, fixtures.threads);
  const chat = result.unassigned[0];
  assert.equal(chat.title, "Preview line");
  assert.equal(chat.recencyAt, 1793200000);
});

test("keeps transcript metadata used to match new sessions", () => {
  const result = normalizeHistory([], [{
    id: "thread-1",
    cwd: "/tmp/project",
    name: "Named",
    path: "/tmp/thread-1.jsonl",
    createdAt: 1793612595,
  }]);
  const chat = result.projects[0].chats[0];
  assert.equal(chat.createdAt, 1793612595);
  assert.equal(chat.path, "/tmp/thread-1.jsonl");
  assert.equal(chat.subagent, false);
});

test("Desktop project assignments win over shared folder roots", () => {
  const projects = [
    { id: "app-test", name: "test", roots: ["/tmp/financial", "/tmp/onlyChat"], position: 0 },
    { id: "app-only", name: "onlyChat", roots: ["/tmp/onlyChat"], position: 1 },
  ];
  const threads = [
    { id: "test-thread", cwd: "/tmp/onlyChat", name: "Inside test" },
    { id: "only-thread", cwd: "/tmp/onlyChat", name: "Inside onlyChat" },
  ];
  const desktop = {
    projects: [
      { id: "local-test", name: "test", roots: ["/tmp/financial", "/tmp/onlyChat"], position: 0 },
      { id: "local-only", name: "onlyChat", roots: ["/tmp/onlyChat"], position: 1 },
    ],
    assignments: {
      "test-thread": "local-test",
      "only-thread": "local-only",
    },
    projectless: [],
  };

  const result = normalizeHistory(projects, threads, [], desktop);
  assert.deepEqual(result.projects.find((project) => project.name === "test").chats.map((chat) => chat.id), ["test-thread"]);
  assert.deepEqual(result.projects.find((project) => project.name === "onlyChat").chats.map((chat) => chat.id), ["only-thread"]);
});

test("explicit Desktop projectless threads do not fall back to cwd matching", () => {
  const projects = [{ id: "app-only", name: "onlyChat", roots: ["/tmp/onlyChat"] }];
  const threads = [{ id: "loose", cwd: "/tmp/onlyChat", name: "Projectless" }];
  const desktop = {
    projects: [{ id: "local-only", name: "onlyChat", roots: ["/tmp/onlyChat"] }],
    assignments: {},
    projectless: ["loose"],
  };

  const result = normalizeHistory(projects, threads, [], desktop);
  assert.equal(result.projects[0].chats.length, 0);
  assert.equal(result.unassigned[0].id, "loose");
});

test("merges a renamed Desktop project through its App Server project mapping", () => {
  const projects = [{
    id: "app-server-project",
    name: "old-name",
    roots: ["/tmp/old-name"],
  }];
  const threads = [{
    id: "thread",
    cwd: "/tmp/old-name",
    name: "Thread",
  }];
  const desktop = {
    projects: [{
      id: "desktop-project",
      name: "new-name",
      roots: ["/tmp/new-name"],
      position: 0,
    }],
    assignments: {
      thread: "desktop-project",
    },
    projectless: [],
    appServerProjectIds: {
      "desktop-project": "app-server-project",
    },
  };

  const result = normalizeHistory(projects, threads, [], desktop);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].id, "app-server-project");
  assert.equal(result.projects[0].name, "new-name");
  assert.deepEqual(result.projects[0].roots, ["/tmp/new-name"]);
  assert.deepEqual(result.projects[0].chats.map((chat) => chat.id), ["thread"]);
});
