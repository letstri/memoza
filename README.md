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

## Cache utilities

```ts
import { clearMemoizeCache, getCacheStore, isMemoized } from 'memoza'

isMemoized(fn) // true if fn was created with memoize()
getCacheStore(fn) // returns { cache, fallbackEntries } or null
clearMemoizeCache(fn) // clears all cached entries
```

## Promise support

Failed promises are automatically evicted from the cache, so the next call retries.

```ts
const fn = memoize(async (id: string) => fetchData(id))

await fn('a') // computed
await fn('a') // from cache
// if the promise rejects, the entry is removed and the next call re-runs
```

## Benchmark

Measured with Bun on Apple Silicon. All suites run 5 trials; results show the median.

### Unary string argument — hot cache hits

| Library | Median throughput | vs fastest |
|---|---|---|
| lodash.memoize | 35,888,940 ops/s | 1.00x |
| @emotion/memoize | 34,853,720 ops/s | 1.03x |
| **memoza** | **27,481,277 ops/s** | **1.31x** |
| memoize | 26,647,143 ops/s | 1.35x |
| @formatjs/fast-memoize | 4,234,950 ops/s | 8.47x |
| memoizee | 2,338,527 ops/s | 15.35x |

### Unary string argument — cold misses

| Library | Median throughput | vs fastest |
|---|---|---|
| lodash.memoize | 10,767,258 ops/s | 1.00x |
| @emotion/memoize | 9,905,814 ops/s | 1.09x |
| **memoza** | **8,125,567 ops/s** | **1.33x** |
| memoize | 7,774,187 ops/s | 1.39x |
| @formatjs/fast-memoize | 3,306,131 ops/s | 3.26x |
| memoizee | 6,810 ops/s | 1581.20x |

### Two primitive arguments — hot cache hits

Libraries requiring multi-arg support are configured with `JSON.stringify` or an equivalent resolver.

| Library | Median throughput | vs fastest |
|---|---|---|
| memoize (cacheKey: JSON.stringify) | 11,655,569 ops/s | 1.00x |
| lodash.memoize (resolver) | 8,959,021 ops/s | 1.30x |
| memoizee | 8,662,193 ops/s | 1.35x |
| **memoza** | **8,614,776 ops/s** | **1.35x** |
| @formatjs/fast-memoize | 3,522,986 ops/s | 3.31x |

### Single object argument by value — hot cache hits

Every call receives a fresh object with the same structural value. Other libraries are shown with a `JSON.stringify` resolver — the minimum needed to make them work at all. Without it they would produce incorrect results or crash entirely.

**memoza is the only library here that handles this correctly with zero configuration**, and it goes further: it correctly distinguishes `Date`, `RegExp`, `Map`, `Set`, `BigInt`, cyclic objects, and class instances out of the box, none of which `JSON.stringify` can represent faithfully.

| Library | Handles all types | Zero config | Median throughput | vs fastest |
|---|:---:|:---:|---|---|
| lodash.memoize (resolver) | ❌ | ❌ | 6,898,856 ops/s | 1.00x |
| memoize (cacheKey: JSON.stringify) | ❌ | ❌ | 6,854,664 ops/s | 1.01x |
| **memoza** | ✅ | ✅ | **2,381,246 ops/s** | **2.90x** |
| @formatjs/fast-memoize | ❌ | ❌ | 2,320,900 ops/s | 2.97x |
| memoizee (normalizer: JSON.stringify) | ❌ | ❌ | 2,233,821 ops/s | 3.09x |

The speed gap reflects the cost of doing this correctly. `JSON.stringify` silently drops `undefined`, conflates `NaN`/`Infinity`, and ignores `Map`/`Set` contents — it is fast precisely because it cuts corners. memoza pays the price of correctness once, at key-derivation time.

## License

MIT
