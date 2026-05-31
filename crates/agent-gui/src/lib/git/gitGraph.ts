export const GRAPH_COLORS = [
  "#ffb000",
  "#dc267f",
  "#994f00",
  "#40b0a6",
  "#b66dff",
];

export const GRAPH_REF_COLORS = {
  local: "var(--git-review-graph-ref-local)",
  remote: "var(--git-review-graph-ref-remote)",
  base: "var(--git-review-graph-ref-base)",
} as const;

export type GraphColor = number | string;

export type GraphLane = {
  id: string;
  color: GraphColor;
};

export type GraphRow = {
  sha: string;
  parents: string[];
  commitCol: number;
  commitColor: GraphColor;
  inputLanes: GraphLane[];
  outputLanes: GraphLane[];
  isHead: boolean;
  isMerge: boolean;
};

type GitGraphCommit = {
  sha: string;
  parents: readonly string[];
  refs?: readonly string[];
};

export type GitGraphOptions = {
  currentRef?: string;
  remoteRef?: string;
  baseRef?: string;
  remoteName?: string;
};

function cloneLane(lane: GraphLane): GraphLane {
  return { ...lane };
}

function normalizeRef(value: string) {
  let ref = value.trim();
  if (!ref) return "";
  if (ref.startsWith("refs/heads/")) {
    ref = ref.slice("refs/heads/".length);
  } else if (ref.startsWith("refs/remotes/")) {
    ref = ref.slice("refs/remotes/".length);
  } else if (ref.startsWith("refs/tags/")) {
    ref = ref.slice("refs/tags/".length);
  }
  return ref;
}

function createRefColorMap(options: GitGraphOptions) {
  const map = new Map<string, GraphColor>();
  const currentRef = normalizeRef(options.currentRef ?? "");
  const remoteRef = normalizeRef(options.remoteRef ?? "");
  const baseRef = normalizeRef(options.baseRef ?? "");
  const remoteName = normalizeRef(options.remoteName ?? "");

  if (currentRef) {
    map.set(currentRef, GRAPH_REF_COLORS.local);
  }
  if (remoteRef) {
    map.set(remoteRef, GRAPH_REF_COLORS.remote);
  }
  if (remoteName && currentRef) {
    map.set(`${remoteName}/${currentRef}`, GRAPH_REF_COLORS.remote);
  }
  if (baseRef) {
    map.set(baseRef, GRAPH_REF_COLORS.base);
  }

  return map;
}

function labelColorForCommit(
  commit: GitGraphCommit | undefined,
  refColorMap: Map<string, GraphColor>,
): GraphColor | undefined {
  for (const rawRef of commit?.refs ?? []) {
    const color = refColorMap.get(normalizeRef(rawRef));
    if (color !== undefined) return color;
  }
  return undefined;
}

function uniqueParents(parents: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawParent of parents) {
    const parent = rawParent.trim();
    if (!parent || seen.has(parent)) continue;
    seen.add(parent);
    result.push(parent);
  }
  return result;
}

export function computeGitGraph(
  commits: readonly GitGraphCommit[],
  options: GitGraphOptions = {},
): {
  rows: GraphRow[];
  maxCols: number;
} {
  if (commits.length === 0) return { rows: [], maxCols: 0 };

  const rows: GraphRow[] = [];
  const commitBySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const refColorMap = createRefColorMap(options);
  let nextColor = -1;
  let previousOutputLanes: GraphLane[] = [];
  let maxCols = 1;

  function allocColor(): number {
    nextColor = (nextColor + 1) % GRAPH_COLORS.length;
    return nextColor;
  }

  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index];
    const parents = uniqueParents(commit.parents);
    const inputLanes = previousOutputLanes.map(cloneLane);
    const inputIndex = inputLanes.findIndex((lane) => lane.id === commit.sha);
    const commitCol = inputIndex >= 0 ? inputIndex : inputLanes.length;
    const labelColor = labelColorForCommit(commit, refColorMap);
    const commitColor = inputIndex >= 0 ? inputLanes[inputIndex].color : (labelColor ?? allocColor());
    const outputLanes: GraphLane[] = [];

    if (parents.length > 0) {
      let firstParentAdded = false;
      for (const lane of inputLanes) {
        if (lane.id === commit.sha) {
          if (!firstParentAdded) {
            outputLanes.push({ id: parents[0], color: labelColor ?? commitColor });
            firstParentAdded = true;
          }
          continue;
        }

        outputLanes.push(cloneLane(lane));
      }

      if (!firstParentAdded) {
        outputLanes.push({ id: parents[0], color: labelColor ?? commitColor });
      }

      for (let parentIndex = 1; parentIndex < parents.length; parentIndex++) {
        const parent = parents[parentIndex];
        outputLanes.push({
          id: parent,
          color: labelColorForCommit(commitBySha.get(parent), refColorMap) ?? allocColor(),
        });
      }
    }

    maxCols = Math.max(maxCols, inputLanes.length, outputLanes.length, commitCol + 1);
    rows.push({
      sha: commit.sha,
      parents,
      commitCol,
      commitColor,
      inputLanes,
      outputLanes,
      isHead: index === 0,
      isMerge: parents.length > 1,
    });
    previousOutputLanes = outputLanes;
  }

  return { rows, maxCols };
}
