/**
 * Node → cluster assignment for the cluster layout: which cluster each node
 * belongs to, as a dense cluster index. Port of `NodeClusterMap` from the
 * MCODE app for Cytoscape Desktop (LGPL v2.1+; see mcodeTypes.ts).
 *
 * Pure data, no host dependency, so it is unit-testable and can cross a
 * worker boundary.
 */
import { MCODECluster } from './mcodeTypes'

export interface ClusterAssignment {
  /** Node id → cluster index in `[0, clusterCount)`. Unlisted nodes are unclustered. */
  readonly clusterOf: ReadonlyMap<string, number>
  readonly clusterCount: number
}

export const EMPTY_CLUSTER_ASSIGNMENT: ClusterAssignment = {
  clusterOf: new Map(),
  clusterCount: 0,
}

/**
 * Clusters in rank order (the order of an MCODE result's cluster list); a
 * node listed in more than one cluster keeps the first, i.e. best ranked.
 */
export function clusterAssignmentFromClusters(
  clusters: readonly MCODECluster[],
): ClusterAssignment {
  const clusterOf = new Map<string, number>()
  clusters.forEach((cluster, index) => {
    for (const nodeId of cluster.nodes) {
      if (!clusterOf.has(nodeId)) clusterOf.set(nodeId, index)
    }
  })
  return { clusterOf, clusterCount: clusters.length }
}

/**
 * Distinct non-empty (trimmed) column values become clusters, numbered in
 * sorted order of their text. Mirrors `PrepareClusterLayoutTask.fromColumn`,
 * whose `TreeMap` sorts by `String.compareTo` (UTF-16 code units), which is
 * what the default JS sort does.
 */
export function clusterAssignmentFromColumn(
  values: Iterable<readonly [nodeId: string, value: unknown]>,
): ClusterAssignment {
  const valueOfNode = new Map<string, string>()
  const distinct = new Set<string>()
  for (const [nodeId, raw] of values) {
    if (raw === null || raw === undefined) continue
    const text = String(raw).trim()
    if (text === '') continue
    valueOfNode.set(nodeId, text)
    distinct.add(text)
  }
  const indexOfValue = new Map<string, number>()
  ;[...distinct].sort().forEach((text, i) => indexOfValue.set(text, i))
  const clusterOf = new Map<string, number>()
  for (const [nodeId, text] of valueOfNode) clusterOf.set(nodeId, indexOfValue.get(text)!)
  return { clusterOf, clusterCount: indexOfValue.size }
}
