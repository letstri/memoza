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

Failed promises are evicted, so the next call retries.

## Options

```ts
memoize(fetchUser, {
  // Milliseconds before an entry expires. Default: Infinity.
  maxAge: 60_000,
  // Serve an expired entry while it refreshes in the background, keeping the
  // last good value if the refresh fails. Pass a number to cap how long past
  // expiry (ms) a stale value may be used, or `true` for no cap; beyond it,
  // calls block and errors propagate. Default: false.
  stale: true,
  // Called with every error `stale` swallows — the only way to see them.
  onError: console.error,
  // Derive the cache key from the arguments. A string is a constant key.
  cacheKey: user => user.id,
})
```

Sync functions work with `stale` too: a stale hit returns the previous value while recomputing in the same tick.

## Cache utilities

```ts
import { clearMemoizeCache, getCacheStore, isMemoized } from 'memoza'

isMemoized(fn) // true if fn was created with memoize()
getCacheStore(fn) // { cache, primitiveCache, argsTries, fallbackEntries } or null
clearMemoizeCache(fn) // clears everything, including retained stale values
```

## Benchmark

Bun 1.4.0, Apple M2 Pro, median of 7 trials. Each library runs in its own process. Run it yourself with `bun bench/index.ts`.

| Workload | memoza | Next fastest |
|---|---|---|
| Unary string, hot cache | **126,773,467 ops/s** | @emotion/memoize — 1.08x slower |
| Unary string, cold misses | 9,029,957 ops/s | @emotion/memoize — 1.03x faster (noise) |
| Two primitives, hot cache | **67,701,584 ops/s** | memoizee — 4.59x slower |
| Object by value, hot cache | 2,968,792 ops/s | lodash.memoize — 2.38x faster |

Rivals need `JSON.stringify` resolvers for the last two workloads; memoza needs no configuration. It also loses the object-by-value row on purpose: `JSON.stringify` is fast because it drops `undefined`, conflates `NaN`/`Infinity`, and ignores `Map`/`Set` contents. memoza keys those correctly, along with `Date`, `RegExp`, `BigInt`, cyclic objects, and class instances.

## License

MIT
