import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const {
  applyTerminalEventToSessions,
  replaceTerminalSessionsForProject,
  terminalSessionBelongsToProject,
} = loader.loadModule("src/lib/terminal/sessionStore.ts");

function terminal(id, projectPathKey, createdAt, title = id) {
  return {
    id,
    projectPathKey,
    cwd: projectPathKey,
    shell: "zsh",
    title,
    cols: 80,
    rows: 24,
    createdAt,
    updatedAt: createdAt,
    running: true,
  };
}

test("terminal project replacement only touches the requested project", () => {
  const current = [
    terminal("terminal-a-1", "/workspace/a", 1),
    terminal("terminal-b-1", "/workspace/b", 2),
  ];

  const next = replaceTerminalSessionsForProject(current, " /workspace/a ", [
    terminal("terminal-a-2", "/workspace/a", 3),
    terminal("terminal-b-2", "/workspace/b", 4),
  ]);

  assert.deepEqual(
    next.map((session) => session.id),
    ["terminal-a-2", "terminal-b-1"],
  );
});

test("terminal event merge preserves refreshed sessions and adds created terminals", () => {
  const bootstrapped = replaceTerminalSessionsForProject([], "/workspace/project", [
    terminal("terminal-1", "/workspace/project", 1, "Terminal 1"),
    terminal("terminal-2", "/workspace/project", 2, "Terminal 2"),
    terminal("terminal-3", "/workspace/project", 3, "Terminal 3"),
  ]);

  const withCreated = applyTerminalEventToSessions(bootstrapped, {
    kind: "created",
    sessionId: "terminal-4",
    projectPathKey: "/workspace/project",
    session: terminal("terminal-4", "/workspace/project", 4, "Terminal 4"),
  });

  assert.deepEqual(
    withCreated.map((session) => session.title),
    ["Terminal 1", "Terminal 2", "Terminal 3", "Terminal 4"],
  );
});

test("terminal project matching falls back to cwd when project key is missing", () => {
  assert.equal(
    terminalSessionBelongsToProject(
      {
        ...terminal("terminal-1", "", 1),
        cwd: "/workspace/project",
      },
      "/workspace/project",
    ),
    true,
  );
});
