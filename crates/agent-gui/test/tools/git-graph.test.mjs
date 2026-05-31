import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const guiRoot = fileURLToPath(new URL("../..", import.meta.url));
const graphModules = {
  gui: createTsModuleLoader().loadModule("src/lib/git/gitGraph.ts"),
  web: createTsModuleLoader({
    rootDir: path.resolve(guiRoot, "..", "agent-gateway", "web"),
  }).loadModule("src/lib/git/gitGraph.ts"),
};

function simplifyRows(rows) {
  return rows.map((row) => ({
    sha: row.sha,
    parents: row.parents,
    commitCol: row.commitCol,
    commitColor: row.commitColor,
    inputLanes: row.inputLanes,
    outputLanes: row.outputLanes,
    isHead: row.isHead,
    isMerge: row.isMerge,
  }));
}

for (const [surface, graph] of Object.entries(graphModules)) {
  test(`${surface} git graph uses VS Code source control graph colors`, () => {
    assert.deepEqual(graph.GRAPH_COLORS, [
      "#ffb000",
      "#dc267f",
      "#994f00",
      "#40b0a6",
      "#b66dff",
    ]);
  });

  test(`${surface} git graph exposes VS Code ref semantic colors`, () => {
    assert.deepEqual(graph.GRAPH_REF_COLORS, {
      local: "var(--git-review-graph-ref-local)",
      remote: "var(--git-review-graph-ref-remote)",
      base: "var(--git-review-graph-ref-base)",
    });
  });

  test(`${surface} git graph builds linear swimlanes`, () => {
    const result = graph.computeGitGraph([
      { sha: "c", parents: ["b"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);

    assert.equal(result.maxCols, 1);
    assert.deepEqual(simplifyRows(result.rows), [
      {
        sha: "c",
        parents: ["b"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [],
        outputLanes: [{ id: "b", color: 0 }],
        isHead: true,
        isMerge: false,
      },
      {
        sha: "b",
        parents: ["a"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [{ id: "b", color: 0 }],
        outputLanes: [{ id: "a", color: 0 }],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "a",
        parents: [],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [{ id: "a", color: 0 }],
        outputLanes: [],
        isHead: false,
        isMerge: false,
      },
    ]);
  });

  test(`${surface} git graph preserves merge branch lanes and base joins`, () => {
    const result = graph.computeGitGraph([
      { sha: "m", parents: ["a", "b"] },
      { sha: "a", parents: ["r"] },
      { sha: "b", parents: ["r"] },
      { sha: "r", parents: [] },
    ]);

    assert.equal(result.maxCols, 2);
    assert.deepEqual(simplifyRows(result.rows), [
      {
        sha: "m",
        parents: ["a", "b"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [],
        outputLanes: [
          { id: "a", color: 0 },
          { id: "b", color: 1 },
        ],
        isHead: true,
        isMerge: true,
      },
      {
        sha: "a",
        parents: ["r"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [
          { id: "a", color: 0 },
          { id: "b", color: 1 },
        ],
        outputLanes: [
          { id: "r", color: 0 },
          { id: "b", color: 1 },
        ],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "b",
        parents: ["r"],
        commitCol: 1,
        commitColor: 1,
        inputLanes: [
          { id: "r", color: 0 },
          { id: "b", color: 1 },
        ],
        outputLanes: [
          { id: "r", color: 0 },
          { id: "r", color: 1 },
        ],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "r",
        parents: [],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [
          { id: "r", color: 0 },
          { id: "r", color: 1 },
        ],
        outputLanes: [],
        isHead: false,
        isMerge: false,
      },
    ]);
  });

  test(`${surface} git graph colors local and remote refs like VS Code`, () => {
    const result = graph.computeGitGraph(
      [
        { sha: "tip", parents: ["merge", "side"] },
        { sha: "merge", parents: ["base"], refs: ["main"] },
        { sha: "side", parents: ["base"], refs: ["origin/side"] },
        { sha: "base", parents: [] },
      ],
      {
        currentRef: "main",
        remoteRef: "origin/side",
        remoteName: "origin",
      },
    );

    assert.deepEqual(simplifyRows(result.rows), [
      {
        sha: "tip",
        parents: ["merge", "side"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [],
        outputLanes: [
          { id: "merge", color: 0 },
          { id: "side", color: graph.GRAPH_REF_COLORS.remote },
        ],
        isHead: true,
        isMerge: true,
      },
      {
        sha: "merge",
        parents: ["base"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [
          { id: "merge", color: 0 },
          { id: "side", color: graph.GRAPH_REF_COLORS.remote },
        ],
        outputLanes: [
          { id: "base", color: graph.GRAPH_REF_COLORS.local },
          { id: "side", color: graph.GRAPH_REF_COLORS.remote },
        ],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "side",
        parents: ["base"],
        commitCol: 1,
        commitColor: graph.GRAPH_REF_COLORS.remote,
        inputLanes: [
          { id: "base", color: graph.GRAPH_REF_COLORS.local },
          { id: "side", color: graph.GRAPH_REF_COLORS.remote },
        ],
        outputLanes: [
          { id: "base", color: graph.GRAPH_REF_COLORS.local },
          { id: "base", color: graph.GRAPH_REF_COLORS.remote },
        ],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "base",
        parents: [],
        commitCol: 0,
        commitColor: graph.GRAPH_REF_COLORS.local,
        inputLanes: [
          { id: "base", color: graph.GRAPH_REF_COLORS.local },
          { id: "base", color: graph.GRAPH_REF_COLORS.remote },
        ],
        outputLanes: [],
        isHead: false,
        isMerge: false,
      },
    ]);
  });

  test(`${surface} git graph keeps an already-active merge parent as a new VS Code lane`, () => {
    const result = graph.computeGitGraph([
      { sha: "tip", parents: ["merge", "side"] },
      { sha: "merge", parents: ["base", "side"] },
    ]);

    assert.equal(result.maxCols, 3);
    assert.deepEqual(simplifyRows(result.rows), [
      {
        sha: "tip",
        parents: ["merge", "side"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [],
        outputLanes: [
          { id: "merge", color: 0 },
          { id: "side", color: 1 },
        ],
        isHead: true,
        isMerge: true,
      },
      {
        sha: "merge",
        parents: ["base", "side"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [
          { id: "merge", color: 0 },
          { id: "side", color: 1 },
        ],
        outputLanes: [
          { id: "base", color: 0 },
          { id: "side", color: 1 },
          { id: "side", color: 2 },
        ],
        isHead: false,
        isMerge: true,
      },
    ]);
  });

  test(`${surface} git graph normalizes duplicate parent ids`, () => {
    const result = graph.computeGitGraph([{ sha: "m", parents: ["a", "a", "b", ""] }]);

    assert.deepEqual(result.rows[0].parents, ["a", "b"]);
    assert.deepEqual(result.rows[0].outputLanes, [
      { id: "a", color: 0 },
      { id: "b", color: 1 },
    ]);
  });
}

test("GUI and WebUI git graph modules stay in parity", () => {
  const commits = [
    { sha: "m", parents: ["a", "b"] },
    { sha: "a", parents: ["r"] },
    { sha: "b", parents: ["r"] },
    { sha: "r", parents: [] },
  ];

  assert.deepEqual(
    graphModules.gui.computeGitGraph(commits),
    graphModules.web.computeGitGraph(commits),
  );
});
