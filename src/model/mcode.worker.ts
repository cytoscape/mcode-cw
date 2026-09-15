/**
 * Web worker entry point for MCODE analysis and the cluster layout.
 *
 * Receives a request from the main thread, runs the (potentially long,
 * synchronous) work here so the UI thread is never blocked, and posts the
 * result back.
 *
 * Bundled automatically by Vite via the `?worker&inline` import in
 * `mcodeWorkerFactory`. Its import graph (mcodeAlgorithm → mcodeGraph →
 * mcodeTypes, clusterLayoutModel, clusterAssignment) is pure and free of
 * React / MUI / cyweb dependencies.
 */
import { clusterAssignmentFromClusters } from './clusterAssignment'
import { layoutClusters, NO_CLUSTER } from './clusterLayoutModel'
import { MCODEAlgorithm } from './mcodeAlgorithm'
import { AdjacencyMap } from './mcodeTypes'
import {
  ClusterLayoutRequest,
  MCODEAnalyzeRequest,
  MCODEWorkerRequest,
  MCODEWorkerResponse,
} from './mcodeWorkerTypes'

// `self` is the DedicatedWorkerGlobalScope. We cast to a minimal typed shape so
// this file does not need the (DOM-conflicting) "webworker" TS lib enabled.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<MCODEWorkerRequest>) => void) | null
  postMessage: (message: MCODEWorkerResponse, transfer?: Transferable[]) => void
}

ctx.onmessage = (event: MessageEvent<MCODEWorkerRequest>): void => {
  const request = event.data
  try {
    if (request.type === 'layout') layout(request)
    else analyze(request)
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

function analyze({ adjacency, parameters }: MCODEAnalyzeRequest): void {
  const alg = new MCODEAlgorithm(parameters)
  const clusters = alg.run(adjacency)

  // Send a snapshot of the scored state so the main thread can rehydrate the
  // algorithm (cached nodeInfo/scores) without rescoring.
  ctx.postMessage({ type: 'success', clusters, snapshot: alg.toSnapshot() })
}

function layout(request: ClusterLayoutRequest): void {
  const { nodeIds, edgeSrc, edgeTgt, nodeSize, options } = request
  const n = nodeIds.length

  let clusterOf: Int32Array
  let clusterCount: number
  let score: Float64Array | null
  if ('clusterOf' in request.clusters) {
    ;({ clusterOf, clusterCount, score } = request.clusters)
  } else {
    // Transient MCODE run: its clusters serve this layout only.
    const adjacency: AdjacencyMap = new Map()
    for (const id of nodeIds) adjacency.set(id, [])
    for (let e = 0; e < edgeSrc.length; e++) {
      const s = nodeIds[edgeSrc[e]]
      const t = nodeIds[edgeTgt[e]]
      adjacency.get(s)!.push(t)
      if (s !== t) adjacency.get(t)!.push(s)
    }
    const alg = new MCODEAlgorithm(request.clusters.mcodeParameters)
    const assignment = clusterAssignmentFromClusters(alg.run(adjacency))
    const scores = alg.getScores()
    clusterOf = new Int32Array(n).fill(NO_CLUSTER)
    score = new Float64Array(n)
    nodeIds.forEach((id, i) => {
      const c = assignment.clusterOf.get(id)
      if (c !== undefined) clusterOf[i] = c
      score![i] = scores[id] ?? 0
    })
    clusterCount = assignment.clusterCount
  }

  const result = layoutClusters(clusterOf, clusterCount, edgeSrc, edgeTgt, nodeSize, score, options)
  ctx.postMessage({ type: 'layout', x: result.x, y: result.y, clusterCount }, [
    result.x.buffer,
    result.y.buffer,
  ])
}
