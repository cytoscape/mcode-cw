/**
 * Turns a finished MCODE run into a result the user can see: a numbered,
 * named `MCODEResult` in the store (which the panel renders and `appData`
 * persists) plus the three MCODE node-table columns on the source network.
 *
 * Shared by the panel's "New Analysis" and by the cluster layout, which runs
 * MCODE itself when the network has no result yet. Plain function over the
 * host api objects, so it has no React dependency and is unit-testable with
 * fakes.
 */
import type { TableApi, WorkspaceApi } from '@cytoscape-web/api-types'

import { MCODEAlgorithm } from './mcodeAlgorithm'
import { buildMcodeNodeTableData } from './mcodeExport'
import { addResult, takeNextResultId } from './mcodeResultStore'
import { MCODECluster, MCODEResult } from './mcodeTypes'

/** The slice of the host api the commit needs. */
export interface McodeResultCommitApis {
  table: Pick<TableApi, 'createColumn' | 'setValues'>
  workspace: Pick<WorkspaceApi, 'getNetworkSummary'>
}

/**
 * Add the result to the store (selected, with no cluster selected) and write
 * its node columns. Column failures are logged, not thrown: the result is
 * still worth showing without them.
 *
 * The result name is "{id} - {network name}", where the id is the store's
 * monotonically increasing result id — it also numbers the columns
 * ("MCODE::Score (id)"), so the two can never disagree.
 */
export function commitMcodeResult(
  apis: McodeResultCommitApis,
  networkId: string,
  clusters: MCODECluster[],
  algorithm: MCODEAlgorithm,
): MCODEResult {
  const summary = apis.workspace.getNetworkSummary(networkId)
  const networkName = summary.success ? summary.data.name : networkId
  const id = takeNextResultId()
  const result: MCODEResult = {
    id,
    name: `${id} - ${networkName}`,
    networkId,
    algorithm,
    clusters,
  }
  addResult(result)

  // "MCODE::Score (n)", "MCODE::Node Status (n)", "MCODE::Clusters (n)".
  const { columns, rows } = buildMcodeNodeTableData(id, clusters, algorithm.getScores())
  for (const col of columns) {
    const created = apis.table.createColumn(networkId, 'node', col.name, col.type, col.defaultValue)
    if (!created.success) {
      console.warn(`Failed to create node column "${col.name}":`, created.error.message)
    }
  }
  const cellEdits = Object.entries(rows).flatMap(([nodeId, values]) =>
    Object.entries(values).map(([column, value]) => ({ id: nodeId, column, value })),
  )
  const edited = apis.table.setValues(networkId, 'node', cellEdits)
  if (!edited.success) {
    console.warn('Failed to write MCODE node column values:', edited.error.message)
  }

  return result
}
