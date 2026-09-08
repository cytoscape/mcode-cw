/**
 * Pure helpers for turning MCODE results into external representations: a
 * tab-delimited results report (.txt) mirroring the Java exporter, plus the
 * MCODE node-table column naming shared by the analysis and the UI.
 *
 * These have no React or Cytoscape Web dependencies (they operate on plain
 * data), so they are straightforward to unit-test in isolation.
 */
import type { ValueType, ValueTypeName } from '@cytoscape-web/api-types'

import { MCODECluster, MCODEParameters } from './mcodeTypes'

/**
 * Score formatted with up to 3 fraction digits, trailing zeros stripped
 * (matches the Java NumberFormat with maximumFractionDigits = 3): e.g.
 * 2.3333 -> "2.333", 2 -> "2", 1.6 -> "1.6".
 */
export function formatScore(score: number): string {
  return String(Number(score.toFixed(3)))
}

/** Per-cluster values needed to render one row of the export report. */
export interface ClusterExportRow {
  score: number
  nodeCount: number
  edgeCount: number
  /** Display names of the cluster's nodes, in order. */
  nodeNames: string[]
}

/**
 * Build the MCODE results report text. The cluster rank is the row's 1-based
 * position in `rows` (which are expected to already be in ranked order).
 *
 * `now` is injectable so the output is deterministic in tests.
 */
export function buildMcodeResultsText(
  parameters: MCODEParameters,
  rows: ClusterExportRow[],
  now: Date = new Date(),
): string {
  const p = parameters
  const lines: string[] = [
    'MCODE App Results',
    `Date: ${now.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}`,
    '',
    'Parameters:',
    '   Network Scoring:',
    `      Include Loops: ${p.includeLoops}  Degree Cutoff: ${p.degreeCutoff}`,
    '   Cluster Finding:',
    `      Node Score Cutoff: ${p.nodeScoreCutoff}  Haircut: ${p.haircut}  Fluff: ${p.fluff}` +
      `  K-Core: ${p.kCore}  Max. Depth from Seed: ${p.maxDepthFromStart}`,
    '',
    'Cluster\tScore (Density*#Nodes)\tNodes\tEdges\tNode IDs',
  ]

  rows.forEach((row, i) => {
    lines.push(
      `${i + 1}\t${formatScore(row.score)}\t${row.nodeCount}` +
        `\t${row.edgeCount}\t${row.nodeNames.join(', ')}`,
    )
  })

  return lines.join('\n') + '\n'
}

// ── MCODE node-table columns ────────────────────────────────────────────────

/** Namespace prefixing every MCODE node-table column. */
export const MCODE_NAMESPACE = 'MCODE'

/** The per-result node attributes MCODE writes to the source network. */
export type McodeNodeAttr = 'Score' | 'Node Status' | 'Clusters'

/**
 * Column name for an MCODE node attribute and result number, e.g.
 * `mcodeColumnName('Score', 1)` -> "MCODE::Score (1)". Mirrors the Java
 * `MCODEUtil.columnName(name, result)`.
 */
export function mcodeColumnName(attr: McodeNodeAttr, resultNumber: number): string {
  return `${MCODE_NAMESPACE}::${attr} (${resultNumber})`
}

/** The three node-table column names MCODE creates for a given result. */
export function mcodeColumnNames(resultNumber: number): string[] {
  return [
    mcodeColumnName('Score', resultNumber),
    mcodeColumnName('Node Status', resultNumber),
    mcodeColumnName('Clusters', resultNumber),
  ]
}

/** A node-table column to create (name + Cytoscape Web value type + default). */
export interface NodeColumnDef {
  name: string
  type: ValueTypeName
  defaultValue: ValueType
}

export interface McodeNodeTableData {
  /** Columns to create on the source network's node table. */
  columns: NodeColumnDef[]
  /** Node-id -> { columnName -> value } edits to apply. */
  rows: Record<string, Record<string, ValueType>>
}

/**
 * Build the node-table columns and row values for an MCODE result, mirroring
 * `MCODEAnalyzeTask.createNetworkAttributes()`:
 *   - "MCODE::Score (n)"       (double)          : the node's MCODE score
 *   - "MCODE::Node Status (n)" (string)          : Unclustered | Clustered | Seed
 *   - "MCODE::Clusters (n)"    (list of string)  : e.g. ["Cluster 1", "Cluster 3"]
 *
 * Every scored node gets its score and defaults to "Unclustered"; nodes that
 * belong to clusters accumulate the cluster names and are marked "Seed" (when
 * the cluster's seed) or "Clustered". Nodes not analyzed simply keep the
 * column defaults.
 */
export function buildMcodeNodeTableData(
  resultNumber: number,
  clusters: MCODECluster[],
  scores: Record<string, number>,
): McodeNodeTableData {
  const scoreCol = mcodeColumnName('Score', resultNumber)
  const statusCol = mcodeColumnName('Node Status', resultNumber)
  const clustersCol = mcodeColumnName('Clusters', resultNumber)

  const columns: NodeColumnDef[] = [
    { name: scoreCol, type: 'double', defaultValue: 0 },
    { name: statusCol, type: 'string', defaultValue: 'Unclustered' },
    { name: clustersCol, type: 'list_of_string', defaultValue: [] },
  ]

  const rows: Record<string, Record<string, ValueType>> = {}

  // Every analyzed node gets its score and a default "Unclustered" status.
  for (const [nodeId, score] of Object.entries(scores)) {
    rows[nodeId] = { [scoreCol]: score, [statusCol]: 'Unclustered' }
  }

  // Nodes in clusters: accumulate cluster names (insertion order, de-duped) and
  // set the status. As in the Java version, when a node is in multiple clusters
  // the last one processed wins for the status value.
  for (const cluster of clusters) {
    const clusterName = `Cluster ${cluster.rank}`

    for (const nodeId of cluster.nodes) {
      const row = rows[nodeId] ?? (rows[nodeId] = { [scoreCol]: scores[nodeId] ?? 0 })
      const list = (row[clustersCol] as string[] | undefined) ?? []
      if (!list.includes(clusterName)) list.push(clusterName)
      row[clustersCol] = list
      row[statusCol] = cluster.seedId === nodeId ? 'Seed' : 'Clustered'
    }
  }

  return { columns, rows }
}
