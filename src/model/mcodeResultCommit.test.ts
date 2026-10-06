import assert from 'node:assert/strict'
import test from 'node:test'

import type { ApiResult, CellEdit, ValueType, ValueTypeName } from '@cytoscape-web/api-types'

import { MCODEAlgorithm } from './mcodeAlgorithm'
import { mcodeColumnNames } from './mcodeExport'
import { commitMcodeResult, McodeResultCommitApis } from './mcodeResultCommit'
import { discardAllResults, getMcodeResults } from './mcodeResultStore'
import { AdjacencyMap } from './mcodeTypes'

// `ok()` / `fail()` live in the api-types package, which ships declarations
// only, so the fakes build the result objects by hand.
const ok = <T>(data: T): ApiResult<T> => ({ success: true, data })
const okVoid = (): ApiResult => ({ success: true, data: undefined })
const failed = (message: string): ApiResult =>
  ({ success: false, error: { code: 'TEST', message } }) as unknown as ApiResult

/** A triangle plus a pendant node: one cluster of three, one unclustered node. */
function triangleWithTail(): AdjacencyMap {
  return new Map([
    ['a', ['b', 'c']],
    ['b', ['a', 'c']],
    ['c', ['a', 'b', 'd']],
    ['d', ['c']],
  ])
}

interface Recorded {
  columns: Array<{ name: string; type: ValueTypeName; defaultValue: ValueType }>
  edits: CellEdit[]
  summaryCalls: string[]
}

function fakeApis(options: { summaryFails?: boolean; columnFails?: boolean } = {}): {
  apis: McodeResultCommitApis
  recorded: Recorded
} {
  const recorded: Recorded = { columns: [], edits: [], summaryCalls: [] }
  const apis: McodeResultCommitApis = {
    workspace: {
      getNetworkSummary: (networkId) => {
        recorded.summaryCalls.push(networkId)
        return options.summaryFails
          ? (failed('no such network') as never)
          : (ok({ id: networkId, name: 'galFiltered' }) as never)
      },
    },
    table: {
      createColumn: (_networkId, _tableType, name, type, defaultValue) => {
        recorded.columns.push({ name, type, defaultValue })
        return options.columnFails ? failed('column exists') : okVoid()
      },
      setValues: (_networkId, _tableType, cellEdits) => {
        recorded.edits.push(...cellEdits)
        return okVoid()
      },
    },
  }
  return { apis, recorded }
}

test.beforeEach(() => discardAllResults())

test('adds a numbered, named result to the store and selects it', () => {
  const algorithm = new MCODEAlgorithm()
  const clusters = algorithm.run(triangleWithTail())
  assert.equal(clusters.length, 1)

  const { apis, recorded } = fakeApis()
  const result = commitMcodeResult(apis, 'net-1', clusters, algorithm)

  assert.equal(result.id, 1)
  assert.equal(result.name, '1 - galFiltered')
  assert.equal(result.networkId, 'net-1')
  assert.equal(result.clusters, clusters)
  assert.equal(result.algorithm, algorithm)
  assert.deepEqual(recorded.summaryCalls, ['net-1'])

  const state = getMcodeResults()
  assert.deepEqual(state.results, [result])
  assert.equal(state.selectedResult, result)
  assert.equal(state.selectedCluster, null)

  // A second commit takes the next id, so its columns cannot collide.
  const second = commitMcodeResult(apis, 'net-1', clusters, algorithm)
  assert.equal(second.id, 2)
  assert.equal(second.name, '2 - galFiltered')
})

test('creates the three MCODE columns and writes a row per scored node', () => {
  const algorithm = new MCODEAlgorithm()
  const clusters = algorithm.run(triangleWithTail())
  const { apis, recorded } = fakeApis()

  commitMcodeResult(apis, 'net-1', clusters, algorithm)

  assert.deepEqual(
    recorded.columns.map((c) => c.name),
    mcodeColumnNames(1),
  )
  // Every node is scored, so every one gets a score and a status; the cluster
  // list is written for clustered nodes only (unclustered keep the column
  // default).
  const byNode = new Map<string, Map<string, ValueType>>()
  for (const edit of recorded.edits) {
    if (!byNode.has(edit.id)) byNode.set(edit.id, new Map())
    byNode.get(edit.id)!.set(edit.column, edit.value)
  }
  assert.deepEqual([...byNode.keys()].sort(), ['a', 'b', 'c', 'd'])
  const [score, status, members] = mcodeColumnNames(1)
  for (const values of byNode.values()) assert.equal(typeof values.get(score), 'number')
  assert.equal(byNode.get('d')!.size, 2)
  assert.equal(byNode.get('d')!.get(status), 'Unclustered')
  for (const nodeId of ['a', 'b', 'c']) {
    assert.equal(byNode.get(nodeId)!.size, 3)
    assert.deepEqual(byNode.get(nodeId)!.get(members), ['Cluster 1'])
  }
  assert.equal(byNode.get(clusters[0].seedId)!.get(status), 'Seed')
})

test('falls back to the network id as the name and survives column failures', () => {
  const algorithm = new MCODEAlgorithm()
  const clusters = algorithm.run(triangleWithTail())
  const { apis, recorded } = fakeApis({ summaryFails: true, columnFails: true })

  const result = commitMcodeResult(apis, 'net-9', clusters, algorithm)

  assert.equal(result.name, '1 - net-9')
  assert.equal(getMcodeResults().results.length, 1)
  // The values are still written even when the columns could not be created
  // (they may already exist from an earlier session).
  assert.ok(recorded.edits.length > 0)
})
