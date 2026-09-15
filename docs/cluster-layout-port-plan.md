# Plan: port the MCODE Cluster Layout to Cytoscape Web

Scope: the **MCODE Cluster Layout** from MCODE 2.1.0 for Cytoscape Desktop,
registered through the host's new `'layout-algorithm'` resource slot.

**Force-Directed Edge Bundling is not part of this plan.** See the last
section for why, and for the host change that would unlock it.

Status: phases 1–4 are implemented (model, tests with a Java golden fixture,
adapter, declarative registration, the panel's "Apply Cluster Layout", and
the worker). The optional follow-ups in phase 4 are open.

Java source of truth (Eclipse workspace `MCODE`, commit `8bf2a0a`):

| Java file | Role | Port target |
|---|---|---|
| `internal/layout/ClusterLayoutModel.java` (489 lines) | All the math, plain arrays, no Cytoscape imports | `src/model/clusterLayoutModel.ts` — near line-for-line |
| `internal/layout/NodeClusterMap.java` | node → cluster index (best-ranked cluster wins) | `src/model/clusterAssignment.ts` |
| `internal/layout/ClusterLayoutTask.java` | Cytoscape adapter: arrays in, positions out, centroid kept | `src/layout/mcodeClusterLayout.ts` |
| `internal/layout/PrepareClusterLayoutTask.java` | Resolves where the clusters come from | same file |
| `internal/layout/ClusterLayoutContext.java` | Tunables | `parameters` of the registration |
| `internal/view/MainPanelMediator.java` "Apply Cluster Layout" | Panel entry point | Options menu item in `MCODEPanel.tsx` |
| `src/test/.../layout/ClusterLayoutModelTest.java` (10 tests) | Model tests | `src/model/clusterLayoutModel.test.ts` |
| `docs/cluster-layout-plan.md` | Why every constant is what it is | read before porting |

---

## 0. Prerequisites (host side)

The slot exists only on the host branch `feature/734-layout-algorithm-slot`
(HEAD `fa7a3abd`). It is not on `development`, and `@cytoscape-web/api-types`
`1.0.0-beta.5` (which carries `RegisterLayoutOptions`, `LayoutRunContext`,
`LayoutPositions`, `LayoutParameter`) is unpublished. The installed
`1.0.0-beta.4` has no `'layout-algorithm'` in `ResourceSlot`.

1. Run the host from that branch (`npm run dev` on :5500).
2. Link its locally built types, exactly as the README already describes for
   `appData`:
   ```bash
   # cytoscape-web, on feature/734-layout-algorithm-slot
   npm run build:api-types && cd packages/api-types && npm link && cd -
   # mcode-cw
   npm link @cytoscape-web/api-types
   ```
   Only `npm run typecheck` needs the link. The Vite build transpiles without
   types, and `cyweb/*` resolves from the running host.
3. When beta.5 is published, bump `devDependencies` and drop the link.

The host contract that matters (from `src/app-api/types/AppResourceTypes.ts`):

- `run(context)` receives `{ networkId, nodes, edges, positions, selectedNodeIds, parameters, apis }`.
  `nodes`/`edges` are bare `{ id }` / `{ id, s, t }`. **No node sizes** are
  passed (deferred by the host); read them through `apis.visualStyle`.
- `run` returns `Record<nodeId, [x, y]>`, sync or a Promise. Omitted nodes keep
  their position. A throw or rejection aborts the run with nothing moved.
- The host owns the running flag, the undo entry and the viewport fit. **Do
  not write positions from inside `run`.**
- No progress callback and no cancel signal. If the app is disabled mid-run
  the result is discarded.
- Parameters are scalars only (`string | integer | long | double | boolean`);
  the host renders them in Layout → Settings…
- The qualified algorithm name is `mcode::<id>`; `apis.layout.applyLayout(networkId, { algorithmName })` runs it.

---

## 1. Port the model — `src/model/clusterLayoutModel.ts`

Pure TypeScript, no React / MUI / cyweb imports, so it compiles under
`tsconfig.test.json` and can later run inside the existing worker.

```ts
export interface ClusterLayoutOptions {
  nodeSpacing: number      // 20
  clusterSpacing: number   // 100
  satellites: boolean      // true
  iterations: number       // 300
}
export interface ClusterLayoutResult {
  x: Float64Array; y: Float64Array
  clusterX: Float64Array; clusterY: Float64Array; clusterRadius: Float64Array
}
export function layoutClusters(
  clusterOf: Int32Array,        // -1 = unclustered
  clusterCount: number,
  edgeSrc: Int32Array, edgeTgt: Int32Array,
  nodeSize: Float64Array,
  score: Float64Array | null,   // null → order by degree
  options: ClusterLayoutOptions,
  cancelled?: () => boolean,
): ClusterLayoutResult
```

Port `ClusterLayoutModel.layout` step by step, keeping every constant:

1. **Global scale**: `diameter = max(10, max finite nodeSize)`, `step = diameter + nodeSpacing`.
2. **Adjacency**: undirected, self-loops dropped, `degree[]` from both endpoints.
3. **Comparators**: `byScore` = score desc, degree desc, index asc; `byDegree` = degree desc, index asc. Both are total orders, so `Array.prototype.sort` gives Java's result.
4. **Members per cluster**, sorted `byScore`.
5. **Satellites**: level-synchronous multi-source BFS with per-node vote maps; `next` sorted numerically (`sort((a, b) => a - b)`, not the default string sort); tie-break on the lower cluster index; record `hop[v]`.
6. **Leftovers**: degree-0 → isolated grid; the rest → DFS components, each a disk sorted `byDegree`. Disks = real clusters (rank order) then component disks.
7. **Disk radii**: `ringCount`, `ringRadius`, ring capacity `max(1, floor(2πr/step))`, satellite rings on top of `coreRadius`.
8. **`placeClusters`**: super-edge weights, initial circle in rank order, iteration budget `min(iterations, max(20, 2e8 / c²))`, the cooled loop (attraction `0.2·sqrt(w/maxW)·t` split by `superDegree`, gravity `0.02·t`, per-disk step cap `2r + gap`, 3 `separate` passes per iteration, up to 50 final passes), then recentre on the disk centroid.
9. **Member rings** (`angle = 2πk/count + ring·0.5`), **satellite rings** (sorted by hop then `preferredAngle`, golden-ratio fallback `2π·((node·0.6180339887) % 1)`), **isolated grid** to the right of `extent + clusterSpacing`.

Determinism notes for a Java-matching port:

- Java iterates the super-edge `HashMap` in hash order; floating-point sums
  depend on it. Sort super-edges by `(a, b)` before the loop so the TS output
  is stable and documented, and accept last-ulp differences from Java.
- `~j`-style tricks are not used here; only `placeClusters` packs pairs into a
  `long`. Use a `Map<string, number>` with `${a},${b}` keys or `a * c + b`
  (safe: `c² < 2^53`).
- `preferredAngle` scans every edge per satellite: O(satellites × E). Build a
  per-node incident-edge list once instead; same result, no quadratic trap.

Tests (`src/model/clusterLayoutModel.test.ts`, Node test runner, same pattern
as `mcodeAlgorithm.test.ts`) — port all 10 Java cases:
finite and non-overlapping positions; disks don't overlap and members stay
inside `clusterRadius`; highest score at the disk centre; satellite attaches
to its most-connected cluster; component disks when `satellites = false`;
hop-ordered rings; isolated grid outside everything; determinism; 500
singleton clusters finite and fast (the divergence regression); empty and
no-cluster input.

Optional but recommended: a **golden fixture**. Dump the Java model's output
for `galFiltered` (the fixture already in `src/model/__fixtures__/`) with a
throwaway `main` and assert the TS port matches within `1e-6`. This catches
ordering mistakes that the property tests above cannot.

---

## 2. The adapter — `src/layout/mcodeClusterLayout.ts`

Exports one `RegisterLayoutOptions` object, `mcodeClusterLayout`, and no
React. Responsibilities, in the order `ClusterLayoutTask` /
`PrepareClusterLayoutTask` perform them:

**Parameters** (mirror `ClusterLayoutContext`; `bundleEdges` dropped):

| name | type | default | description |
|---|---|---|---|
| `runMCODE` | boolean | true | Run MCODE if the network has no result |
| `satellites` | boolean | true | Attach unclustered nodes to their most connected cluster |
| `nodeSpacing` | integer | 20 | Node spacing (clamped ≥ 0) |
| `clusterSpacing` | integer | 100 | Cluster spacing (clamped ≥ 0) |
| `clusterColumn` | string | `''` | Node column naming the cluster of each node (overrides MCODE results) |

**Cluster source**, first match wins:

1. `clusterColumn` non-empty and present on the node table → distinct trimmed
   non-empty values, indexed in lexicographic order (`fromColumn`); `score = null`.
2. Newest result for `networkId` in `mcodeResultStore` with non-empty
   clusters → `clusterOf` from the cluster list in rank order, first cluster
   to claim a node wins (`NodeClusterMap.fromResult`); `score` from
   `result.algorithm.getScores()` (no table read needed, unlike Java).
3. `runMCODE` → run `MCODEAlgorithm` with `DEFAULT_MCODE_PARAMETERS` and
   `fluff: false` on the adjacency built from `context.edges`, and use the
   clusters **transiently** (not stored, no node columns). See phase 4 for
   promoting this to a real result.
4. Otherwise `clusterCount = 0`; the model places everything on component
   disks / the isolated grid, and the adapter logs the Java warning.

Note the Java panel's "Apply Cluster Layout" passes the *selected* result,
not the newest. Phase 3 covers that.

**Node sizes**: `apis.visualStyle.getDefault(networkId, 'nodeWidth' | 'nodeHeight')`
plus `getBypasses` for both, per node `max(width, height)`. Size mappings are
not resolved (the API has no "computed value" call); the model only uses the
global maximum, so this is a small approximation. Document it.

**Edges**: `context.edges` filtered to endpoints in the laid-out set;
self-loops are dropped by the model.

**Centroid**: average of `context.positions`; reset to `(0, 0)` when
`|cx|` or `|cy| ≥ 1e7` (the corrupted-view guard from `ClusterLayoutTask`).
Return `result.x[i] + cx, result.y[i] + cy` for every node.

**Registration** — declarative, next to the existing panel in `MCODEApp.tsx`:

```ts
resources: [
  { slot: 'right-panel', id: 'MCODEPanel', title: 'MCODE', component: lazy(...) },
  { slot: 'layout-algorithm', ...mcodeClusterLayout },   // id: 'cluster-layout'
],
```

It appears as **Layout → MCODE Cluster Layout** in the app block, in
Layout → Settings… with the five parameters, and as
`mcode::cluster-layout` to `applyLayout`. If the app must keep working on a
host without the slot, register imperatively in `mount()` instead, guarded by
`apis.resource.getSupportedSlots()`. Declarative first; this app already
depends on unreleased host branches.

---

## 3. Panel entry point

Java's MCODE panel Options menu has "Apply Cluster Layout" that lays out the
*selected* result's network with that result's clusters. Add the same item to
`MCODEPanel.tsx`'s Options menu, next to "View Source Network":

- Set a module-level "preset result" (a `WeakRef`/plain reference in the
  adapter module) and call
  `apis.layout.applyLayout(result.networkId, { algorithmName: 'mcode::cluster-layout' })`;
  the adapter consumes the preset before falling back to the source order
  above. This exercises the Layout API path for app algorithms as well as the
  menu path.
- Enable it when a result is selected. The host fits the view afterwards.

---

## 4. Off the main thread

The model is synchronous. `placeClusters` is O(c² · iterations) with the
iteration cap, so a few hundred clusters take well under a second in JS, but a
large network with many component disks, or MCODE itself under `runMCODE`,
can block the host for seconds. The host awaits a Promise, so:

1. Extend `mcode.worker.ts` with a second request type,
   `{ type: 'layout', ... }`, carrying the typed arrays (transferable) and
   returning `x`/`y`. `MCODEAlgorithm` already runs there for `runMCODE`.
2. The existing `useMcodeWorker` is a React hook; `run` executes outside
   React. Factor the worker construction (`createMcodeWorker`) and a
   promise-per-message helper into a plain module, and have both the hook
   and the layout use it. Keep the dev-mode Blob bootstrap untouched.
3. Land phase 1–3 on the main thread first; add the worker once the tests
   pass, and benchmark on `galFiltered` and a ~10k-edge network.

Optional follow-ups, each small:

- Promote `runMCODE`'s transient run to a real result (add it to the store
  with the node columns), which needs the "create result" code lifted out of
  `MCODEPanel.tsx` (around the `buildMcodeNodeTableData` call) into a model
  function. Matches Java, where the layout runs `MCODEAnalyzeCommandTask`.
- `selectedOnly` boolean parameter: lay out only `selectedNodeIds` and omit
  the rest from the returned map.
- `threshold` on the registration if the un-workered version proves slow.

---

## 5. Verification checklist

- `npm test` — the ported model tests plus the golden fixture.
- `npm run typecheck` against the linked beta.5 types.
- In the host: Layout menu row present and greyed out with no network;
  Settings… shows the five parameters and "Set as default" works; Apply
  Default Layout and the floating toolbar button run it; undo restores the
  previous positions; results laid out match Cytoscape Desktop on
  `galFiltered` by eye (same disk order, best-scored node centred).
- Panel "Apply Cluster Layout" lays out the selected result's network even
  when it is not the current one.
- Disable the app mid-run: nothing moves, no error surfaces.

---

## Why edge bundling is out of scope

The Java bundler (`internal/bundling/*`, pure Java, well tested) writes the
result as `EDGE_BEND` bypasses built from `BendFactory`/`HandleFactory`
handles. Cytoscape Web has nothing to receive that:

- `EdgeView` is `View` with no geometry (`src/models/ViewModel/EdgeView.ts`),
  while `NodeView` has `x, y`.
- No bend / curve / control-point visual property exists
  (`VisualPropertyName.ts` edge block), and `VisualPropertyValueType` has no
  array member, so a bypass could not carry points anyway.
- The renderer hard-codes `'curve-style': 'bezier'`
  (`cyjsRenderUtil.ts`); `CyjsEdgeVisualPropertyName.CurveStyle` is defined
  and never used.
- CX2 has no edge-geometry aspect; `edgeBypasses` covers the same scalar
  properties only.
- The only "draw anything" paths (`nodeGraphics.setRenderHook`, the
  annotations canvas) are node-only or not exposed to apps.

The minimal host change that would unlock it: `bendPoints?: [number, number][]`
on `EdgeView`, `unbundled-bezier` / `segments` with
`control-point-distances`/`-weights` emitted by `cyjsRenderUtil`, a CX2
aspect for persistence, and the layout slot's return type widened to
`{ positions, edgeBends? }`. Until then the bundling engine could be ported
and unit-tested (it is pure), but nothing would render it, so it is deferred.
