/**
 * "MCODE Cluster Layout" as a Cytoscape Web layout algorithm, registered in
 * the host's `'layout-algorithm'` slot (see `MCODEApp.resources`).
 *
 * This is the host adapter around the pure model in
 * `src/model/clusterLayoutModel.ts` — the port of the Cytoscape Desktop
 * `ClusterLayoutTask` + `PrepareClusterLayoutTask` pair. It resolves where
 * the clusters come from, gathers the arrays the model wants, runs the model
 * in the MCODE web worker, and returns positions. The host owns everything
 * around the run: the running flag, the undo entry and the viewport fit, so
 * nothing here writes to the view.
 *
 * Cluster sources, first match wins (mirrors `PrepareClusterLayoutTask`):
 *   0. A result preset by the MCODE panel's "Apply Cluster Layout" — see
 *      `applyClusterLayoutToResult`.
 *   1. The "Cluster Column" parameter names a node-table column: its
 *      distinct values are the clusters. Nodes are ordered by degree.
 *   2. The newest MCODE result for the network with at least one cluster.
 *      Nodes are ordered by their MCODE score.
 *   3. Run MCODE now (in the worker) with the default parameters and fluff
 *      off. The run becomes a regular MCODE result — in the store, with its
 *      node columns — and the MCODE panel is opened on it, as if the user
 *      had started a New Analysis. (Desktop gates this behind a "Run MCODE
 *      if the network has no result" tunable; here it always happens when
 *      nothing else supplied clusters.)
 *   4. No clusters found by that run: nothing is stored, and every connected
 *      component becomes a disk of its own.
 *
 * Parameters follow the host's shared parameter spec (an ordered array; see
 * docs/specifications/APP_PARAMETERS_SPECIFICATION.md in cytoscape-web): the
 * Settings dialog shows them in this order, nested by `groups`, and `run`
 * receives their values keyed by `displayName`, typed by the declaration.
 */
import type {
  ApiResult,
  LayoutApi,
  LayoutParameter,
  LayoutPositions,
  LayoutRunContext,
  ParameterValue,
  RegisterLayoutOptions,
} from '@cytoscape-web/api-types'
import { id as appId } from 'virtual:cyweb-app-meta'

import {
  ClusterAssignment,
  clusterAssignmentFromClusters,
  clusterAssignmentFromColumn,
} from '../model/clusterAssignment'
import {
  ClusterLayoutOptions,
  DEFAULT_CLUSTER_LAYOUT_OPTIONS,
  NO_CLUSTER,
} from '../model/clusterLayoutModel'
import { runClusterLayoutInWorker } from '../model/clusterLayoutWorker'
import { MCODEAlgorithm } from '../model/mcodeAlgorithm'
import { hydrateNetworkResults } from '../model/mcodeAppData'
import { commitMcodeResult } from '../model/mcodeResultCommit'
import { getMcodeResults } from '../model/mcodeResultStore'
import { DEFAULT_MCODE_PARAMETERS, MCODECluster, MCODEResult } from '../model/mcodeTypes'
import { ClusterLayoutRequest } from '../model/mcodeWorkerTypes'

/** Slot-local id; the host qualifies it as `<appId>::cluster-layout`. */
export const CLUSTER_LAYOUT_ID = 'cluster-layout'

/** The name `layout.applyLayout` takes for this algorithm. */
export const CLUSTER_LAYOUT_ALGORITHM_NAME = `${appId}::${CLUSTER_LAYOUT_ID}`

/** The `'right-panel'` resource id of the MCODE panel (see MCODEApp.resources). */
export const MCODE_PANEL_TAB_ID = 'MCODEPanel'

/**
 * Largest coordinate magnitude of a previous centroid worth preserving. A
 * view whose coordinates were corrupted by an earlier layout would otherwise
 * stay far out for every later layout.
 */
const MAX_SANE_COORDINATE = 1e7

/**
 * The parameter labels — also the keys `run` reads the values under (the
 * host keys a parameter by its `displayName`; none of these collide).
 */
const PARAM = {
  clusterColumn: 'Cluster Column',
  satellites: 'Satellites',
  nodeSpacing: 'Node Spacing',
  clusterSpacing: 'Cluster Spacing',
} as const

/**
 * The Desktop layout's tunables, minus edge bundling, in display order.
 * Desktop's "Run MCODE if the network has no result" is not a parameter
 * here: with no cluster column, the layout always falls back to the
 * network's MCODE results and runs MCODE first when there are none.
 */
const PARAMETERS: LayoutParameter[] = [
  {
    displayName: PARAM.clusterColumn,
    type: 'nodeColumn',
    // Cluster ids are discrete values: any column type but doubles and lists.
    columnTypeFilter: ['string', 'long', 'integer', 'boolean'],
    defaultValue: '',
    description:
      'Node column whose values name the cluster of each node. When none is chosen, ' +
      "the network's MCODE results are used, and MCODE is run first (default parameters, " +
      'fluff off) if the network has no results.',
    groups: ['Clusters'],
  },
  {
    displayName: PARAM.satellites,
    type: 'checkBox',
    defaultValue: true,
    description:
      'Place each unclustered node on a ring around the cluster it has most edges to. ' +
      'When off, unclustered nodes form disks of their own.',
    groups: ['Clusters'],
  },
  {
    displayName: PARAM.nodeSpacing,
    type: 'text',
    validationType: 'digits',
    defaultValue: DEFAULT_CLUSTER_LAYOUT_OPTIONS.nodeSpacing,
    minValue: 0,
    maxValue: 1000,
    description: 'Gap between neighbouring nodes, in view units.',
    groups: ['Spacing'],
  },
  {
    displayName: PARAM.clusterSpacing,
    type: 'text',
    validationType: 'digits',
    defaultValue: DEFAULT_CLUSTER_LAYOUT_OPTIONS.clusterSpacing,
    minValue: 0,
    maxValue: 10000,
    description: 'Gap between cluster disks, in view units.',
    groups: ['Spacing'],
  },
]

export const mcodeClusterLayout: RegisterLayoutOptions = {
  id: CLUSTER_LAYOUT_ID,
  displayName: 'MCODE Cluster Layout',
  description:
    'Packs each MCODE cluster into a disk (best-scored node in the center), attaches ' +
    'unclustered nodes to the cluster they connect to most, and places the disks so ' +
    'connected clusters are near each other.',
  type: 'other',
  parameters: PARAMETERS,
  run: runClusterLayout,
}

// ── Panel entry point ────────────────────────────────────────────────────────

/**
 * The result whose clusters the next run must use, regardless of the cluster
 * column or of newer results. Set for the duration of one `applyLayout` call
 * by `applyClusterLayoutToResult`; the run consumes it when it starts.
 */
let presetResult: MCODEResult | null = null

/**
 * Lay out a result's source network with that result's clusters — the MCODE
 * panel's "Apply Cluster Layout" (Desktop: `ClusterLayoutOptionsTask`). Goes
 * through the host's Layout API so the run gets the same running flag, undo
 * entry and viewport fit as the Layout menu. The layout's current parameter
 * values (Layout → Settings...) apply, except that the cluster source is the
 * given result.
 */
export async function applyClusterLayoutToResult(
  layoutApi: LayoutApi,
  result: MCODEResult,
): Promise<ApiResult> {
  presetResult = result
  try {
    return await layoutApi.applyLayout(result.networkId, {
      algorithmName: CLUSTER_LAYOUT_ALGORITHM_NAME,
    })
  } finally {
    // `run` clears it as soon as it starts; this covers a run that never
    // started (the host rejected the call).
    if (presetResult === result) presetResult = null
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runClusterLayout(context: LayoutRunContext): Promise<LayoutPositions> {
  const { networkId, nodes, edges, positions, parameters } = context
  const options = toOptions(parameters)

  // Consume the panel's preset (if it is for this network) before anything
  // can throw, so it cannot leak into a later run.
  const preset = presetResult
  presetResult = null

  // Node index. The order is the host's node order, which is what ties are
  // broken by inside the model.
  const index = new Map<string, number>()
  nodes.forEach((node, i) => index.set(node.id, i))

  const src: number[] = []
  const tgt: number[] = []
  for (const edge of edges) {
    const a = index.get(edge.s)
    const b = index.get(edge.t)
    if (a === undefined || b === undefined) continue
    src.push(a)
    tgt.push(b)
  }
  const edgeSrc = Int32Array.from(src)
  const edgeTgt = Int32Array.from(tgt)

  const clusters = resolveClusters(context, preset?.networkId === networkId ? preset : null, index)
  const nodeSize = nodeSizes(context)

  // Previous centroid of the nodes that have a position (a node without a
  // view has none), kept only when it is finite and reasonable.
  let cx = 0
  let cy = 0
  let positioned = 0
  for (const node of nodes) {
    const pos = positions[node.id]
    if (pos === undefined) continue
    cx += pos[0]
    cy += pos[1]
    positioned++
  }
  cx /= Math.max(1, positioned)
  cy /= Math.max(1, positioned)
  if (!(Math.abs(cx) < MAX_SANE_COORDINATE && Math.abs(cy) < MAX_SANE_COORDINATE)) {
    cx = 0
    cy = 0
  }

  const result = await runClusterLayoutInWorker({
    nodeIds: nodes.map((node) => node.id),
    edgeSrc,
    edgeTgt,
    nodeSize,
    clusters,
    options,
  })
  if (result.clusterCount === 0) {
    console.warn('MCODE Cluster Layout: no clusters found; nodes are placed on component disks.')
  }
  if (result.mcode !== undefined && result.mcode.clusters.length > 0) {
    showMcodeRun(context, result.mcode.clusters, MCODEAlgorithm.fromSnapshot(result.mcode.snapshot))
  }

  const out: LayoutPositions = {}
  nodes.forEach((node, i) => {
    out[node.id] = [result.x[i] + cx, result.y[i] + cy]
  })
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toOptions(parameters: Readonly<Record<string, ParameterValue>>): ClusterLayoutOptions {
  // The host hands `digits` parameters over as numbers already; the guard
  // keeps a corrupt value from reaching the model.
  const num = (key: 'nodeSpacing' | 'clusterSpacing'): number => {
    const value = Number(parameters[PARAM[key]])
    return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_CLUSTER_LAYOUT_OPTIONS[key]
  }
  return {
    nodeSpacing: num('nodeSpacing'),
    clusterSpacing: num('clusterSpacing'),
    satellites: parameters[PARAM.satellites] !== false,
    iterations: DEFAULT_CLUSTER_LAYOUT_OPTIONS.iterations,
  }
}

/**
 * Decide where the clusters come from and express them for the worker: as
 * per-node arrays when they are known here, or as MCODE parameters when the
 * worker must find them first.
 */
function resolveClusters(
  context: LayoutRunContext,
  preset: MCODEResult | null,
  index: ReadonlyMap<string, number>,
): ClusterLayoutRequest['clusters'] {
  const { networkId, parameters } = context

  if (preset !== null) return fromResult(preset, index)

  const columnName = String(parameters[PARAM.clusterColumn] ?? '').trim()
  if (columnName !== '') {
    const fromColumn = clustersFromColumn(context, columnName)
    if (fromColumn !== null) return toArrays(fromColumn, null, index)
    console.warn(
      `MCODE Cluster Layout: node column "${columnName}" not found; falling back to MCODE results.`,
    )
  }

  // Results persisted by an earlier session are read into the store on first
  // sight of the network. The panel does this when it is open; the layout
  // must too, or it would run MCODE over a result that is only a read away —
  // and a later panel mount would then restore the stored copy over the one
  // this run commits.
  hydrateNetworkResults(networkId)
  const latest = findLatestResult(networkId)
  if (latest !== null) return fromResult(latest, index)

  // No column and no result: the worker runs MCODE first. Its run comes back
  // with the coordinates and is committed as a result (see `showMcodeRun`).
  return { mcodeParameters: { ...DEFAULT_MCODE_PARAMETERS, fluff: false } }
}

/**
 * The layout had to run MCODE: make that run a regular result (store + node
 * columns) and bring the MCODE panel into view on it, so the clusters the
 * layout was built on are not invisible. A failure to open the panel is only
 * logged — the result is in the store either way, and the panel shows it the
 * next time it is opened.
 */
function showMcodeRun(
  context: LayoutRunContext,
  clusters: MCODECluster[],
  algorithm: MCODEAlgorithm,
): void {
  const { networkId, apis } = context
  const result = commitMcodeResult(apis, networkId, clusters, algorithm)
  console.debug(`MCODE Cluster Layout: ran MCODE first, result "${result.name}"`, clusters)

  // Optional chaining: a host older than api-types 1.0.0-beta.5 has no panel api.
  const opened = apis.panel?.open('right', MCODE_PANEL_TAB_ID)
  if (opened !== undefined && !opened.success) {
    console.warn('MCODE Cluster Layout: failed to open the MCODE panel:', opened.error.message)
  }
}

function fromResult(
  result: MCODEResult,
  index: ReadonlyMap<string, number>,
): ClusterLayoutRequest['clusters'] {
  return toArrays(
    clusterAssignmentFromClusters(result.clusters),
    result.algorithm.getScores(),
    index,
  )
}

function toArrays(
  assignment: ClusterAssignment,
  scores: Record<string, number> | null,
  index: ReadonlyMap<string, number>,
): ClusterLayoutRequest['clusters'] {
  const clusterOf = new Int32Array(index.size).fill(NO_CLUSTER)
  for (const [nodeId, cluster] of assignment.clusterOf) {
    const i = index.get(nodeId)
    if (i !== undefined) clusterOf[i] = cluster
  }
  let score: Float64Array | null = null
  if (scores !== null) {
    score = new Float64Array(index.size)
    for (const [nodeId, i] of index) score[i] = scores[nodeId] ?? 0
  }
  return { clusterOf, clusterCount: assignment.clusterCount, score }
}

/** The network's newest result with at least one cluster, if any. */
function findLatestResult(networkId: string): MCODEResult | null {
  let latest: MCODEResult | null = null
  for (const result of getMcodeResults().results) {
    if (result.networkId !== networkId || result.clusters.length === 0) continue
    if (latest === null || result.id > latest.id) latest = result
  }
  return latest
}

/** Cluster assignment from a node column, or null when the column does not exist. */
function clustersFromColumn(context: LayoutRunContext, columnName: string): ClusterAssignment | null {
  const { networkId, apis } = context
  const columns = apis.table.getColumns(networkId, 'node')
  if (!columns.success || !columns.data.columns.some((c) => c.name === columnName)) return null

  const table = apis.table.getTable(networkId, 'node', { columns: [columnName], includeId: true })
  if (!table.success) {
    console.warn(`MCODE Cluster Layout: failed to read column "${columnName}":`, table.error.message)
    return null
  }
  const values: Array<readonly [string, unknown]> = []
  for (const row of table.data.rows) {
    const id = row.id
    if (id === undefined) continue
    // Own property only: the column name is user input, and a name such as
    // "__proto__" or "constructor" must read as "no value", not as an
    // inherited object.
    values.push([String(id), Object.hasOwn(row, columnName) ? row[columnName] : undefined])
  }
  return clusterAssignmentFromColumn(values)
}

/**
 * Node diameter per node: max(width, height) from the style defaults and any
 * per-node bypass. Mappings are not resolved (the API has no computed-value
 * call); the model only uses the largest size, so this is a small
 * approximation for styles that map node size.
 */
function nodeSizes(context: LayoutRunContext): Float64Array {
  const { networkId, nodes, apis } = context
  const style = apis.visualStyle

  const defaultOf = (vp: 'nodeWidth' | 'nodeHeight'): number => {
    const res = style.getDefault(networkId, vp)
    const value = res.success ? Number(res.data.value) : NaN
    return Number.isFinite(value) ? value : 0
  }
  const bypassesOf = (vp: 'nodeWidth' | 'nodeHeight'): Record<string, unknown> => {
    const res = style.getBypasses(networkId, vp)
    return res.success ? res.data.bypasses : {}
  }

  const defaultWidth = defaultOf('nodeWidth')
  const defaultHeight = defaultOf('nodeHeight')
  const widthBypass = bypassesOf('nodeWidth')
  const heightBypass = bypassesOf('nodeHeight')

  const size = new Float64Array(nodes.length)
  nodes.forEach((node, i) => {
    const w = Number(widthBypass[node.id] ?? defaultWidth)
    const h = Number(heightBypass[node.id] ?? defaultHeight)
    size[i] = Math.max(Number.isFinite(w) ? w : 0, Number.isFinite(h) ? h : 0)
  })
  return size
}
