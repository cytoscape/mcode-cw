import assert from 'node:assert/strict'
import test from 'node:test'

import { clusterAssignmentFromClusters, clusterAssignmentFromColumn } from './clusterAssignment'
import { MCODECluster } from './mcodeTypes'

const cluster = (rank: number, nodes: string[]): MCODECluster => ({
  seedId: nodes[0],
  nodes,
  score: 1,
  rank,
})

test('a node in several clusters keeps the best-ranked one', () => {
  const a = clusterAssignmentFromClusters([
    cluster(1, ['a', 'b', 'c']),
    cluster(2, ['c', 'd']),
    cluster(3, ['e']),
  ])
  assert.equal(a.clusterCount, 3)
  assert.equal(a.clusterOf.get('c'), 0)
  assert.equal(a.clusterOf.get('d'), 1)
  assert.equal(a.clusterOf.get('e'), 2)
  assert.equal(a.clusterOf.has('zzz'), false)
})

test('column values become clusters numbered in sorted text order', () => {
  const a = clusterAssignmentFromColumn([
    ['n1', 'beta'],
    ['n2', ' alpha '],
    ['n3', ''],
    ['n4', null],
    ['n5', 'beta'],
    ['n6', 7],
  ])
  assert.equal(a.clusterCount, 3) // "7", "alpha", "beta"
  assert.equal(a.clusterOf.get('n6'), 0)
  assert.equal(a.clusterOf.get('n2'), 1)
  assert.equal(a.clusterOf.get('n1'), 2)
  assert.equal(a.clusterOf.get('n5'), 2)
  assert.equal(a.clusterOf.has('n3'), false)
  assert.equal(a.clusterOf.has('n4'), false)
})
