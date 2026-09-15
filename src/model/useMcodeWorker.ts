/**
 * React hook that owns a single MCODE web worker and exposes a promise-based
 * `run()` for executing an analysis off the main thread, plus a `cancel()` to
 * abort the one in progress.
 *
 * The worker is created lazily on first use and terminated when the consuming
 * component unmounts. Only one analysis may be in flight at a time (the caller
 * is expected to guard the UI accordingly); a second concurrent `run()` rejects.
 *
 * ── Why a Web Worker? ───────────────────────────────────────────────────────
 * MCODE clustering is heavy, synchronous, CPU-bound work (per-node k-core /
 * density scoring, then cluster finding) with nothing to await — it just
 * occupies the thread until it finishes. JavaScript is single-threaded, and the
 * main thread is shared with rendering and input, so running it inline freezes
 * the UI for the whole duration.
 *
 * That's especially bad here because this app is a Module Federation remote
 * embedded in Cytoscape Web: a blocked main thread freezes the *host* app, not
 * just our panel. Offloading to a worker keeps the main thread free, which buys:
 *   - no freeze: large networks take seconds, but the UI stays live;
 *   - a real progress spinner and a working Cancel button (we just terminate()
 *     the worker — you can't reliably cancel synchronous main-thread work).
 *
 * It's a clean fit because the algorithm is pure: it operates on a plain
 * adjacency map with no DOM / React / cyweb dependencies, so the worker bundle
 * contains only the algorithm.
 *
 * The cluster layout (src/layout/) runs in the same worker module through
 * `clusterLayoutWorker.ts`, one short-lived worker per run, since the host's
 * layout slot has no cancel channel to keep a worker around for.
 *
 * Trade-offs we accept: inputs/outputs cross by structured-clone copy via
 * postMessage (fine — they're plain/cloneable), and because the algorithm
 * instance lives in the worker, its scored state is returned as a serializable
 * snapshot and rehydrated on the main thread (see MCODEAlgorithm.toSnapshot /
 * fromSnapshot) so features like cluster exploration can reuse it without
 * rescoring. If analyses were always tiny this would be over-engineering, but
 * real MCODE runs block long enough — and freezing the host raises the stakes —
 * to make it worth the message-passing overhead.
 */
import { useCallback, useEffect, useRef } from 'react'

import { MCODEAlgorithm } from './mcodeAlgorithm'
import { AdjacencyMap, MCODECluster, MCODEParameters } from './mcodeTypes'
import { createMcodeWorker } from './mcodeWorkerFactory'
import { MCODEWorkerRequest, MCODEWorkerResponse } from './mcodeWorkerTypes'

/** Rejection raised when an in-flight analysis is cancelled by the user. */
export class McodeCancelledError extends Error {
  constructor() {
    super('MCODE analysis was cancelled')
    this.name = 'McodeCancelledError'
  }
}

/** Result of a successful analysis: ranked clusters plus the (rehydrated)
 *  algorithm instance carrying the cached scoring state. */
export interface MCODEAnalysisResult {
  clusters: MCODECluster[]
  algorithm: MCODEAlgorithm
}

type Pending = {
  resolve: (result: MCODEAnalysisResult) => void
  reject: (error: Error) => void
}

// The worker is constructed by `createMcodeWorker` (src/model/mcodeWorkerFactory.ts),
// which explains the dev/prod construction; the cluster layout shares it.

export interface McodeWorkerController {
  run: (adjacency: AdjacencyMap, parameters: MCODEParameters) => Promise<MCODEAnalysisResult>
  cancel: () => void
}

export function useMcodeWorker(): McodeWorkerController {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Pending | null>(null)

  // Settle the in-flight promise (if any) and clear it.
  const settle = useRef((response: MCODEWorkerResponse | Error): void => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return

    if (response instanceof Error) pending.reject(response)
    else if (response.type === 'success')
      pending.resolve({
        clusters: response.clusters,
        algorithm: MCODEAlgorithm.fromSnapshot(response.snapshot),
      })
    else if (response.type === 'error') pending.reject(new Error(response.message))
    else pending.reject(new Error(`Unexpected MCODE worker response: ${response.type}`))
  })

  // Lazily create the worker and wire up its handlers.
  const getWorker = useCallback((): Worker => {
    if (workerRef.current === null) {
      const worker = createMcodeWorker()
      worker.onmessage = (event: MessageEvent<MCODEWorkerResponse>) => settle.current(event.data)
      worker.onerror = (event) =>
        settle.current(new Error(event.message || 'MCODE worker crashed'))
      workerRef.current = worker
    }
    return workerRef.current
  }, [])

  // Tear the worker down on unmount; reject any analysis still running.
  useEffect(() => {
    return () => {
      settle.current(new Error('MCODE worker was terminated'))
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const run = useCallback(
    (adjacency: AdjacencyMap, parameters: MCODEParameters): Promise<MCODEAnalysisResult> =>
      new Promise<MCODEAnalysisResult>((resolve, reject) => {
        if (pendingRef.current) {
          reject(new Error('An MCODE analysis is already running'))
          return
        }
        try {
          const worker = getWorker()
          pendingRef.current = { resolve, reject }
          const request: MCODEWorkerRequest = { type: 'analyze', adjacency, parameters }
          worker.postMessage(request)
        } catch (err) {
          pendingRef.current = null
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }),
    [getWorker],
  )

  const cancel = useCallback((): void => {
    if (pendingRef.current === null) return
    // Reject the in-flight analysis and dispose the worker. A terminated worker
    // can't be reused, so the next run() lazily creates a fresh one.
    settle.current(new McodeCancelledError())
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  return { run, cancel }
}
