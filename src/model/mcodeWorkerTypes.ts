/**
 * Message contracts exchanged with the MCODE web worker.
 *
 * The worker runs the (synchronous, CPU-bound) MCODE algorithm and the
 * cluster layout off the main thread so the UI stays responsive. All payloads
 * are structured-cloneable: `AdjacencyMap` is a `Map<string, string[]>`,
 * `MCODEParameters` / `MCODECluster` are plain objects, and the layout arrays
 * are typed arrays (posted with their buffers transferred).
 */
import type { ClusterLayoutOptions } from './clusterLayoutModel'
import type { MCODEAlgorithmSnapshot } from './mcodeAlgorithm'
import type { AdjacencyMap, MCODECluster, MCODEParameters } from './mcodeTypes'

/** Main thread → worker: the graph and parameters to analyze. */
export interface MCODEAnalyzeRequest {
  type: 'analyze'
  adjacency: AdjacencyMap
  parameters: MCODEParameters
}

/**
 * Main thread → worker: lay out a graph given as node indices. The clusters
 * either come precomputed (`clusterOf` per node, `score` per node or null to
 * order by degree) or are found by running MCODE in the worker first with
 * `mcodeParameters`.
 */
export interface ClusterLayoutRequest {
  type: 'layout'
  /** Node ids by index; only needed to key the MCODE run when `clusters` is absent. */
  nodeIds: string[]
  edgeSrc: Int32Array
  edgeTgt: Int32Array
  nodeSize: Float64Array
  clusters:
    | { clusterOf: Int32Array; clusterCount: number; score: Float64Array | null }
    | { mcodeParameters: MCODEParameters }
  options: ClusterLayoutOptions
}

export type MCODEWorkerRequest = MCODEAnalyzeRequest | ClusterLayoutRequest

/**
 * Worker → main thread: for an analysis, the ranked clusters plus a snapshot of
 * the scored algorithm state (so the main thread can rehydrate the
 * MCODEAlgorithm and reuse its cached nodeInfo/scores); for a layout, the
 * coordinates by node index and how many clusters were used. On failure, an
 * error message.
 */
export type MCODEWorkerResponse =
  | { type: 'success'; clusters: MCODECluster[]; snapshot: MCODEAlgorithmSnapshot }
  | { type: 'layout'; x: Float64Array; y: Float64Array; clusterCount: number }
  | { type: 'error'; message: string }
