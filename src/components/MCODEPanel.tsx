import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Select,
  Slider,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography
} from '@mui/material'
// NOTE: root import only — a subpath like '@mui/material/Select' bundles a
// second copy of MUI past the shared-singleton boundary (build gate fails).
import type { SelectChangeEvent } from '@mui/material'
import {
  AddIcon,
  CheckIcon,
  DeleteIcon,
  ExpandLessIcon,
  FileDownloadIcon,
  InfoIcon,
  MenuIcon,
  PaletteIcon,
} from './icons'

import cytoscape from 'cytoscape'
import euler from 'cytoscape-euler'

import { useCyWebEvent } from 'cyweb/EventBus'
import { useElementApi } from 'cyweb/ElementApi'
import { useSelectionApi } from 'cyweb/SelectionApi'
import { useTableApi } from 'cyweb/TableApi'
import { useWorkspaceApi } from 'cyweb/WorkspaceApi'
import { JSX } from 'react/jsx-runtime'

import { MCODEAlgorithm } from '../model/mcodeAlgorithm'
import { forgetNetwork, hydrateNetworkResults } from '../model/mcodeAppData'
import { buildMcodeNodeTableData, mcodeColumnNames } from '../model/mcodeExport'
import {
  addResult,
  discardAllResults,
  discardSelectedResult,
  NetworkEdge,
  networkEdgesCache,
  removeResultsForNetwork,
  selectCluster,
  selectResult,
  syncSelectionToNetwork,
  takeNextResultId,
  useMcodeResults,
} from '../model/mcodeResultStore'
import { MCODECluster, MCODEParameters, MCODEResult } from '../model/mcodeTypes'
import { useMcodeResultActions } from '../model/useMcodeResultActions'
import { McodeCancelledError, useMcodeWorker } from '../model/useMcodeWorker'
import { NewAnalysisDialog } from './NewAnalysisDialog'


cytoscape.use(euler)

/** Clusters larger than this aren't rendered as thumbnails (layout is too slow). */
const MAX_VISUALIZABLE_CLUSTER_SIZE = 500

/** Whether a cluster is too big to render as a thumbnail image. */
const isClusterTooLargeToVisualize = (cluster: MCODECluster): boolean =>
  cluster.nodes.length > MAX_VISUALIZABLE_CLUSTER_SIZE

/**
 * The status of a cluster thumbnail image.
 * The thumbnail is either loading, too large to render, or ready with a base64 PNG data URI.
 */
type ThumbnailStatus =
  | { kind: 'loading' }
  | { kind: 'too-large' }
  | { kind: 'ready'; src: string }


const OptionsMenu = ({
  currentNetworkId,
  results,
  selectedResult,
  selectedCluster,
  onShowAnalysisParameters,
  onDiscardSelectedResult,
  onDiscardAllResults,
}: {
  currentNetworkId: string | null
  results: readonly MCODEResult[]
  selectedResult: MCODEResult | null
  selectedCluster: MCODECluster | null
  onShowAnalysisParameters: (show: boolean) => void
  onDiscardSelectedResult: () => void
  onDiscardAllResults: () => void
}): JSX.Element => {
  const { viewSourceNetwork, applyClusterLayout, applyMcodeStyle, createClusterNetwork, exportResult } =
    useMcodeResultActions(selectedResult, selectedCluster)

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [showParametersResult, setShowParametersResult] = useState(false)
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
  const [confirmMessage, setConfirmMessage] = useState('')
  const [confirmAction, setConfirmAction] = useState<() => void>(() => {})

  const open = Boolean(anchorEl);

  const handleOptionsClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  }
  const handleOptionsClose = () => {
    setAnchorEl(null)
  }

  // Menu items close the menu, then run the corresponding result action.
  const handleViewSourceNetwork = () => {
    handleOptionsClose()
    viewSourceNetwork()
  }
  const handleApplyClusterLayout = () => {
    handleOptionsClose()
    applyClusterLayout()
  }
  const handleApplyMcodeStyle = () => {
    handleOptionsClose()
    applyMcodeStyle()
  }
  const handleCreateClusterNetwork = () => {
    handleOptionsClose()
    createClusterNetwork()
  }
  const handleExportResult = () => {
    handleOptionsClose()
    exportResult()
  }
  const handleShowAnalysisParameters = () => {
    handleOptionsClose()
    setShowParametersResult((prev) => !prev)
    onShowAnalysisParameters(!showParametersResult)
  }
  const handleDiscardSelectedResult = () => {
    handleOptionsClose()
    if (!selectedResult) return
    setConfirmMessage(`Are you sure you want to discard the result "${selectedResult.name}"?`)
    setConfirmAction(() => onDiscardSelectedResult)
    setConfirmDialogOpen(true)
  }
  const handleDiscardAllResults = () => {
    handleOptionsClose()
    setConfirmMessage('Are you sure you want to discard all results?')
    setConfirmAction(() => onDiscardAllResults)
    setConfirmDialogOpen(true)
  }

  // Actually remove the selected result, after the user confirms.
  const handleConfirmDiscard = (): void => {
    setConfirmDialogOpen(false)
    confirmAction?.()
  }

  return (
    <>
      <Tooltip title="Options...">
        <span>
          <IconButton
            onClick={handleOptionsClick}
          >
            <MenuIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Menu
        open={open}
        anchorEl={anchorEl}
        onClose={handleOptionsClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
      >
        <MenuItem
          disabled={!selectedResult || currentNetworkId === selectedResult.networkId}
          onClick={handleViewSourceNetwork}
        >
          <Typography component="span" sx={{ pl: 3.25 }}>
            View Source Network
          </Typography>
        </MenuItem>
        <Divider sx={{ my: 0.5 }} />
        <MenuItem
          disabled={!selectedResult}
          onClick={handleApplyClusterLayout}
        >
          <Typography component="span" sx={{ pl: 3.25 }}>
            Apply Cluster Layout
          </Typography>
        </MenuItem>
        {/*<MenuItem
          disabled={!selectedResult}
          onClick={handleApplyMcodeStyle}
        >
          <PaletteIcon sx={{ ml: 3 }} />
          <Typography component="span" sx={{ pl: 0.5 }}>
            Apply MCODE Style
          </Typography>
        </MenuItem>*/}
        <Divider sx={{ my: 0.5 }} />
        <MenuItem
          disabled={!selectedCluster}
          onClick={handleCreateClusterNetwork}
        >
          <Typography component="span" sx={{ pl: 3.25 }}>
            Create Cluster Network
          </Typography>
        </MenuItem>
        <MenuItem
          disabled={!selectedResult}
          onClick={handleExportResult}
        >
          <FileDownloadIcon sx={{ ml: 3 }} />
          <Typography component="span" sx={{ pl: 0.5 }}>
            Export Result
          </Typography>
        </MenuItem>
        <Divider sx={{ my: 0.5 }} />
        <MenuItem
          disabled={!selectedResult}
          onClick={handleShowAnalysisParameters}
        >
        {showParametersResult ? <CheckIcon fontSize="small" /> : <Box sx={{ width: 24 }} />}
          <InfoIcon />
          <Typography component="span" sx={{ pl: 0.5 }}>
            Show Analysis Parameters
          </Typography>
        </MenuItem>
        <Divider sx={{ my: 0.5 }} />
        <MenuItem
          disabled={!selectedResult}
          onClick={handleDiscardSelectedResult}
        >
          <DeleteIcon sx={{ ml: 3 }} />
          <Typography component="span" sx={{ pl: 0.5 }}>
            Discard Selected Result
          </Typography>
        </MenuItem>
        <MenuItem
          disabled={!results || results.length === 0}
          onClick={handleDiscardAllResults}
        >
          <DeleteIcon sx={{ ml: 3 }} />
          <Typography component="span" sx={{ pl: 0.5 }}>
            Discard All Results
          </Typography>
        </MenuItem>
      </Menu>
      <Dialog
        open={confirmDialogOpen}
        onClose={() => setConfirmDialogOpen(false)}
      >
        <DialogTitle>Discard Result</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmMessage}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDialogOpen(false)} variant="outlined">
            Cancel
          </Button>
          <Button onClick={handleConfirmDiscard} variant="contained" color="error">
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

const ClusterPanel = memo(({
  cluster,
  edges,
  algorithm,
  selected,
  onClick,
  onExplore,
}: {
  cluster: MCODECluster
  edges: NetworkEdge[]
  algorithm: MCODEAlgorithm
  selected: boolean
  onClick: (cluster: MCODECluster) => void
  onExplore: (cluster: MCODECluster, nodeScoreCutoff: number) => void
}): JSX.Element => {
  // Seed from the cached thumbnail so a re-selected result shows it instantly.
  const [status, setStatus] = useState<ThumbnailStatus>(() =>
    cluster.thumbnail
      ? { kind: 'ready', src: cluster.thumbnail }
      : isClusterTooLargeToVisualize(cluster)
        ? { kind: 'too-large' }
        : { kind: 'loading' },
  )
  // Controlled slider value: the cluster's explored cutoff if any, else the
  // analysis default. Initialized once per mount — the result+seed key on this
  // component remounts it (re-seeding this state) when the user switches results.
  const [cutoff, setCutoff] = useState(cluster.nodeScoreCutoff ?? algorithm.getParameters().nodeScoreCutoff)

  const updateImage = () => {
    if (isClusterTooLargeToVisualize(cluster)) {
      cluster.thumbnail = undefined
      cluster.nodePositions = undefined
      setStatus({ kind: 'too-large' })
      return
    }

    // Keep only the edges whose endpoints are both in the cluster — filtered in
    // memory from the network's pre-fetched edge list (no API calls here).
    const clusterNodes = new Set(cluster.nodes)
    const clusterEdges = edges.filter(
      (e) => clusterNodes.has(e.source) && clusterNodes.has(e.target),
    )

    const elements: cytoscape.ElementDefinition[] = [
      ...cluster.nodes.map((id) => ({ data: { id, 'Node Status': cluster.seedId === id ? 'Seed' : 'Clustered' } })),
      ...clusterEdges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target } })),
    ]

    // Cytoscape's canvas renderer needs a sized DOM node, so render into a
    // detached, off-screen container, export the PNG, then tear it down.
    const container = document.createElement('div')
    container.style.position = 'absolute'
    container.style.left = '-9999px'
    container.style.top = '-9999px'
    container.style.width = '200px'
    container.style.height = '200px'
    document.body.appendChild(container)

    const cy = cytoscape({
      container,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'rgb(178, 24, 43)',
            'width': 50,
            'height': 50,
            'shape': (n) => n.data('Node Status') === 'Seed' ? 'rectangle' : 'ellipse',
          },
        },
        {
          selector: 'edge',
          style: {
            'line-color': 'rgb(103, 169, 207)',
            'width': 5,
            'curve-style': 'bezier',
            'target-arrow-color': 'rgb(33, 102, 172)',
            'target-arrow-shape': 'triangle'
          },
        },
      ],
      layout: { name: 'euler', animate: false, mass: 25 } as cytoscape.LayoutOptions,
    })

    // `full: true` exports the entire graph fit to the image, independent of
    // viewport zoom/pan. Returns a base64 PNG data URI usable as an <img> src.
    const png = cy.png({ full: true, bg: '#ffffff', scale: 2 })

    // Cache the node positions and the generated image on the cluster so that
    // re-selecting this result reuses them instead of recomputing the layout.
    const nodePositions: Record<string, { x: number; y: number }> = {}
    cy.nodes().forEach((n) => {
      const pos = n.position()
      nodePositions[n.id()] = { x: pos.x, y: pos.y }
    })
    cluster.nodePositions = nodePositions
    cluster.thumbnail = png

    cy.destroy()
    document.body.removeChild(container)
    setStatus({ kind: 'ready', src: png })
  }

  // Track the thumb live while dragging...
  const handleChange = (event: Event, value: number | number[]): void => {
    setCutoff(value as number)
  }
  // ...and re-grow the cluster only when the drag is released.
  const handleChangeCommitted = (
    event: React.SyntheticEvent | Event,
    value: number | number[],
  ): void => {
    setStatus({ kind: 'loading' }) // show the spinner while the new cluster is computed
    setTimeout(() => {
      // Re-grow the cluster at a new node-score cutoff (the size slider) and update the thumbnail.
      const explored = algorithm.exploreCluster(cluster, cutoff)
      cluster.seedId = explored.seedId
      cluster.nodes = explored.nodes
      cluster.score = explored.score
      cluster.nodeScoreCutoff = cutoff
      cluster.nodeSeenSnapshot = explored.nodeSeenSnapshot
      updateImage()
      onExplore(cluster, value as number) // Let the parent know the cluster changed so it can re-select its nodes in the source network
    }, 500) // Give the spinner a chance to render before the CPU hog
  }

  useEffect(() => {
    // Reuse the cached thumbnail if this cluster already has one. It survives
    // result switches (clusters live in component state); exploration makes a
    // new cluster object with no thumbnail, so that one regenerates.
    if (cluster.thumbnail) {
      setStatus({ kind: 'ready', src: cluster.thumbnail })
      return
    }
    if (cluster.nodes.length === 0) {
      setStatus({ kind: 'loading' })
      return
    }
    updateImage()
  }, [cluster, edges])

  return (
    <Box
      onClick={() => onClick(cluster)}
      sx={{
        px: 2,
        py: 0.5,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
        bgcolor: selected ? 'action.selected' : 'background.paper',
        borderBottom: (theme) => `2px solid ${theme.palette.background.default}`,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexGrow: 1,
        }}
      >
        <Typography
          variant="body1"
          sx={{
            textAlign: 'right',
            width: 32,
            flexShrink: 0,
            color: 'text.secondary',
            fontWeight: 'bold',
          }}
        >
          {cluster.rank}
        </Typography>
        <Box
          sx={{
            width: 80,
            height: 80,
            bgcolor: '#ffffff',
            border: (theme) => `1px solid ${theme.palette.divider}`,
            borderRadius: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
        {status.kind === 'ready' ? (
          <Box
            component="img"
            src={status.src}
            alt="Cluster Thumbnail"
            sx={{ maxWidth: '100%', maxHeight: '100%' }}
          />
        ) : status.kind === 'too-large' ? (
          <Typography variant="caption" color="text.disabled" sx={{ textAlign: 'center', px: 1 }}>
            Cluster is too big to show
          </Typography>
        ) : (
          <CircularProgress color="primary" />
        )}
        </Box>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ width: '100%', textAlign: 'right' }}>
            {(Math.round(cluster.score * 100) / 100).toFixed(2)}
          </Typography>
          <Tooltip title="Size Threshold (Node Score Cutoff)">
            <Slider
              aria-label="Node Score Cutoff"
              value={cutoff}
              getAriaValueText={(val) => val.toFixed(2)}
              valueLabelFormat={(val) => val.toFixed(2)}
              step={0.01}
              marks={[
                {
                  value: algorithm.getParameters().nodeScoreCutoff,
                  label: '',
                },
              ]}
              track={false}
              min={0}
              max={1.0}
              valueLabelDisplay="auto"
              onClick={(event) => event.stopPropagation()} // Prevent a click on the cluster panel, which would cause the parent component to
                                                           // select nodes before onChangeCommitted causes another nodes selection asynchronously
              onChange={handleChange}
              onChangeCommitted={handleChangeCommitted}
            />
          </Tooltip>
          <Typography variant="body2" color="text.secondary">
            {cluster.nodes.length} node{cluster.nodes.length !== 1 ? 's' : ''}
          </Typography>
        </Box>
      </Box>
    </Box>
  )
})
ClusterPanel.displayName = 'ClusterPanel'

const ExplorePanel = ({
  cluster,
  networkId,
}: {
  cluster: MCODECluster
  networkId: string
}): JSX.Element => {
  const [attributes, setAttributes] = useState<string[]>([])
  const [selectedAttribute, setSelectedAttribute] = useState<string>('')
  const [enumerations, setEnumerations] = useState<Map<string | number, number>>(new Map())

  const tableApi = useTableApi()  

  // Get the names of all node-table columns in the network,
  // and set the first one as the default selection if none is selected.
  const updateAttributes = (): string[] => {
    let names: string[] = []
    const table = tableApi.getTable(networkId, 'node')
    if (!table.success) {
      console.warn('Failed to read node table columns:', table.error.message)
      setAttributes(names)
      return names
    }
    
    names = table.data.columns
      .map((column) => column.name)
      .filter((value, index, self) => self.indexOf(value) === index) // unique names
    names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

    setAttributes(names)
    
    // set the first attribute as the default selection if none is selected
    if ((!selectedAttribute || selectedAttribute === '') && names.length > 0) {
      setSelectedAttribute(names[0])
    }

    return names
  }

  // Count how many times each value of the selected attribute appears across the
  // cluster's nodes. List-valued attributes (e.g. "MCODE::Clusters (n)") count each element.
  const updateEnumerations = () => {
    let counts = new Map<string | number, number>()

    if (selectedAttribute && selectedAttribute !== '') {
      for (const nodeId of cluster.nodes) {
        const result = tableApi.getValue(networkId, 'node', nodeId, selectedAttribute)
        if (!result.success) continue

        const raw = result.data.value
        if (raw === null || raw === undefined) continue

        // A list value contributes each of its elements; a scalar contributes once.
        const values = Array.isArray(raw) ? raw : [raw]
        for (const element of values) {
          if (element === null || element === undefined) continue
          // Keep numbers as numbers, everything else as its string form.
          const key = typeof element === 'number' ? element : String(element)
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        // Sort the map by key ascending (string order for strings, numeric order for numbers).
        counts = new Map([...counts.entries()].sort((a, b) => {
          if (typeof a[0] === 'number' && typeof b[0] === 'number') {
            return a[0] - b[0]
          }
          return String(a[0]).localeCompare(String(b[0]))
        }))
      }
    }

    setEnumerations(counts)
  }

  useEffect(() => {
    updateAttributes()
  }, [networkId])

  useEffect(() => {
    updateEnumerations()
  }, [selectedAttribute, cluster, networkId])

  // The node table of this network changed. 'data:changed' can't tell a column
  // schema change from a row-value change (creating a column in the Cytoscape
  // Web UI writes default values, so rowIds is non-empty either way), so refresh
  // both the attribute list and the enumerations.
  useCyWebEvent('data:changed', ({ networkId: changedNetworkId, tableType }) => {
    if (tableType !== 'node' || changedNetworkId !== networkId) return

    // Check whether the selected attribute's column was removed
    let stillExists = true
    if (selectedAttribute && selectedAttribute !== '') {
      const table = tableApi.getTable(networkId, 'node')
      stillExists = table.success && table.data.columns.some((column) => column.name === selectedAttribute)
    }

    const newAttributes = updateAttributes()
    // If the selected attribute was removed, select the first attribute in the new list (or empty string if none).
    if (!stillExists) setSelectedAttribute(newAttributes.length > 0 ? newAttributes[0] : '')
    
    updateEnumerations()
  })

  const handleOnChange = (event: SelectChangeEvent<typeof selectedAttribute>) => {
    setSelectedAttribute(event.target.value)
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          p: 1,
          gap: 1,
        }}
      >
        <Typography variant="body1">Node Attribute:</Typography>
        <Select
          value={selectedAttribute}
          disabled={attributes.length === 0}
          size="small"
          displayEmpty
          renderValue={() => !selectedAttribute || selectedAttribute === '' ? '-- Select an attribute --' : selectedAttribute}
          onChange={handleOnChange}
          sx={{
            flexGrow: 1,
            minWidth: 120,
          }}
        >
          {attributes.map((attr) => (
            <MenuItem key={attr} value={attr}>
              {attr}
            </MenuItem>
          ))}
        </Select>
      </Box>
      <TableContainer
        sx={{
          maxHeight: 240,
          border: (theme) => `1px solid ${theme.palette.divider}`,
          borderRadius: 1,
        }}
      >
        <Table stickyHeader size="small">
          <TableHead>
            <TableRow>
              <TableCell
                key="value"
                align="left"
              >
                Value
              </TableCell>
              <TableCell
                key="occurrence"
                align="left"
                width={120}
                sx={{ borderLeft: (theme) => `1px solid ${theme.palette.divider}` }}
              >
                Occurrence
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
          {Array.from(enumerations.entries()).map(([val, count], idx) => (
            <TableRow key={`${cluster.rank}-${selectedAttribute}-${val}`}>
              <TableCell align={typeof val === 'number' ? 'right' : 'left'}>
                {val}
              </TableCell>
              <TableCell align="right" sx={{ borderLeft: (theme) => `1px solid ${theme.palette.divider}` }}>
                {count}
              </TableCell>
            </TableRow>
          ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  )
}

const MCODEPanel = (): JSX.Element => {
  const workspaceApi = useWorkspaceApi()
  const elementApi = useElementApi()
  const selectionApi = useSelectionApi()
  const tableApi = useTableApi()

  const [currentNetworkId, setCurrentNetworkId] = useState<string | null>(() => {
    const current = workspaceApi.getCurrentNetworkId()
    return current.success ? current.data.networkId : null
  })
  // Results live in a module-level store (mcodeResultStore), NOT component
  // state: closing the Side Panel unmounts this whole tree, and the results
  // must survive that. Only transient UI state stays local below.
  const { results, selectedResult, selectedCluster } = useMcodeResults()
  const [showParametersResult, setShowParametersResult] = useState(false)
  const [analysisDialogOpen, setAnalysisDialogOpen] = useState(false)
  const [noResultsOpen, setNoResultsOpen] = useState(false)
  // The "Analyzing network…" state is shown while the MCODE worker is running.
  // It can be cancelled by the user, which aborts the worker and sets a flag
  // that the main thread checks at a yield point after the worker finishes.
  const [analyzing, setAnalyzing] = useState(false)
  // Post-worker phase: committing the result + writing node columns.
  // Shown as a separate, non-cancellable "Saving results…" state
  // (the worker is done, so there's nothing left to cancel).
  const [saving, setSaving] = useState(false)

  // Set by the Cancel button. Covers the whole submit operation, not just the
  // worker: the worker is aborted via cancelMcode(), but the post-worker
  // main-thread work (writing node columns, committing the result) is only
  // cancellable by checking this flag at a yield point — see handleSubmitAnalysis.
  const analysisCancelled = useRef(false)

  // Runs the MCODE algorithm in a web worker so the UI thread stays responsive.
  const { run: runMcode, cancel: cancelMcode } = useMcodeWorker()

  // Fetch a network's edges through the module-level cache (mcodeResultStore),
  // so cluster thumbnails filter an in-memory list instead of each one
  // re-fetching all edges from the source network — even across panel remounts.
  const getNetworkEdges = (networkId: string): NetworkEdge[] => {
    const cached = networkEdgesCache.get(networkId)
    if (cached) return cached

    const edgesResult = elementApi.getEdges(networkId)
    if (!edgesResult.success) {
      // A restored result can select a network whose data is still loading.
      // Caching the empty read would leave every thumbnail blank for the rest
      // of the session, so return uncached and let the next render retry.
      console.warn(
        `Failed to read edges for network ${networkId}:`,
        edgesResult.error.message,
      )
      return []
    }

    const result: NetworkEdge[] = edgesResult.data.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
    }))
    networkEdgesCache.set(networkId, result)

    return result
  }

  // The selected result's source-network edges, fetched once per network.
  const networkEdges = useMemo(
    () => (selectedResult ? getNetworkEdges(selectedResult.networkId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedResult?.networkId],
  )

  useCyWebEvent('network:switched', ({ networkId: newId, previousId }) => {
    console.debug(`current network changed: ${previousId || '(none)'} → ${newId}`)
    setCurrentNetworkId(newId)
  })
  useCyWebEvent('network:deleted', ({ networkId }) => {
    console.debug(`Network deleted: ${networkId}`)
    // Delete all MCODE results that have the same networkId, and clear the selected result if it's among them.
    removeResultsForNetwork(networkId)
    // The host already dropped the network's stored app data; forget the
    // bookkeeping so a re-imported network with the same id reads fresh.
    forgetNetwork(networkId)
  })

  // Results follow the current network. Two reads, not one:
  //
  //   1. At mount, for the network that is already current — no
  //      `network:switched` fires for that one.
  //   2. On every switch, because the host keeps this panel mounted (it is
  //      keyed by resource id, not by network), so React never re-runs the
  //      mount read for us.
  //
  // hydrateNetworkResults pulls the network's stored results in on first
  // sight; syncSelectionToNetwork then points the selection at them, which is
  // what stops another network's clusters from staying on screen.
  useEffect(() => {
    if (!currentNetworkId) return
    // try/catch: a storage or decode failure must not take the panel down with
    // it. The host's PluginErrorBoundary would otherwise replace the whole
    // panel with "Plugin unavailable", which also hides the cause.
    try {
      hydrateNetworkResults(currentNetworkId)
      syncSelectionToNetwork(currentNetworkId)
    } catch (e) {
      console.error('Failed to restore stored MCODE results:', e)
    }
  }, [currentNetworkId])

  const handleNewAnalysisClick = (): void => {
    setAnalysisDialogOpen(true)
  }
  
  const handleSubmitAnalysis = async (parameters: MCODEParameters): Promise<void> => {
    if (!currentNetworkId) {
      return
    }

    // 1. Determine the set of nodes to analyze. For SELECTION scope, restrict
    //    to the currently selected nodes; otherwise use the whole network.
    let nodeIds: string[]
    if (parameters.scope === 'SELECTION') {
      const selection = selectionApi.getSelection(currentNetworkId)
      if (!selection.success) {
        console.warn('Failed to read selection:', selection.error.message)
        return
      }
      nodeIds = selection.data.selectedNodes
    } else {
      const nodesResult = elementApi.getNodeIds(currentNetworkId)
      if (!nodesResult.success) {
        console.warn('Failed to read nodes:', nodesResult.error.message)
        return
      }
      nodeIds = nodesResult.data.nodeIds
    }

    // 2. Read the network's graph via ElementApi as an undirected
    //    adjacency map { nodeId -> neighborNodeIds[] } for MCODE. When the
    //    scope is a selection, keep only neighbors that are themselves in scope.
    const inScope = new Set(nodeIds)
    const adjacency = new Map<string, string[]>()
    for (const nodeId of nodeIds) {
      const neighbors = elementApi.getConnectedNodes(currentNetworkId, nodeId)
      const neighborIds = neighbors.success ? neighbors.data.nodeIds : []
      adjacency.set(
        nodeId,
        parameters.scope === 'SELECTION'
          ? neighborIds.filter((id) => inScope.has(id))
          : neighborIds,
      )
    }
    console.debug('Adjacency map:', adjacency)

    // 3. Run MCODE in a web worker so a large network doesn't freeze the UI.
    //    A spinner is shown while `analyzing` is true. The spinner stays up for
    //    the *whole* operation (worker + committing the result), so it's cleared
    //    once at the end in `finally`.
    analysisCancelled.current = false
    let clusters: MCODECluster[]
    let algorithm: MCODEAlgorithm
    setAnalyzing(true)
    try {
      try {
        ;({ clusters, algorithm } = await runMcode(adjacency, parameters))
      } catch (err) {
        // A user cancellation is expected; only warn on genuine failures.
        if (err instanceof McodeCancelledError) {
          console.debug('MCODE analysis cancelled')
        } else {
          console.warn('MCODE analysis failed:', err)
        }
        return
      }

      // If nothing was found, don't add an empty result; just inform the user.
      if (clusters.length === 0) {
        setNoResultsOpen(true)
        return
      }

      // The worker is done, but committing the result still does heavy,
      // un-interruptible main-thread work (writing 3 node columns across every
      // node, then rendering the cluster thumbnails). Yield once so a Cancel
      // click queued during the run is delivered, then honor it — otherwise the
      // spinner would sit through that work with nothing left to cancel.
      await new Promise((resolve) => setTimeout(resolve))
      if (analysisCancelled.current) {
        console.debug('MCODE analysis cancelled')
        return
      }

      // The worker is done — switch to the non-cancellable "Saving results…"
      // phase and let it paint before the heavy synchronous work below.
      setAnalyzing(false)
      setSaving(true)
      await new Promise((resolve) => setTimeout(resolve))

      // 4. Build the result. The name is "{ID} - {network name}" where ID is
      //    the store's monotonically increasing result id.
      const summary = workspaceApi.getNetworkSummary(currentNetworkId)
      const networkName = summary.success ? summary.data.name : currentNetworkId
      const id = takeNextResultId()
      const newResult: MCODEResult = {
        id,
        name: `${id} - ${networkName}`,
        networkId: currentNetworkId,
        algorithm,
        clusters,
      }
      addResult(newResult)
      console.debug(`MCODE found ${clusters.length} cluster(s)`, clusters)

      // 5. Add the MCODE result columns to the source network's node table:
      //    "MCODE::Score (n)", "MCODE::Node Status (n)", "MCODE::Clusters (n)".
      const { columns, rows } = buildMcodeNodeTableData(id, clusters, algorithm.getScores())
      for (const col of columns) {
        const created = tableApi.createColumn(currentNetworkId, 'node', col.name, col.type, col.defaultValue)
        if (!created.success) {
          console.warn(`Failed to create node column "${col.name}":`, created.error.message)
        }
      }
      console.debug('Writing MCODE node column values...', rows)
      const cellEdits = Object.entries(rows).flatMap(([nodeId, values]) =>
        Object.entries(values).map(([column, value]) => ({ id: nodeId, column, value })),
      )
      const edited = tableApi.setValues(currentNetworkId, 'node', cellEdits)
      console.debug('Finished writing MCODE node column values--Success:', edited.success)
      if (!edited.success) {
        console.warn('Failed to write MCODE node column values:', edited.error.message)
      }
    } finally {
      setAnalyzing(false)
      setSaving(false)
    }
  }

  // Cancel the whole analysis: abort the worker if it's still running, and flag
  // the operation so the post-worker commit step (if the worker already
  // finished) is skipped at its yield checkpoint.
  const handleCancelAnalysis = (): void => {
    analysisCancelled.current = true
    cancelMcode()
  }

  const handleClusterClick = useCallback((cluster: MCODECluster): void => {
    if (selectedCluster === cluster) {
      return // already selected, do nothing
    }
    selectCluster(cluster)
    // Re-select the nodes in the source network so the selection tracks the newly selected cluster.
    if (selectedResult) {
      const selected = selectionApi.exclusiveSelect(selectedResult.networkId, cluster.nodes, [])
      if (!selected.success) {
        console.warn('Failed to select cluster nodes:', selected.error.message)
      }
    }
  }, [selectedResult, selectedCluster, selectionApi])

  const handleExploreCluster = useCallback((cluster: MCODECluster, nodeScoreCutoff: number): void => {
    selectCluster(cluster)
    // Re-select the now changed nodes in the source network so the selection tracks the new cluster.
    if (selectedResult) {
      const selected = selectionApi.exclusiveSelect(selectedResult.networkId, cluster.nodes, [])
      if (!selected.success) {
        console.warn('Failed to re-select explored cluster nodes:', selected.error.message)
      }
    }
  }, [selectedResult, selectedCluster, selectionApi])

  const handleShowAnalysisParameters = (show: boolean): void => {
    setShowParametersResult(show)
  }

  // Remove the result's MCODE node-table columns from its source network.
  const removeResultColumns = (result: MCODEResult): void => {
    for (const name of mcodeColumnNames(result.id)) {
      console.debug(`Deleting column "${name}" from network ${result.networkId}...`)
      const res = tableApi.deleteColumn(result.networkId, 'node', name)
      if (!res.success) {
        console.warn(`Failed to delete node column "${name}":`, res.error.message)
      }
    }
  }

  const handleDiscardSelectedResult = (): void => {
    if (selectedResult) {
      removeResultColumns(selectedResult)
      discardSelectedResult()
    }
  }
  const handleDiscardAllResults = (): void => {
    results.forEach(removeResultColumns)
    discardAllResults()
  }

  return (
    <>
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            backgroundColor: 'background.default',
            p: 1,
            gap: 1,
          }}
        >
          <Select
            value={selectedResult?.name || ''}
            disabled={results.length === 0}
            size="small"
            onChange={(e) => {
              const result = results.find((r) => r.name === e.target.value) || null
              selectResult(result)
            }}
            displayEmpty
            renderValue={(value: unknown) => {
              if (!value) {
                return (
                  <Typography color={results.length > 0 ? 'text.secondary' : 'text.disabled'}>
                    {results.length > 0 ? '-- Select Result --' : '-- No Results --'}
                  </Typography>
                );
              }
              return <>{value}</>;
            }}
            sx={{
              flexGrow: 1,
              minWidth: 200,
              bgcolor: results.length === 0 ? 'transparent' : 'background.paper',
            }}
          >
            {results.map((result) => (
              <MenuItem key={result.name} value={result.name}>
                {result.name}
              </MenuItem>
            ))}
          </Select>
          <Tooltip title="New analysis...">
            <span>
              <Button
                variant="contained"
                disabled={!currentNetworkId || analyzing || saving}
                onClick={handleNewAnalysisClick}
                sx={{
                  minWidth: 24,
                  px: 1,
                }}
              >
                <AddIcon />
              </Button>
            </span>
          </Tooltip>
          <OptionsMenu
            currentNetworkId={currentNetworkId}
            results={results}
            selectedResult={selectedResult}
            selectedCluster={selectedCluster}
            onShowAnalysisParameters={handleShowAnalysisParameters}
            onDiscardSelectedResult={handleDiscardSelectedResult}
            onDiscardAllResults={handleDiscardAllResults}
          />
        </Box>
      {showParametersResult && selectedResult && (
        <Box sx={{
          p: 2,
          backgroundColor: 'background.default',
          borderTop: (theme) => `2px solid ${theme.palette.background.paper}`,
        }}>
          <Typography variant="body2" color="text.secondary">
            Scope: {selectedResult.algorithm.getParameters().scope === 'NETWORK' ? 'Whole Network' : 'Selected Nodes'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Include Loops: {selectedResult.algorithm.getParameters().includeLoops ? 'Yes' : 'No'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Degree Cutoff: {selectedResult.algorithm.getParameters().degreeCutoff}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Haircut: {selectedResult.algorithm.getParameters().haircut ? 'Yes' : 'No'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Fluff: {selectedResult.algorithm.getParameters().fluff ? 'Yes' : 'No'}
          </Typography>
          {selectedResult.algorithm.getParameters().fluff && (
            <Typography variant="body2" color="text.secondary">
              Fluff Node Density Cutoff: {selectedResult.algorithm.getParameters().fluffNodeDensityCutoff}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            Node Score Cutoff: {selectedResult.algorithm.getParameters().nodeScoreCutoff}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            K-Core: {selectedResult.algorithm.getParameters().kCore}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Max Depth: {selectedResult.algorithm.getParameters().maxDepthFromStart}
          </Typography>
        </Box>
      )}
        <Box
          sx={{
            flexGrow: 1,
            overflowY: 'auto',
          }}
        >
          {selectedResult?.clusters.map((cluster) => (
            // Key by result + seed so switching results remounts the panels
            // (their uncontrolled size Slider would otherwise keep a stale
            // value from the same list position in the previous result). The key
            // stays stable across exploration, since the seed id is preserved.
            <ClusterPanel
              key={`${selectedResult.id}-${cluster.rank}`}
              cluster={cluster}
              edges={networkEdges}
              algorithm={selectedResult.algorithm}
              selected={selectedCluster === cluster}
              onClick={handleClusterClick}
              onExplore={handleExploreCluster}
            />
          ))}
        </Box>
      {selectedResult && selectedCluster && (
        <Accordion
          data-testid="layout-tools-accordion"
          sx={{
            backgroundImage: 'none',
            boxShadow: 'none',
          }}
        >
          <AccordionSummary
            expandIcon={<ExpandLessIcon />}
            aria-controls="manual-layout"
            sx={{
              minHeight: '40px', // collapsed summary height
              '&.Mui-expanded': {
                minHeight: '40px', // expanded summary height
                borderTop: (theme) => `1px solid ${theme.palette.divider}`,
              },
              '.MuiAccordionSummary-content': {
                marginTop: '12px !important',
              },
              '& .MuiAccordionSummary-expandIconWrapper': {
                color: (theme) => theme.palette.text.secondary,
              },
            }}
          >
            <Typography>Explore: Cluster {selectedCluster.rank}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <ExplorePanel cluster={selectedCluster} networkId={selectedResult.networkId} />
          </AccordionDetails>
        </Accordion>
      )}
      </Box>
    {currentNetworkId && (
      <NewAnalysisDialog
        networkId={currentNetworkId}
        open={analysisDialogOpen}
        onClose={() => setAnalysisDialogOpen(false)}
        onSubmit={handleSubmitAnalysis}
      />
    )}
    <Dialog open={analyzing || saving}>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <CircularProgress color="primary" />
        <Typography>{saving ? 'Saving results…' : 'Analyzing network…'}</Typography>
      </DialogContent>
      {/* Cancel only while the worker runs; the saving phase isn't cancellable. */}
      {analyzing && (
        <DialogActions>
          <Button variant="outlined" color="error" onClick={handleCancelAnalysis}>
            Cancel
          </Button>
        </DialogActions>
      )}
    </Dialog>
    <Dialog open={noResultsOpen} onClose={() => setNoResultsOpen(false)}>
      <DialogTitle>No Results</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ whiteSpace: 'pre-line' }}>
          {'No clusters were found.\n'
            + 'You can try changing the MCODE parameters or\n'
            + 'modifying your node selection if you are using\n'
            + 'a selection-specific scope.'}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setNoResultsOpen(false)} variant="contained">
          OK
        </Button>
      </DialogActions>
    </Dialog>
    </>
  )
}

export default MCODEPanel
