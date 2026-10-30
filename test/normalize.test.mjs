import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHistory } from "../scripts/lib/normalize.mjs";

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
