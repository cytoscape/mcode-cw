/**
 * Actions the user can run against a selected MCODE result / cluster from the
 * options menu: view the source network, apply the MCODE visual style, create a
 * cluster subnetwork, and export the result to a text file.
 *
 * These handlers are stateful (they consume Cytoscape Web API hooks), so they
 * live in a custom hook rather than a plain utility module. The pure data
 * transforms they rely on live in `mcodeExport.ts`.
 */
import { useCallback } from 'react'

import type { ApiResult, PositionRecord } from '@cytoscape-web/api-types'
import { useElementApi } from 'cyweb/ElementApi'
import { useNetworkApi } from 'cyweb/NetworkApi'
import { useViewportApi } from 'cyweb/ViewportApi'
import { useVisualStyleApi } from 'cyweb/VisualStyleApi'
import { useWorkspaceApi } from 'cyweb/WorkspaceApi'

import { buildMcodeResultsText, ClusterExportRow, mcodeColumnName } from './mcodeExport'
import { MCODECluster, MCODEResult } from './mcodeTypes'

export interface McodeResultActions {
  /** Make the result's source network the active/shown one. */
  viewSourceNetwork: () => void
  /** Apply the MCODE visual style to the result's source network. */
  applyMcodeStyle: () => void
  /** Create a new subnetwork from the selected cluster. */
  createClusterNetwork: () => void
  /** Download the selected result as a tab-delimited .txt report. */
  exportResult: () => void
}

export function useMcodeResultActions(
  selectedResult: MCODEResult | null,
  selectedCluster: MCODECluster | null,
): McodeResultActions {
  const workspaceApi = useWorkspaceApi()
  const networkApi = useNetworkApi()
  const viewportApi = useViewportApi()
  const elementApi = useElementApi()
  const visualStyleApi = useVisualStyleApi()

  const viewSourceNetwork = useCallback(() => {
    if (!selectedResult) return
    const res = workspaceApi.switchCurrentNetwork(selectedResult.networkId)
    if (!res.success) {
      console.warn('Failed to switch to source network:', res.error.message)
    }
  }, [selectedResult, workspaceApi])

  const applyMcodeStyle = useCallback(() => {
    if (!selectedResult) return
    const { networkId, id, algorithm } = selectedResult

    const statusColumn = mcodeColumnName('Node Status', id)
    const scoreColumn = mcodeColumnName('Score', id)
    const scores = Object.values(algorithm.getScores())
    const maxScore = scores.length > 0 ? Math.max(...scores) : 0

    const warnOnFail = (label: string, result: ApiResult): void => {
      if (!result.success) console.warn(`MCODE style: failed to ${label}:`, result.error.message)
    }

    // Default node size (remove any previous mapping).
    // warnOnFail('remove node size width mapping', visualStyleApi.removeMapping(networkId, 'nodeWidth'))
    // warnOnFail('remove node size height mapping', visualStyleApi.removeMapping(networkId, 'nodeHeight'))
    warnOnFail(
      'set default node width',
      visualStyleApi.setDefault(networkId, 'nodeWidth', 40),
    )
    warnOnFail(
      'set default node height',
      visualStyleApi.setDefault(networkId, 'nodeHeight', 40),
    )

    // Default node color.
    warnOnFail(
      'set default node color',
      visualStyleApi.setDefault(networkId, 'nodeBackgroundColor', '#ffffff'),
    )

    // Node shape mapped from the node-status column ("Seed" / "Clustered" / "Unclustered").
    warnOnFail(
      'map node shape',
      visualStyleApi.createDiscreteMapping(
        networkId,
        'nodeShape',
        statusColumn,
        'string',
        { Seed: 'rectangle', Clustered: 'ellipse', Unclustered: 'diamond' },
      ),
    )

    // Node fill color mapped continuously from the node-score column: 0 (or below)
    // is white, fading from black up to red at the cluster's max score.
    // warnOnFail(
    //   'map node color',
    //   visualStyleApi.createContinuousMapping(
    //     networkId,
    //     'nodeBackgroundColor',
    //     'color',
    //     scoreColumn,
    //     [0, maxScore],
    //     'double',
    //     [
    //       { value: 0, vpValue: '#000000', inclusive: true },
    //       { value: maxScore, vpValue: '#ff0000' },
    //     ],
    //     '#ffffff',
    //     '#ff0000',
    //   ),
    // )
  }, [selectedResult, visualStyleApi])

  const createClusterNetwork = useCallback(() => {
    if (!selectedResult || !selectedCluster) return

    // The induced subnetwork keeps the source's element ids, table columns,
    // attribute rows, and node positions, and it is added to the workspace and
    // made current.
    const clusterName = `${selectedResult.name} (Cluster ${selectedCluster.rank})`
    const created = networkApi.createNetworkFromNodeList(
      selectedResult.networkId,
      selectedCluster.nodes,
      'all',
      { name: clusterName },
    )
    if (!created.success) {
      console.warn('Failed to create cluster network:', created.error.message)
      return
    }
    const clusterNetworkId = created.data.networkId

    // The new network starts with a default style; copy the source network's
    // active style onto it so the cluster looks like its parent. Styles are
    // per network in Cytoscape Web, so this is a snapshot: later edits to
    // either network's style do not reach the other.
    const sourceStyle = visualStyleApi.getVisualStyle(selectedResult.networkId)
    if (sourceStyle.success) {
      const sourceStyles = visualStyleApi.getStyles(selectedResult.networkId)
      const styleName = sourceStyles.success
        ? sourceStyles.data.styles.find((s) => s.active)?.name
        : undefined
      const applied = visualStyleApi.applyVisualStyle(
        clusterNetworkId,
        sourceStyle.data.visualStyle,
        styleName ? { name: styleName } : undefined,
      )
      if (!applied.success) {
        console.warn('Failed to apply the source style to the cluster network:', applied.error.message)
      }
    } else {
      console.warn('Failed to read the source network style:', sourceStyle.error.message)
    }

    // Prefer the layout cached from the cluster thumbnail over the source
    // network's coordinates, so the new network opens laid out as the cluster
    // was previewed rather than as a scattered slice of the source.
    const { nodePositions } = selectedCluster
    if (!nodePositions) return
    const positions: PositionRecord = {}
    for (const nodeId of selectedCluster.nodes) {
      const pos = nodePositions[nodeId]
      if (pos) positions[nodeId] = [pos.x, pos.y]
    }
    if (Object.keys(positions).length === 0) return
    const moved = viewportApi.updateNodePositions(clusterNetworkId, positions)
    if (!moved.success) {
      console.warn('Failed to apply cluster layout to the new network:', moved.error.message)
    }
  }, [selectedResult, selectedCluster, networkApi, viewportApi, visualStyleApi])

  const exportResult = useCallback(() => {
    if (!selectedResult) return
    const { networkId, algorithm, clusters, name } = selectedResult
    const parameters = algorithm.getParameters()

    // Resolve a node's display name from the source network ("name" column),
    // falling back to the raw node id when no name attribute is present.
    const nodeName = (nodeId: string): string => {
      const node = elementApi.getNode(networkId, nodeId)
      if (node.success) {
        const value = node.data.attributes.name ?? node.data.attributes['shared name']
        if (value !== undefined && value !== null) return String(value)
      }
      return nodeId
    }

    // Count the edges induced by the cluster's nodes in the source network
    // (undirected, each unordered pair once) — i.e. the cluster's edge count.
    const inducedEdgeCount = (nodes: string[]): number => {
      const inCluster = new Set(nodes)
      const seen = new Set<string>()
      for (const nodeId of nodes) {
        const connected = elementApi.getConnectedNodes(networkId, nodeId)
        if (!connected.success) continue
        for (const neighbor of connected.data.nodeIds) {
          if (!inCluster.has(neighbor)) continue
          seen.add(nodeId < neighbor ? `${nodeId}|${neighbor}` : `${neighbor}|${nodeId}`)
        }
      }
      return seen.size
    }

    const rows: ClusterExportRow[] = clusters.map((cluster) => ({
      score: cluster.score,
      nodeCount: cluster.nodes.length,
      edgeCount: inducedEdgeCount(cluster.nodes),
      nodeNames: cluster.nodes.map(nodeName),
    }))
    const content = buildMcodeResultsText(parameters, rows)

    // Name the file after the source network, e.g. "galFiltered-mcode-results.txt".
    const summary = workspaceApi.getNetworkSummary(networkId)
    const networkName = summary.success ? summary.data.name : name
    const fileName = `${networkName}-mcode-results.txt`

    // Trigger a browser download of the text file.
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }, [selectedResult, elementApi, workspaceApi])

  return { viewSourceNetwork, applyMcodeStyle, createClusterNetwork, exportResult }
}
