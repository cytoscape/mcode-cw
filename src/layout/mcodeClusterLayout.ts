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
 *   1. `clusterColumn` names a node-table column: its distinct values are
 *      the clusters. Nodes are ordered by degree.
 *   2. The newest MCODE result for the network with at least one cluster.
 *      Nodes are ordered by their MCODE score.
 *   3. `runMCODE`: run MCODE now (in the worker) with the default parameters
 *      and fluff off, and use its clusters for this layout only — nothing is
 *      stored and no node columns are written.
 *   4. No clusters: every connected component becomes a disk of its own.
 */
import type {
  ApiResult,
  LayoutApi,
  LayoutPositions,
  LayoutRunContext,
  RegisterLayoutOptions,
  ValueType,
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
import { getMcodeResults } from '../model/mcodeResultStore'
import { DEFAULT_MCODE_PARAMETERS, MCODEResult } from '../model/mcodeTypes'
import { ClusterLayoutRequest } from '../model/mcodeWorkerTypes'

/** Slot-local id; the host qualifies it as `<appId>::cluster-layout`. */
export const CLUSTER_LAYOUT_ID = 'cluster-layout'

/** The name `layout.applyLayout` takes for this algorithm. */
export const CLUSTER_LAYOUT_ALGORITHM_NAME = `${appId}::${CLUSTER_LAYOUT_ID}`

/**
 * Largest coordinate magnitude of a previous centroid worth preserving. A
 * view whose coordinates were corrupted by an earlier layout would otherwise
 * stay far out for every later layout.
 */
const MAX_SANE_COORDINATE = 1e7

/** The Desktop layout's tunables, minus edge bundling. */
const PARAMETERS: RegisterLayoutOptions['parameters'] = {
  runMCODE: {
    displayName: 'Run MCODE',
    type: 'boolean',
    defaultValue: true,
    description:
      'When the network has no MCODE result (and no cluster column is given), run MCODE ' +
      'with its default parameters and fluff off before laying out.',
  },
  satellites: {
    displayName: 'Satellites',
    type: 'boolean',
    defaultValue: true,
    description:
      'Place each unclustered node on a ring around the cluster it has most edges to. ' +
      'When off, unclustered nodes form disks of their own.',
  },
  nodeSpacing: {
    displayName: 'Node Spacing',
    type: 'integer',
    defaultValue: DEFAULT_CLUSTER_LAYOUT_OPTIONS.nodeSpacing,
    description: 'Gap between neighbouring nodes, in view units.',
    range: { min: 0, max: 1000 },
  },
  clusterSpacing: {
    displayName: 'Cluster Spacing',
    type: 'integer',
    defaultValue: DEFAULT_CLUSTER_LAYOUT_OPTIONS.clusterSpacing,
    description: 'Gap between cluster disks, in view units.',
    range: { min: 0, max: 10000 },
  },
  clusterColumn: {
    displayName: 'Cluster Column',
    type: 'string',
    defaultValue: '',
    description:
      'Node column whose values name the cluster of each node. When set and present, ' +
      'it is used instead of the MCODE results.',
  },
}

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
  const n = nodes.length

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

  // Previous centroid, kept only when it is finite and reasonable.
  let cx = 0
  let cy = 0
  for (const node of nodes) {
    const pos = positions[node.id]
    if (pos === undefined) continue
    cx += pos[0]
    cy += pos[1]
  }
  cx /= Math.max(1, n)
  cy /= Math.max(1, n)
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

  const out: LayoutPositions = {}
  nodes.forEach((node, i) => {
    out[node.id] = [result.x[i] + cx, result.y[i] + cy]
  })
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toOptions(parameters: Readonly<Record<string, ValueType>>): ClusterLayoutOptions {
  const num = (key: 'nodeSpacing' | 'clusterSpacing'): number => {
    const value = Number(parameters[key])
    return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_CLUSTER_LAYOUT_OPTIONS[key]
  }
  return {
    nodeSpacing: num('nodeSpacing'),
    clusterSpacing: num('clusterSpacing'),
    satellites: parameters.satellites !== false,
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

  const columnName = String(parameters.clusterColumn ?? '').trim()
  if (columnName !== '') {
    const fromColumn = clustersFromColumn(context, columnName)
    if (fromColumn !== null) return toArrays(fromColumn, null, index)
    console.warn(
      `MCODE Cluster Layout: node column "${columnName}" not found; falling back to MCODE results.`,
    )
  }

  const latest = findLatestResult(networkId)
  if (latest !== null) return fromResult(latest, index)

  if (parameters.runMCODE !== false) {
    return { mcodeParameters: { ...DEFAULT_MCODE_PARAMETERS, fluff: false } }
  }

  return toArrays({ clusterOf: new Map(), clusterCount: 0 }, null, index)
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
    values.push([String(id), row[columnName]])
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
