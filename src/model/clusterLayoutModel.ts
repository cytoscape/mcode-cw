/**
 * MCODE Cluster Layout — the layout model, computed on plain arrays with no
 * Cytoscape Web / React dependency.
 *
 * TypeScript port of `ClusterLayoutModel` from the MCODE app for Cytoscape
 * Desktop (MCODE 2.1.0, LGPL v2.1+; see mcodeTypes.ts for attribution). The
 * port is deliberately line-for-line so that it produces the same coordinates
 * as the Java implementation, modulo last-ulp floating-point differences.
 *
 * Two-level layout:
 *   1. Members of each cluster are packed on concentric rings ordered by score
 *      (best in the center).
 *   2. Unclustered nodes become *satellites* of the nearest cluster by graph
 *      distance (a level-synchronous BFS from all clustered nodes; ties go to
 *      the cluster with most connections), on rings ordered by hop distance and
 *      by the direction of their other connections.
 *   3. Cluster disks (members plus satellite rings) are placed by a small
 *      force-directed pass with collision avoidance: connected clusters attract
 *      in proportion to their inter-cluster edge count, every disk is pulled
 *      gently toward the center, and overlapping disks are pushed apart.
 *   4. Unclustered nodes that reach no cluster form one disk per connected
 *      component; isolated nodes go into a grid to the right.
 *
 * The result is centered on the origin; callers translate it where they need
 * it. Everything is deterministic — there is no randomness anywhere.
 */

/** Cluster index of a node that belongs to no cluster. */
export const NO_CLUSTER = -1

export interface ClusterLayoutOptions {
  /** Gap between neighbouring nodes, in view units. */
  nodeSpacing: number
  /** Gap between cluster disks, in view units. */
  clusterSpacing: number
  /**
   * Attach unclustered nodes to the nearest cluster; otherwise they form
   * disks per connected component.
   */
  satellites: boolean
  /** Iterations of the cluster placement pass. */
  iterations: number
}

export const DEFAULT_CLUSTER_LAYOUT_OPTIONS: Readonly<ClusterLayoutOptions> = {
  nodeSpacing: 20,
  clusterSpacing: 100,
  satellites: true,
  iterations: 300,
}

/** Result: node coordinates plus the disk geometry, for tests and diagnostics. */
export interface ClusterLayoutResult {
  /** Node coordinates, indexed like `clusterOf`. */
  x: Float64Array
  y: Float64Array
  /**
   * Center and radius of every disk: the `clusterCount` real clusters first
   * (in cluster-index order), followed by one disk per connected component
   * of unclustered nodes that reached no cluster.
   */
  clusterX: Float64Array
  clusterY: Float64Array
  clusterRadius: Float64Array
}

/**
 * Lay out the graph.
 *
 * @param clusterOf cluster index per node, `NO_CLUSTER` for unclustered nodes
 * @param clusterCount number of clusters (indices 0 to clusterCount - 1)
 * @param edgeSrc source node index per edge
 * @param edgeTgt target node index per edge
 * @param nodeSize node diameter per node (width or height, whichever is larger)
 * @param score ordering score per node (higher = closer to the cluster
 *   center), or null to order by degree
 * @param options layout options
 * @param cancelled polled during the placement pass; when it returns true the
 *   result is whatever was computed so far
 */
export function layoutClusters(
  clusterOf: ArrayLike<number>,
  clusterCount: number,
  edgeSrc: ArrayLike<number>,
  edgeTgt: ArrayLike<number>,
  nodeSize: ArrayLike<number>,
  score: ArrayLike<number> | null,
  options: Readonly<ClusterLayoutOptions> = DEFAULT_CLUSTER_LAYOUT_OPTIONS,
  cancelled?: () => boolean,
): ClusterLayoutResult {
  const n = clusterOf.length
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  if (n === 0) {
    return {
      x,
      y,
      clusterX: new Float64Array(0),
      clusterY: new Float64Array(0),
      clusterRadius: new Float64Array(0),
    }
  }

  let diameter = 10
  for (let i = 0; i < nodeSize.length; i++) {
    const s = nodeSize[i]
    if (Number.isFinite(s)) diameter = Math.max(diameter, s)
  }
  // Center-to-center distance of neighbours.
  const step = diameter + options.nodeSpacing

  // ── adjacency (self-loops ignored) and degree ──────────────────────────────
  const edgeCount = edgeSrc.length
  const degree = new Int32Array(n)
  for (let e = 0; e < edgeCount; e++) {
    if (edgeSrc[e] === edgeTgt[e]) continue
    degree[edgeSrc[e]]++
    degree[edgeTgt[e]]++
  }
  const adj: Int32Array[] = new Array(n)
  for (let i = 0; i < n; i++) adj[i] = new Int32Array(degree[i])
  const fill = new Int32Array(n)
  for (let e = 0; e < edgeCount; e++) {
    const a = edgeSrc[e]
    const b = edgeTgt[e]
    if (a === b) continue
    adj[a][fill[a]++] = b
    adj[b][fill[b]++] = a
  }
  const order: ArrayLike<number> = score !== null ? score : degree
  const byScore = (a: number, b: number): number => {
    let cmp = compareDouble(order[b], order[a])
    if (cmp === 0) cmp = degree[b] - degree[a]
    return cmp !== 0 ? cmp : a - b
  }
  const byDegree = (a: number, b: number): number => {
    const cmp = degree[b] - degree[a]
    return cmp !== 0 ? cmp : a - b
  }

  // ── members per cluster, ordered by score ──────────────────────────────────
  const members: number[][] = []
  for (let c = 0; c < clusterCount; c++) members.push([])
  for (let i = 0; i < n; i++) {
    if (clusterOf[i] >= 0 && clusterOf[i] < clusterCount) members[clusterOf[i]].push(i)
  }
  for (const m of members) m.sort(byScore)

  // ── satellites: unclustered nodes attached to the nearest cluster ──────────
  // Level-synchronous multi-source BFS from all clustered nodes. At each level
  // a node joins the cluster it has most connections to among the already
  // assigned nodes of the previous level.
  const home = new Int32Array(n).fill(-1)
  const hop = new Int32Array(n)
  const satellites: number[][] = []
  for (let c = 0; c < clusterCount; c++) satellites.push([])
  if (options.satellites && clusterCount > 0) {
    let frontier: number[] = []
    for (let i = 0; i < n; i++) {
      if (clusterOf[i] >= 0 && clusterOf[i] < clusterCount) {
        home[i] = clusterOf[i]
        frontier.push(i)
      }
    }
    let level = 0
    while (frontier.length > 0) {
      level++
      const votes = new Map<number, Map<number, number>>()
      for (const u of frontier) {
        const neighbors = adj[u]
        for (let k = 0; k < neighbors.length; k++) {
          const v = neighbors[k]
          if (home[v] < 0 && clusterOf[v] < 0) {
            let tally = votes.get(v)
            if (tally === undefined) {
              tally = new Map()
              votes.set(v, tally)
            }
            tally.set(home[u], (tally.get(home[u]) ?? 0) + 1)
          }
        }
      }
      const next = [...votes.keys()].sort((a, b) => a - b) // deterministic
      for (const v of next) {
        // Most votes wins; ties go to the lowest cluster index (order-independent).
        let best = -1
        let bestCount = -1
        for (const [cluster, count] of votes.get(v)!) {
          if (count > bestCount || (count === bestCount && cluster < best)) {
            best = cluster
            bestCount = count
          }
        }
        home[v] = best
        hop[v] = level
        satellites[best].push(v)
      }
      frontier = next
    }
  }

  // ── remaining unclustered nodes: connected components become disks ─────────
  const isolated: number[] = []
  const components: number[][] = []
  {
    const seen = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (clusterOf[i] >= 0 || home[i] >= 0 || seen[i]) continue
      if (degree[i] === 0) {
        isolated.push(i)
        seen[i] = 1
        continue
      }
      const comp: number[] = []
      const stack: number[] = [i]
      seen[i] = 1
      while (stack.length > 0) {
        const u = stack.pop()!
        comp.push(u)
        const neighbors = adj[u]
        for (let k = 0; k < neighbors.length; k++) {
          const v = neighbors[k]
          if (!seen[v] && clusterOf[v] < 0 && home[v] < 0) {
            seen[v] = 1
            stack.push(v)
          }
        }
      }
      comp.sort(byDegree)
      components.push(comp)
    }
  }
  // disks = real clusters followed by component disks
  const disks = clusterCount + components.length
  const diskOf = new Int32Array(n).fill(-1) // disk index per node, -1 for isolated nodes
  const diskMembers: number[][] = [...members, ...components]
  for (let d = 0; d < disks; d++) {
    for (const node of diskMembers[d]) diskOf[node] = d
  }
  for (let i = 0; i < n; i++) {
    if (home[i] >= 0 && clusterOf[i] < 0) diskOf[i] = home[i]
  }

  // ── disk geometry: member rings, then satellite rings ──────────────────────
  const coreRadius = new Float64Array(disks)
  const fullRadius = new Float64Array(disks)
  const satelliteRings = new Int32Array(disks)
  for (let d = 0; d < disks; d++) {
    const m = diskMembers[d].length
    coreRadius[d] = m <= 1 ? diameter / 2 : ringRadius(ringCount(m, step) - 1, step) + diameter / 2
    const s = d < clusterCount ? satellites[d].length : 0
    let r = coreRadius[d]
    let rings = 0
    let remaining = s
    while (remaining > 0) {
      r += step
      rings++
      remaining -= Math.max(1, Math.floor((2 * Math.PI * r) / step))
    }
    satelliteRings[d] = rings
    fullRadius[d] = rings === 0 ? coreRadius[d] : r + diameter / 2
  }

  // ── disk placement ─────────────────────────────────────────────────────────
  const cx = new Float64Array(disks)
  const cy = new Float64Array(disks)
  placeClusters(cx, cy, fullRadius, diskOf, edgeSrc, edgeTgt, options, cancelled)

  // ── member positions ───────────────────────────────────────────────────────
  for (let d = 0; d < disks; d++) {
    const m = diskMembers[d]
    const ringsNeeded = ringCount(m.length, step)
    let idx = 0
    for (let ring = 0; ring < ringsNeeded && idx < m.length; ring++) {
      const r = ringRadius(ring, step)
      const cap = ring === 0 ? 1 : Math.max(1, Math.floor((2 * Math.PI * r) / step))
      const count = Math.min(cap, m.length - idx)
      for (let k = 0; k < count; k++, idx++) {
        const a = (2 * Math.PI * k) / count + ring * 0.5
        const node = m[idx]
        x[node] = cx[d] + r * Math.cos(a)
        y[node] = cy[d] + r * Math.sin(a)
      }
    }
  }

  // ── satellite positions: rings by hop distance, ordered by direction ───────
  if (clusterCount > 0 && satellites.some((s) => s.length > 0)) {
    // Incident edges per node, in edge order, so `preferredAngle` sums the
    // same terms in the same order as a scan over every edge (which is what
    // the Java code does per satellite) without the O(satellites × E) cost.
    const incident = incidentEdges(n, edgeSrc, edgeTgt)
    const angle = new Float64Array(n)
    for (let c = 0; c < clusterCount; c++) {
      const sats = satellites[c]
      if (sats.length === 0) continue
      for (const s of sats) {
        angle[s] = preferredAngle(s, c, cx, cy, diskOf, edgeSrc, edgeTgt, incident[s])
      }
      sats.sort((a, b) => {
        const cmp = hop[a] - hop[b]
        return cmp !== 0 ? cmp : compareDouble(angle[a], angle[b])
      })
      const rings = satelliteRings[c]
      let idx = 0
      for (let r = 0; r < rings && idx < sats.length; r++) {
        const radius = coreRadius[c] + (r + 1) * step
        const cap = Math.max(1, Math.floor((2 * Math.PI * radius) / step))
        const count = Math.min(cap, sats.length - idx)
        const onRing = sats.slice(idx, idx + count)
        onRing.sort((a, b) => compareDouble(angle[a], angle[b]))
        const start = angle[onRing[0]]
        for (let k = 0; k < count; k++) {
          const node = onRing[k]
          const a = start + (2 * Math.PI * k) / count
          x[node] = cx[c] + radius * Math.cos(a)
          y[node] = cy[c] + radius * Math.sin(a)
        }
        idx += count
      }
    }
  }

  // ── isolated nodes in a grid to the right of everything ────────────────────
  if (isolated.length > 0) {
    let extent = 0
    for (let d = 0; d < disks; d++) extent = Math.max(extent, cx[d] + fullRadius[d])
    const cols = Math.ceil(Math.sqrt(isolated.length))
    const left = extent + options.clusterSpacing
    const top = (-Math.floor((isolated.length + cols - 1) / cols) * step) / 2
    for (let k = 0; k < isolated.length; k++) {
      x[isolated[k]] = left + (k % cols) * step
      y[isolated[k]] = top + Math.floor(k / cols) * step
    }
  }

  return { x, y, clusterX: cx, clusterY: cy, clusterRadius: fullRadius }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Number of concentric rings (ring 0 = center node) needed for m nodes. */
export function ringCount(m: number, step: number): number {
  if (m <= 0) return 0
  let rings = 1
  let placed = 1
  while (placed < m) {
    placed += Math.max(1, Math.floor((2 * Math.PI * ringRadius(rings, step)) / step))
    rings++
  }
  return rings
}

export function ringRadius(ring: number, step: number): number {
  return ring * step
}

/**
 * Java's `Double.compare` as a comparator: a total order that also sorts NaN
 * (after every number) consistently, unlike `a - b`.
 */
function compareDouble(a: number, b: number): number {
  if (a < b) return -1
  if (a > b) return 1
  if (a === b) return 0
  // At least one NaN: NaN sorts last.
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1
  return -1
}

/** Edge indices touching each node, in edge order. */
function incidentEdges(
  n: number,
  edgeSrc: ArrayLike<number>,
  edgeTgt: ArrayLike<number>,
): number[][] {
  const incident: number[][] = new Array(n)
  for (let i = 0; i < n; i++) incident[i] = []
  for (let e = 0; e < edgeSrc.length; e++) {
    incident[edgeSrc[e]].push(e)
    if (edgeTgt[e] !== edgeSrc[e]) incident[edgeTgt[e]].push(e)
  }
  return incident
}

/**
 * Direction (from the home cluster center) toward the other clusters a
 * satellite connects to, so satellites can be placed on the side facing their
 * partners. Nodes with no other connection are spread by index.
 */
function preferredAngle(
  node: number,
  home: number,
  cx: Float64Array,
  cy: Float64Array,
  diskOf: Int32Array,
  edgeSrc: ArrayLike<number>,
  edgeTgt: ArrayLike<number>,
  incident: readonly number[],
): number {
  let vx = 0
  let vy = 0
  for (const e of incident) {
    const other = edgeSrc[e] === node ? edgeTgt[e] : edgeSrc[e]
    const oc = diskOf[other]
    if (oc >= 0 && oc !== home) {
      vx += cx[oc] - cx[home]
      vy += cy[oc] - cy[home]
    }
  }
  if (Math.abs(vx) < 1e-9 && Math.abs(vy) < 1e-9) {
    return 2 * Math.PI * ((node * 0.6180339887) % 1.0) // golden-ratio spread, deterministic
  }
  return Math.atan2(vy, vx)
}

/** Force-directed placement of disks with collision avoidance. Deterministic. */
function placeClusters(
  cx: Float64Array,
  cy: Float64Array,
  radius: Float64Array,
  diskOf: Int32Array,
  edgeSrc: ArrayLike<number>,
  edgeTgt: ArrayLike<number>,
  options: Readonly<ClusterLayoutOptions>,
  cancelled: (() => boolean) | undefined,
): void {
  const c = cx.length
  if (c === 0) return
  if (c === 1) {
    cx[0] = 0
    cy[0] = 0
    return
  }
  const gap = options.clusterSpacing

  // Inter-cluster edge weights. Java iterates these in HashMap order; the
  // super-edges are sorted by (a, b) here so the floating-point sums below are
  // reproducible across engines (this is the one place the port may differ
  // from Java beyond the last ulp).
  const weights = new Map<number, number>()
  for (let e = 0; e < edgeSrc.length; e++) {
    const a = diskOf[edgeSrc[e]]
    const b = diskOf[edgeTgt[e]]
    if (a < 0 || b < 0 || a === b) continue
    const key = Math.min(a, b) * c + Math.max(a, b)
    weights.set(key, (weights.get(key) ?? 0) + 1)
  }
  const keys = [...weights.keys()].sort((p, q) => p - q)
  const m = keys.length
  const ea = new Int32Array(m)
  const eb = new Int32Array(m)
  const ew = new Float64Array(m)
  let maxW = 1
  for (let k = 0; k < m; k++) {
    const key = keys[k]
    ea[k] = Math.floor(key / c)
    eb[k] = key % c
    ew[k] = weights.get(key)!
    maxW = Math.max(maxW, ew[k])
  }

  // Initial positions: on a circle, in index (rank) order, large enough to
  // avoid overlaps.
  let perimeter = 0
  for (let i = 0; i < c; i++) perimeter += 2 * radius[i] + gap
  const ring = Math.max(perimeter / (2 * Math.PI), 1)
  let angle = 0
  for (let i = 0; i < c; i++) {
    const arc = (2 * radius[i] + gap) / ring
    angle += arc / 2
    cx[i] = ring * Math.cos(angle)
    cy[i] = ring * Math.sin(angle)
    angle += arc / 2
  }

  // Number of super-edges per cluster: pulls are averaged per cluster so a hub
  // is not moved once per edge (which made the placement diverge for hundreds
  // of single-node clusters).
  const superDegree = new Int32Array(c)
  for (let e = 0; e < m; e++) {
    superDegree[ea[e]]++
    superDegree[eb[e]]++
  }
  // O(c^2) per iteration: keep the total work bounded for very many clusters.
  const iterations = Math.trunc(Math.min(options.iterations, Math.max(20, 2e8 / (c * c))))

  const dx = new Float64Array(c)
  const dy = new Float64Array(c)
  for (let it = 0; it < iterations; it++) {
    if (cancelled !== undefined && cancelled()) break
    const t = 1.0 - it / iterations // cooling
    dx.fill(0)
    dy.fill(0)
    // attraction along inter-cluster edges toward touching distance
    for (let e = 0; e < m; e++) {
      const a = ea[e]
      const b = eb[e]
      const vx = cx[b] - cx[a]
      const vy = cy[b] - cy[a]
      const d = Math.hypot(vx, vy)
      if (d < 1e-9) continue
      const desired = radius[a] + radius[b] + gap
      if (d <= desired) continue
      const strength = 0.2 * Math.sqrt(ew[e] / maxW) * t
      const move = ((d - desired) * strength) / 2
      dx[a] += ((vx / d) * move) / superDegree[a]
      dy[a] += ((vy / d) * move) / superDegree[a]
      dx[b] -= ((vx / d) * move) / superDegree[b]
      dy[b] -= ((vy / d) * move) / superDegree[b]
    }
    // gravity toward the origin keeps unconnected clusters from drifting away
    for (let i = 0; i < c; i++) {
      dx[i] -= cx[i] * 0.02 * t
      dy[i] -= cy[i] * 0.02 * t
    }
    // apply, with the step of each disk capped to its own size
    for (let i = 0; i < c; i++) {
      const len = Math.hypot(dx[i], dy[i])
      const cap = 2 * radius[i] + gap
      if (len > cap) {
        dx[i] *= cap / len
        dy[i] *= cap / len
      }
      cx[i] += dx[i]
      cy[i] += dy[i]
    }
    // collision: push overlapping disks apart (a few relaxation passes)
    for (let pass = 0; pass < 3; pass++) separate(cx, cy, radius, gap)
  }
  // final clean-up so no disks overlap
  for (let pass = 0; pass < 50; pass++) {
    if (!separate(cx, cy, radius, gap)) break
  }
  // re-center
  let mx = 0
  let my = 0
  for (let i = 0; i < c; i++) {
    mx += cx[i]
    my += cy[i]
  }
  for (let i = 0; i < c; i++) {
    cx[i] -= mx / c
    cy[i] -= my / c
  }
}

/** One pass pushing overlapping disks apart; returns true if anything moved. */
function separate(cx: Float64Array, cy: Float64Array, radius: Float64Array, gap: number): boolean {
  const c = cx.length
  let moved = false
  for (let i = 0; i < c; i++) {
    for (let j = i + 1; j < c; j++) {
      let vx = cx[j] - cx[i]
      let vy = cy[j] - cy[i]
      let d = Math.hypot(vx, vy)
      const min = radius[i] + radius[j] + gap
      if (d >= min) continue
      moved = true
      if (d < 1e-9) {
        // coincident: separate along a deterministic direction
        vx = Math.cos(i * 0.7 + j)
        vy = Math.sin(i * 0.7 + j)
        d = 1
      }
      const push = (min - d) / 2 + 1e-6
      cx[i] -= (vx / d) * push
      cy[i] -= (vy / d) * push
      cx[j] += (vx / d) * push
      cy[j] += (vy / d) * push
    }
  }
  return moved
}
