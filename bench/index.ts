/* eslint-disable no-console */
import type { AnyFunction } from '../src/utils'
import { readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import process from 'node:process'
import emotionMemoize from '@emotion/memoize'
import { memoize as fastMemoize } from '@formatjs/fast-memoize'
import lodashMemoize from 'lodash.memoize'
import memoizePkg from 'memoize'
import memoizee from 'memoizee'
import { memoize as memoza } from '../src/memoize'

const HIT_TRIALS = 7
const MISS_TRIALS = 5
const WARMUP_ROUNDS = 10_000
const HIT_DATASET_SIZE = 256
const HIT_ROUNDS = 2_500
const MISS_COUNT = 50_000

let sink = 0
function blackhole(value: number) {
  sink ^= value | 0
}

interface Obj { id: number, tag: string, nested: { even: boolean, score: number } }

interface Competitor {
  label: string
  packageName: string
  create: (fn: AnyFunction) => AnyFunction
}

interface Suite {
  title: string
  note?: string
  trials: number
  competitors: Record<string, Competitor>
  trial: (create: (fn: AnyFunction) => AnyFunction) => { ms: number, operations: number }
}

function stringWorkload(input: string) {
  let total = 0
  for (let i = 0; i < input.length; i++)
    total += input.charCodeAt(i) * (i + 1)
  return total
}

function tupleWorkload(a: number, b: number) {
  return (a * 31) ^ (b * 17)
}

function objectWorkload(v: Obj) {
  return v.id * 101 + v.tag.length * 7 + (v.nested.even ? 1 : 0) + v.nested.score
}

const hitKeys = Array.from({ length: HIT_DATASET_SIZE }, (_, i) => `key-${i % 61}-${i}`)
const missKeys = Array.from({ length: MISS_COUNT }, (_, i) => `miss-${i}-${i * 17}`)
const tupleKeys = Array.from({ length: HIT_DATASET_SIZE }, (_, i) => [i % 97, (i * 7) % 101] as const)
const objectTags = Array.from({ length: 11 }, (_, i) => `group-${i}`)

// Built per call so the object suite really measures by-value keying rather
// than repeated lookups of the same few references.
function makeObject(i: number): Obj {
  return {
    id: i % 79,
    tag: objectTags[i % 11]!,
    nested: { even: i % 2 === 0, score: (i * 13) % 17 },
  }
}

const jsonStringify = JSON.stringify as (value: unknown) => string

const SUITES: Record<string, Suite> = {
  'unary-hit': {
    title: 'Unary string argument — hot cache hits',
    note: 'All libraries use their natural unary-string path here.',
    trials: HIT_TRIALS,
    competitors: {
      'memoza': { label: 'memoza', packageName: 'memoza', create: fn => memoza(fn) },
      'memoize': { label: 'memoize', packageName: 'memoize', create: fn => memoizePkg(fn) },
      'lodash': { label: 'lodash.memoize', packageName: 'lodash.memoize', create: fn => lodashMemoize(fn) },
      'memoizee': { label: 'memoizee', packageName: 'memoizee', create: fn => memoizee(fn) },
      'emotion': { label: '@emotion/memoize', packageName: '@emotion/memoize', create: fn => emotionMemoize(fn) },
      'fast-memoize': { label: '@formatjs/fast-memoize', packageName: '@formatjs/fast-memoize', create: fn => fastMemoize(fn) },
    },
    trial: (create) => {
      const memoized = create(stringWorkload) as (input: string) => number

      for (let r = 0; r < WARMUP_ROUNDS; r++)
        blackhole(memoized(hitKeys[r % hitKeys.length]!))

      let operations = 0
      const start = performance.now()

      for (let r = 0; r < HIT_ROUNDS; r++) {
        for (let i = 0; i < hitKeys.length; i++) {
          blackhole(memoized(hitKeys[i]!))
          operations++
        }
      }

      return { ms: performance.now() - start, operations }
    },
  },

  'unary-miss': {
    title: 'Unary string argument — cold misses',
    note: 'Each call uses a unique string key, so this mainly reflects cache insertion overhead.',
    trials: MISS_TRIALS,
    competitors: {
      'memoza': { label: 'memoza', packageName: 'memoza', create: fn => memoza(fn) },
      'memoize': { label: 'memoize', packageName: 'memoize', create: fn => memoizePkg(fn) },
      'lodash': { label: 'lodash.memoize', packageName: 'lodash.memoize', create: fn => lodashMemoize(fn) },
      'memoizee': { label: 'memoizee', packageName: 'memoizee', create: fn => memoizee(fn) },
      'emotion': { label: '@emotion/memoize', packageName: '@emotion/memoize', create: fn => emotionMemoize(fn) },
      'fast-memoize': { label: '@formatjs/fast-memoize', packageName: '@formatjs/fast-memoize', create: fn => fastMemoize(fn) },
    },
    trial: (create) => {
      const memoized = create(stringWorkload) as (input: string) => number

      let operations = 0
      const start = performance.now()

      for (let i = 0; i < missKeys.length; i++) {
        blackhole(memoized(missKeys[i]!))
        operations++
      }

      return { ms: performance.now() - start, operations }
    },
  },

  'multi-hit': {
    title: 'Two primitive arguments — hot cache hits',
    note: 'Libraries that need custom keying are configured to cache both arguments by value.',
    trials: HIT_TRIALS,
    competitors: {
      'memoza': { label: 'memoza', packageName: 'memoza', create: fn => memoza(fn) },
      'memoize': { label: 'memoize (cacheKey: JSON.stringify)', packageName: 'memoize', create: fn => memoizePkg(fn, { cacheKey: jsonStringify }) },
      'lodash': { label: 'lodash.memoize (resolver)', packageName: 'lodash.memoize', create: fn => lodashMemoize(fn, (...args: unknown[]) => JSON.stringify(args)) },
      'memoizee': { label: 'memoizee', packageName: 'memoizee', create: fn => memoizee(fn) },
      'fast-memoize': { label: '@formatjs/fast-memoize', packageName: '@formatjs/fast-memoize', create: fn => fastMemoize(fn) },
    },
    trial: (create) => {
      const memoized = create(tupleWorkload) as (a: number, b: number) => number

      for (let r = 0; r < WARMUP_ROUNDS; r++) {
        const pair = tupleKeys[r % tupleKeys.length]!
        blackhole(memoized(pair[0], pair[1]))
      }

      let operations = 0
      const start = performance.now()

      for (let r = 0; r < HIT_ROUNDS; r++) {
        for (let i = 0; i < tupleKeys.length; i++) {
          const pair = tupleKeys[i]!
          blackhole(memoized(pair[0], pair[1]))
          operations++
        }
      }

      return { ms: performance.now() - start, operations }
    },
  },

  'object-hit': {
    title: 'Single object argument by value — hot cache hits',
    note: 'Every call allocates a fresh object; libraries are configured for by-value caching where needed.',
    trials: HIT_TRIALS,
    competitors: {
      'memoza': { label: 'memoza', packageName: 'memoza', create: fn => memoza(fn) },
      'memoize': { label: 'memoize (cacheKey: JSON.stringify)', packageName: 'memoize', create: fn => memoizePkg(fn, { cacheKey: jsonStringify }) },
      'lodash': { label: 'lodash.memoize (resolver)', packageName: 'lodash.memoize', create: fn => lodashMemoize(fn, jsonStringify) },
      'memoizee': { label: 'memoizee (normalizer: JSON.stringify)', packageName: 'memoizee', create: fn => memoizee(fn, { normalizer: jsonStringify }) },
      'fast-memoize': { label: '@formatjs/fast-memoize', packageName: '@formatjs/fast-memoize', create: fn => fastMemoize(fn) },
    },
    trial: (create) => {
      const memoized = create(objectWorkload) as (value: Obj) => number

      for (let r = 0; r < WARMUP_ROUNDS; r++)
        blackhole(memoized(makeObject(r % HIT_DATASET_SIZE)))

      let operations = 0
      const start = performance.now()

      for (let r = 0; r < HIT_ROUNDS; r++) {
        for (let i = 0; i < HIT_DATASET_SIZE; i++) {
          blackhole(memoized(makeObject(i)))
          operations++
        }
      }

      return { ms: performance.now() - start, operations }
    },
  },
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

// --- child: one library, one suite, one process ----------------------------

const [suiteId, competitorId] = process.argv.slice(2)

if (suiteId !== undefined && competitorId !== undefined) {
  const suite = SUITES[suiteId]
  const competitor = suite?.competitors[competitorId]

  if (!suite || !competitor) {
    console.error(`unknown suite/competitor: ${suiteId} ${competitorId}`)
    process.exit(1)
  }

  const samples: number[] = []
  let operations = 0

  for (let trial = 0; trial < suite.trials; trial++) {
    const result = suite.trial(competitor.create)
    samples.push(result.ms)
    operations = result.operations
  }

  const medianMs = median(samples)
  console.log(JSON.stringify({
    medianMs,
    minMs: Math.min(...samples),
    opsPerSecond: operations / (medianMs / 1000),
    sink,
  }))
  process.exit(0)
}

// --- parent: spawn one process per library ---------------------------------

interface Result {
  label: string
  medianMs: number
  minMs: number
  opsPerSecond: number
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const fmt = (n: number) => nf.format(n)

function runChild(suite: string, competitor: string): Result {
  const { label } = SUITES[suite]!.competitors[competitor]!
  const child = Bun.spawnSync([process.execPath, import.meta.path, suite, competitor], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (child.exitCode !== 0)
    throw new Error(`${suite}/${competitor} failed:\n${child.stderr.toString()}`)

  const payload = JSON.parse(child.stdout.toString().trim().split('\n').pop()!)
  return { label, ...payload }
}

function printSuite(suite: Suite, rows: Result[], markdown: boolean) {
  const sorted = [...rows].sort((a, b) => b.opsPerSecond - a.opsPerSecond)
  const fastest = sorted[0]!.opsPerSecond
  const cell = (r: Result) => [
    r.label,
    `${fmt(r.opsPerSecond)} ops/s`,
    `${fmt(r.medianMs)} ms`,
    `${(fastest / r.opsPerSecond).toFixed(2)}x`,
  ]
  const header = ['Library', 'Median throughput', 'Median time', 'vs fastest']

  if (markdown) {
    console.log(`\n### ${suite.title}\n`)
    if (suite.note)
      console.log(`${suite.note}\n`)
    console.log(`| ${header.join(' | ')} |`)
    console.log(`|---|---|---|---|`)
    for (const r of sorted)
      console.log(`| ${cell(r).join(' | ')} |`)
    return
  }

  console.log(`\n# ${suite.title}`)
  if (suite.note)
    console.log(suite.note)

  const widths = header.map((h, i) => Math.max(h.length, ...sorted.map(r => cell(r)[i]!.length)))
  const line = (values: string[]) => values
    .map((v, i) => (i === 0 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!)))
    .join(' | ')

  console.log(line(header))
  console.log(widths.map(w => '-'.repeat(w)).join('-|-'))
  for (const r of sorted)
    console.log(line(cell(r)))
}

const markdown = process.env.BENCH_MARKDOWN === '1'
const versions = new Map<string, string>()

for (const suite of Object.values(SUITES)) {
  for (const { packageName } of Object.values(suite.competitors)) {
    if (!versions.has(packageName)) {
      const path = packageName === 'memoza' ? 'package.json' : `node_modules/${packageName}/package.json`
      versions.set(packageName, JSON.parse(readFileSync(path, 'utf8')).version)
    }
  }
}

const environment = [
  `Runtime: Bun ${Bun.version}`,
  `CPU: ${cpus()[0]!.model}`,
  `Trials: ${HIT_TRIALS} per library (${MISS_TRIALS} for cold misses), median reported`,
  `Hot-cache workload: ${HIT_DATASET_SIZE} keys x ${HIT_ROUNDS} rounds`,
  `Cold-miss workload: ${MISS_COUNT} unique calls`,
  `Versions: ${[...versions].map(([name, version]) => `${name}@${version}`).join(', ')}`,
]

if (markdown) {
  console.log('<!-- generated by `bun bench/index.ts`, BENCH_MARKDOWN=1 -->')
  console.log(environment.map(l => `- ${l}`).join('\n'))
}
else {
  console.log('Memoization benchmark comparison')
  console.log(environment.join('\n'))
  console.log('')
  console.log('Each library runs in its own process, so JIT state and call-site')
  console.log('polymorphism from one library cannot skew the next.')
  console.log('@emotion/memoize only supports a single string argument, so it only')
  console.log('appears in the unary string suites.')
}

for (const [id, suite] of Object.entries(SUITES)) {
  const results = Object.keys(suite.competitors).map(competitor => runChild(id, competitor))
  printSuite(suite, results, markdown)
}
