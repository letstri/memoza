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
| lodash.memoize | 26,757,903 ops/s | 1.00x |
| @emotion/memoize | 25,235,597 ops/s | 1.06x |
| memoize | 21,285,854 ops/s | 1.26x |
| **memoza** | **9,518,722 ops/s** | **2.81x** |
| @formatjs/fast-memoize | 3,455,674 ops/s | 7.74x |
| memoizee | 2,171,950 ops/s | 12.32x |

### Unary string argument — cold misses

| Library | Median throughput | vs fastest |
|---|---|---|
| lodash.memoize | 8,017,102 ops/s | 1.00x |
| @emotion/memoize | 7,289,737 ops/s | 1.10x |
| memoize | 7,273,345 ops/s | 1.10x |
| @formatjs/fast-memoize | 2,126,543 ops/s | 3.77x |
| **memoza** | **2,066,386 ops/s** | **3.88x** |
| memoizee | 6,370 ops/s | 1258.53x |

### Two primitive arguments — hot cache hits

Libraries requiring multi-arg support are configured with `JSON.stringify` or an equivalent resolver.

| Library | Median throughput | vs fastest |
|---|---|---|
| memoize (cacheKey: JSON.stringify) | 8,248,268 ops/s | 1.00x |
| lodash.memoize (resolver) | 6,853,923 ops/s | 1.20x |
| memoizee | 6,642,644 ops/s | 1.24x |
| **memoza** | **3,898,087 ops/s** | **2.12x** |
| @formatjs/fast-memoize | 2,678,101 ops/s | 3.08x |

### Single object argument by value — hot cache hits

Every call receives a fresh object with the same structural value. Other libraries are shown with a `JSON.stringify` resolver — the minimum needed to make them work at all. Without it they would produce incorrect results or crash entirely.

**memoza is the only library here that handles this correctly with zero configuration**, and it goes further: it correctly distinguishes `Date`, `RegExp`, `Map`, `Set`, `BigInt`, cyclic objects, and class instances out of the box, none of which `JSON.stringify` can represent faithfully.

| Library | Handles all types | Zero config | Median throughput | vs fastest |
|---|:---:|:---:|---|---|
| lodash.memoize (resolver) | ❌ | ❌ | 4,786,226 ops/s | 1.00x |
| memoize (cacheKey: JSON.stringify) | ❌ | ❌ | 4,737,474 ops/s | 1.01x |
| @formatjs/fast-memoize | ❌ | ❌ | 1,762,212 ops/s | 2.72x |
| memoizee (normalizer: JSON.stringify) | ❌ | ❌ | 1,601,978 ops/s | 2.99x |
| **memoza** | ✅ | ✅ | **672,664 ops/s** | **7.12x** |

The speed gap reflects the cost of doing this correctly. `JSON.stringify` silently drops `undefined`, conflates `NaN`/`Infinity`, and ignores `Map`/`Set` contents — it is fast precisely because it cuts corners. memoza pays the price of correctness once, at key-derivation time.

## License

MIT
