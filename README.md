# memoza

A memoization library with smart cache-key derivation. Works out of the box for primitives, plain objects, arrays, Maps, Sets — and falls back to reference identity for class instances and functions.

## Install

```sh
npm install memoza
```

## Usage

```ts
import { memoize } from 'memoza'

const add = memoize((a: number, b: number) => a + b)

add(1, 2) // computed
add(1, 2) // from cache
```

## Options

### `maxAge`

Time in milliseconds before a cached entry expires. Defaults to `Infinity`.

```ts
const fn = memoize(fetchUser, { maxAge: 5000 })
```

### `cacheKey`

Custom function to derive the cache key from the arguments.

```ts
const fn = memoize((a: number, b: number) => a + b, {
  cacheKey: (a, b) => `${a}-${b > 2}`,
})

fn(1, 2) // stored
fn(1, 5) // stored
fn(1, 7) // from cache (same key as above)
```

### `stale`

Serve expired entries while they refresh in the background, and keep the last good value when a refresh fails. `true`, or a number of milliseconds past expiry. Defaults to `false`. See [Stale entries](#stale-entries).

### `onError`

Called with every error `stale` swallows. See [Stale entries](#stale-entries).

## Cache utilities

```ts
import { clearMemoizeCache, getCacheStore, isMemoized } from 'memoza'

isMemoized(fn) // true if fn was created with memoize()
getCacheStore(fn) // returns { cache, primitiveCache, fallbackEntries } or null
clearMemoizeCache(fn) // clears all cached entries, including retained stale values
```

## Promise support

Failed promises are automatically evicted from the cache, so the next call retries.

```ts
const fn = memoize(async (id: string) => fetchData(id))

await fn('a') // computed
await fn('a') // from cache
// if the promise rejects, the entry is removed and the next call re-runs
```

## Stale entries

With `stale` enabled, an entry older than `maxAge` is served right away while a single shared background refresh runs for its key. If the refresh fails, the old value stays cached and keeps being served, so the next call retries. Pass a number to limit how long past expiry (in ms) a stale value may still be used, or `true` for no limit — beyond it the cache acts as if the entry wasn't there: calls block and errors propagate. A cold cache is unchanged: a rejection evicts and rethrows.

> **Note:** a failed background refresh never rejects anything the caller can see. `onError` is the only way to find out about it.

This replaces the hand-rolled fallback pattern:

```ts
// before
let last = fallback
const get = memoize(fetchData, { maxAge: 60_000 })
const data = await get().catch(() => last).then(d => (last = d))

// after
const get = memoize(fetchData, {
  maxAge: 60_000,
  stale: true,
  onError: console.error,
})
const data = await get()
```

Sync functions work too: a stale hit returns the previous value while recomputing in the same tick.

## Benchmark

Measured with Bun on Apple Silicon. All suites run 5 trials; results show the median.

### Unary string argument — hot cache hits

| Library | Median throughput | vs fastest |
|---|---|---|
| **memoza** | **38,352,538 ops/s** | **1.00x** |
| lodash.memoize | 35,949,080 ops/s | 1.07x |
| @emotion/memoize | 33,984,481 ops/s | 1.13x |
| memoize | 25,921,470 ops/s | 1.48x |
| @formatjs/fast-memoize | 4,366,373 ops/s | 8.78x |
| memoizee | 2,303,756 ops/s | 16.65x |

### Unary string argument — cold misses

| Library | Median throughput | vs fastest |
|---|---|---|
| **memoza** | **11,073,277 ops/s** | **1.00x** |
| @emotion/memoize | 8,704,925 ops/s | 1.27x |
| lodash.memoize | 8,444,578 ops/s | 1.31x |
| memoize | 8,198,009 ops/s | 1.35x |
| @formatjs/fast-memoize | 2,797,542 ops/s | 3.96x |
| memoizee | 6,612 ops/s | 1674.83x |

### Two primitive arguments — hot cache hits

Libraries requiring multi-arg support are configured with `JSON.stringify` or an equivalent resolver. memoza needs no configuration: all-primitive argument lists are cached in a trie of nested Maps keyed by the raw values, so no key string is ever built.

| Library | Median throughput | vs fastest |
|---|---|---|
| **memoza** | **25,381,466 ops/s** | **1.00x** |
| memoize (cacheKey: JSON.stringify) | 10,773,436 ops/s | 2.36x |
| memoizee | 8,542,312 ops/s | 2.97x |
| lodash.memoize (resolver) | 8,154,165 ops/s | 3.11x |
| @formatjs/fast-memoize | 2,883,166 ops/s | 8.80x |

### Single object argument by value — hot cache hits

Every call receives a fresh object with the same structural value. Other libraries are shown with a `JSON.stringify` resolver — the minimum needed to make them work at all. Without it they would produce incorrect results or crash entirely.

**memoza is the only library here that handles this correctly with zero configuration**, and it goes further: it correctly distinguishes `Date`, `RegExp`, `Map`, `Set`, `BigInt`, cyclic objects, and class instances out of the box, none of which `JSON.stringify` can represent faithfully.

| Library | Handles all types | Zero config | Median throughput | vs fastest |
|---|:---:|:---:|---|---|
| memoize (cacheKey: JSON.stringify) | ❌ | ❌ | 5,570,845 ops/s | 1.00x |
| lodash.memoize (resolver) | ❌ | ❌ | 5,191,046 ops/s | 1.07x |
| **memoza** | ✅ | ✅ | **2,452,112 ops/s** | **2.27x** |
| @formatjs/fast-memoize | ❌ | ❌ | 1,989,082 ops/s | 2.80x |
| memoizee (normalizer: JSON.stringify) | ❌ | ❌ | 1,978,624 ops/s | 2.82x |

The speed gap reflects the cost of doing this correctly. `JSON.stringify` silently drops `undefined`, conflates `NaN`/`Infinity`, and ignores `Map`/`Set` contents — it is fast precisely because it cuts corners. memoza pays the price of correctness once, at key-derivation time.

## License

MIT
