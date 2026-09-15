/**
 * Runs one cluster layout in the MCODE web worker and resolves with the
 * coordinates. Plain function (no React), because the host calls the layout
 * algorithm's `run` outside any component.
 *
 * One short-lived worker per run: the host's layout slot has no cancel
 * channel, so there is nothing to keep a worker around for, and a fresh
 * worker cannot be confused by a stale message from an earlier run. The
 * worker is terminated as soon as it answers (or fails).
 */
import { createMcodeWorker } from './mcodeWorkerFactory'
import { ClusterLayoutRequest, MCODEWorkerResponse } from './mcodeWorkerTypes'

export interface ClusterLayoutWorkerResult {
  x: Float64Array
  y: Float64Array
  /** Clusters the layout used (zero when none were found). */
  clusterCount: number
}

export function runClusterLayoutInWorker(
  request: Omit<ClusterLayoutRequest, 'type'>,
): Promise<ClusterLayoutWorkerResult> {
  return new Promise<ClusterLayoutWorkerResult>((resolve, reject) => {
    const worker = createMcodeWorker('mcode-layout-worker')
    const done = (): void => worker.terminate()

    worker.onmessage = (event: MessageEvent<MCODEWorkerResponse>) => {
      done()
      const response = event.data
      if (response.type === 'layout') {
        resolve({ x: response.x, y: response.y, clusterCount: response.clusterCount })
      } else if (response.type === 'error') {
        reject(new Error(response.message))
      } else {
        reject(new Error(`Unexpected MCODE worker response: ${response.type}`))
      }
    }
    worker.onerror = (event) => {
      done()
      reject(new Error(event.message || 'MCODE layout worker crashed'))
    }

    const message: ClusterLayoutRequest = { type: 'layout', ...request }
    // Hand the typed arrays over instead of copying them; the caller built
    // them for this run and does not read them again.
    const transfer: Transferable[] = [
      request.edgeSrc.buffer,
      request.edgeTgt.buffer,
      request.nodeSize.buffer,
    ]
    if ('clusterOf' in request.clusters) {
      transfer.push(request.clusters.clusterOf.buffer)
      if (request.clusters.score !== null) transfer.push(request.clusters.score.buffer)
    }
    try {
      worker.postMessage(message, transfer)
    } catch (err) {
      done()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
