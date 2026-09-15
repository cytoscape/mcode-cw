/**
 * Unit tests for the cluster layout model, ported from
 * `ClusterLayoutModelTest` in the MCODE app for Cytoscape Desktop
 * (LGPL v2.1+). The random graphs are generated with a faithful
 * `java.util.Random`, so every case runs on exactly the input the Java test
 * used.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClusterLayoutOptions,
  ClusterLayoutResult,
  DEFAULT_CLUSTER_LAYOUT_OPTIONS,
  layoutClusters,
  ringCount,
} from './clusterLayoutModel'
import { CLUSTER_LAYOUT_GOLDEN } from './__fixtures__/clusterLayoutGolden'

const NODE = 30

/** `java.util.Random` (48-bit LCG), enough of it for `nextInt(bound)`. */
class JavaRandom {
  private static readonly MULTIPLIER = 0x5deece66dn
  private static readonly MASK = (1n << 48n) - 1n
  private seed: bigint

  constructor(seed: number) {
    this.seed = (BigInt(seed) ^ JavaRandom.MULTIPLIER) & JavaRandom.MASK
  }

  private next(bits: number): number {
    this.seed = (this.seed * JavaRandom.MULTIPLIER + 0xbn) & JavaRandom.MASK
    // Signed 32-bit result, like Java's `(int) (seed >>> (48 - bits))`.
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)))
  }

  nextInt(bound: number): number {
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n)
    }
    let bits: number
    let val: number
    do {
      bits = this.next(31)
      val = bits % bound
    } while (bits - val + (bound - 1) > 0x7fffffff)
    return val
  }
}

type Graph = { clusterOf: number[]; src: number[]; tgt: number[] }

/** Planted clusters of the given sizes, `unclustered` extra nodes, random edges. */
function graph(sizes: number[], unclustered: number, interEdges: number, seed: number): Graph {
  const n = sizes.reduce((a, b) => a + b, 0) + unclustered
  const clusterOf: number[] = []
  sizes.forEach((size, c) => {
    for (let i = 0; i < size; i++) clusterOf.push(c)
  })
  while (clusterOf.length < n) clusterOf.push(-1)
  const rnd = new JavaRandom(seed)
  const src: number[] = []
  const tgt: number[] = []
  for (let e = 0; e < interEdges; e++) {
    src.push(rnd.nextInt(n))
    let t: number
    do {
      t = rnd.nextInt(n)
    } while (t === src[e])
    tgt.push(t)
  }
  return { clusterOf, src, tgt }
}

function sizes(n: number): number[] {
  return new Array<number>(n).fill(NODE)
}

function options(overrides: Partial<ClusterLayoutOptions> = {}): ClusterLayoutOptions {
  return { ...DEFAULT_CLUSTER_LAYOUT_OPTIONS, ...overrides }
}

function run(g: Graph, clusterCount: number, o = options()): ClusterLayoutResult {
  return layoutClusters(g.clusterOf, clusterCount, g.src, g.tgt, sizes(g.clusterOf.length), null, o)
}

const dist = (r: ClusterLayoutResult, i: number, cx: number, cy: number): number =>
  Math.hypot(r.x[i] - cx, r.y[i] - cy)

test('every node gets a finite position and nodes do not coincide', () => {
  const g = graph([40, 12, 1], 25, 300, 1)
  const r = run(g, 3)
  const n = g.clusterOf.length
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(r.x[i]) && Number.isFinite(r.y[i]))
    for (let j = i + 1; j < n; j++) {
      assert.ok(
        Math.hypot(r.x[i] - r.x[j], r.y[i] - r.y[j]) >= NODE * 0.9,
        `nodes ${i} and ${j} overlap`,
      )
    }
  }
})

test('cluster disks do not overlap and members stay inside their disk', () => {
  const g = graph([60, 30, 30, 5, 5], 40, 600, 2)
  const o = options()
  const r = run(g, 5, o)
  for (let a = 0; a < 5; a++) {
    for (let b = a + 1; b < 5; b++) {
      const d = Math.hypot(r.clusterX[a] - r.clusterX[b], r.clusterY[a] - r.clusterY[b])
      assert.ok(
        d >= r.clusterRadius[a] + r.clusterRadius[b] + o.clusterSpacing - 1e-6,
        `disks ${a},${b} overlap: ${d}`,
      )
    }
  }
  for (let i = 0; i < g.clusterOf.length; i++) {
    const c = g.clusterOf[i]
    if (c < 0) continue
    assert.ok(dist(r, i, r.clusterX[c], r.clusterY[c]) <= r.clusterRadius[c] + 1e-6)
  }
})

test('highest score sits at the cluster center', () => {
  const clusterOf = [0, 0, 0, 0, 0, 0, 0]
  const score = [1, 2, 9, 3, 4, 5, 6]
  const r = layoutClusters(clusterOf, 1, [], [], sizes(7), score, options())
  assert.ok(Math.abs(r.clusterX[0] - r.x[2]) < 1e-9)
  assert.ok(Math.abs(r.clusterY[0] - r.y[2]) < 1e-9)
  for (let i = 0; i < 7; i++) {
    if (i !== 2) assert.ok(dist(r, i, r.clusterX[0], r.clusterY[0]) > NODE / 2)
  }
})

test('satellites sit around the cluster they connect to most', () => {
  // clusters 0 (nodes 0-4) and 1 (nodes 5-9); node 10 has 3 edges to cluster 1 and 1 to cluster 0
  const clusterOf = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, -1]
  const src = [10, 10, 10, 10]
  const tgt = [5, 6, 7, 0]
  const r = layoutClusters(clusterOf, 2, src, tgt, sizes(11), null, options())
  const d0 = dist(r, 10, r.clusterX[0], r.clusterY[0])
  const d1 = dist(r, 10, r.clusterX[1], r.clusterY[1])
  assert.ok(d1 < d0)
  assert.ok(d1 <= r.clusterRadius[1] + 1e-6) // inside the satellite ring counted in the radius
})

test('unclustered nodes form their own disks when satellites are off', () => {
  const clusterOf = [0, 0, 0, 1, 1, 1, -1, -1, -1]
  const src = [6, 7, 7]
  const tgt = [0, 3, 8] // 6 alone; 7-8 form a component
  const r = layoutClusters(clusterOf, 2, src, tgt, sizes(9), null, options({ satellites: false }))
  assert.equal(r.clusterX.length, 4) // 2 clusters + 2 component disks
  for (let i = 6; i < 9; i++) {
    for (let c = 0; c < 2; c++) {
      assert.ok(dist(r, i, r.clusterX[c], r.clusterY[c]) > r.clusterRadius[c])
    }
  }
  // 7 and 8 share a disk, 6 is elsewhere
  assert.ok(
    Math.hypot(r.x[7] - r.x[8], r.y[7] - r.y[8]) < Math.hypot(r.x[7] - r.x[6], r.y[7] - r.y[6]),
  )
})

test('satellites attach by graph distance in hop order', () => {
  // cluster 0 = nodes 0-4 (core radius 65 -> first satellite ring holds 14 nodes at radius 115);
  // nodes 5-18 touch the cluster (hop 1), nodes 19-25 only touch node 5 (hop 2)
  const n = 26
  const clusterOf = new Array<number>(n).fill(-1)
  for (let i = 0; i < 5; i++) clusterOf[i] = 0
  const src: number[] = []
  const tgt: number[] = []
  for (let i = 5; i <= 18; i++) {
    src.push(i)
    tgt.push(0)
  }
  for (let i = 19; i <= 25; i++) {
    src.push(i)
    tgt.push(5)
  }
  const r = layoutClusters(clusterOf, 1, src, tgt, sizes(n), null, options())
  assert.equal(r.clusterX.length, 1)
  let maxHop1 = 0
  let minHop2 = Number.MAX_VALUE
  for (let i = 5; i <= 18; i++) maxHop1 = Math.max(maxHop1, dist(r, i, r.clusterX[0], r.clusterY[0]))
  for (let i = 19; i <= 25; i++) minHop2 = Math.min(minHop2, dist(r, i, r.clusterX[0], r.clusterY[0]))
  assert.ok(maxHop1 < minHop2, `hop-1 nodes must be inside hop-2 nodes: ${maxHop1} vs ${minHop2}`)
  for (let i = 5; i < n; i++) {
    assert.ok(dist(r, i, r.clusterX[0], r.clusterY[0]) <= r.clusterRadius[0] + 1e-6)
  }
})

test('isolated nodes form a grid outside everything', () => {
  const clusterOf = [0, 0, 0, -1, -1, -1, -1]
  const r = layoutClusters(clusterOf, 1, [], [], sizes(7), null, options())
  for (let i = 3; i < 7; i++) assert.ok(r.x[i] > r.clusterX[0] + r.clusterRadius[0])
})

test('deterministic for the same input', () => {
  const g = graph([20, 20, 20], 30, 200, 3)
  const a = run(g, 3)
  const b = run(g, 3)
  assert.deepEqual(a.x, b.x)
  assert.deepEqual(a.y, b.y)
})

test('hundreds of singleton clusters stay finite and compact', () => {
  // every node its own cluster (e.g. cluster column = "name"), hubs with many edges
  const n = 500
  const clusterOf = Array.from({ length: n }, (_, i) => i)
  const rnd = new JavaRandom(5)
  const src: number[] = []
  const tgt: number[] = []
  for (let e = 0; e < 1500; e++) {
    src.push(rnd.nextInt(20)) // 20 hubs
    tgt.push(20 + rnd.nextInt(n - 20))
  }
  const t0 = Date.now()
  const r = layoutClusters(clusterOf, n, src, tgt, sizes(n), null, options())
  const ms = Date.now() - t0
  let maxCoord = 0
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(r.x[i]) && Number.isFinite(r.y[i]))
    maxCoord = Math.max(maxCoord, Math.abs(r.x[i]), Math.abs(r.y[i]))
  }
  // 500 disks of ~30 units plus 100 gaps: the drawing cannot legitimately be wider than ~65k units
  assert.ok(maxCoord < 500 * (NODE + 100), `layout exploded: ${maxCoord}`)
  assert.ok(ms < 20_000, `too slow: ${ms} ms`)
})

test('empty input and no clusters', () => {
  const empty = layoutClusters([], 0, [], [], [], null, options())
  assert.equal(empty.x.length, 0)
  const clusterOf = [-1, -1, -1]
  const r = layoutClusters(clusterOf, 0, [0, 1], [1, 2], [30, 30, 30], null, options())
  for (let i = 0; i < 3; i++) assert.ok(Number.isFinite(r.x[i]) && Number.isFinite(r.y[i]))
})

test('the cancel callback stops the placement pass early but still yields positions', () => {
  const g = graph([10, 10, 10, 10], 0, 80, 7)
  const r = run(g, 4)
  const r2 = layoutClusters(g.clusterOf, 4, g.src, g.tgt, sizes(40), null, options(), () => true)
  // Same geometry (disk radii), all positions finite, but the placement differs.
  assert.deepEqual(r2.clusterRadius, r.clusterRadius)
  for (let i = 0; i < 40; i++) assert.ok(Number.isFinite(r2.x[i]) && Number.isFinite(r2.y[i]))
})

test('ring capacity follows floor(2πr / step)', () => {
  // ring 0 holds 1, ring 1 (r = step) holds 6, ring 2 holds 12
  assert.equal(ringCount(0, 50), 0)
  assert.equal(ringCount(1, 50), 1)
  assert.equal(ringCount(7, 50), 2)
  assert.equal(ringCount(8, 50), 3)
  assert.equal(ringCount(19, 50), 3)
  assert.equal(ringCount(20, 50), 4)
})

test('matches the Java ClusterLayoutModel output on the golden graphs', () => {
  for (const g of CLUSTER_LAYOUT_GOLDEN) {
    const r = layoutClusters(
      g.clusterOf,
      g.clusterCount,
      g.src,
      g.tgt,
      sizes(g.clusterOf.length),
      g.score,
      options({ satellites: g.satellites }),
    )
    const check = (label: string, actual: Float64Array, expected: number[]): void => {
      assert.equal(actual.length, expected.length, `${g.name}: ${label} length`)
      for (let i = 0; i < expected.length; i++) {
        assert.ok(
          Math.abs(actual[i] - expected[i]) < 1e-9,
          `${g.name}: ${label}[${i}] = ${actual[i]}, Java gave ${expected[i]}`,
        )
      }
    }
    check('x', r.x, g.x)
    check('y', r.y, g.y)
    check('clusterX', r.clusterX, g.clusterX)
    check('clusterY', r.clusterY, g.clusterY)
    check('clusterRadius', r.clusterRadius, g.clusterRadius)
  }
})
