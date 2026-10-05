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

`this` is passed through to the wrapped function but is not part of the cache key. Objects and functions that are keyed by reference are held weakly, so the cache never keeps them alive.

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
getCacheStore(fn) // { cache, primitiveCache, refCache, argsTries } or null
clearMemoizeCache(fn) // clears everything, including retained stale values
```

## Benchmark

Bun 1.4.2, Apple M2 Pro, median of 7 trials. Each library runs in its own process. Run it yourself with `bun bench/index.ts`.

| Workload | memoza | Best rival |
|---|---|---|
| Unary string, hot cache | **117,000,930 ops/s** | @emotion/memoize — tie |
| Unary string, cold misses | **12,354,324 ops/s** | memoize — tie |
| Two primitives, hot cache | **63,173,220 ops/s** | memoizee — 4.30x slower |
| Three primitives, hot cache | **27,946,683 ops/s** | memoize — 2.55x slower |
| No arguments, hot cache | 55,573,443 ops/s | memoizee — 1.81x faster |
| Class instance, hot cache | 47,251,798 ops/s | lodash.memoize — 1.78x faster |
| Unary string with `maxAge`, hot cache | 25,473,481 ops/s | memoize — 1.32x faster |
| Object by value, hot cache | 5,022,045 ops/s | lodash.memoize — 1.43x faster |
| Primitive + options object, hot cache | 6,642,768 ops/s | memoize — 1.48x faster |
| Object by value, cold misses | 3,673,544 ops/s | memoize — 1.53x faster |

Rivals need `JSON.stringify` resolvers for multi-argument and by-value workloads; memoza needs no configuration. It trails on the by-value rows on purpose: a bare `JSON.stringify` drops `undefined`, conflates `NaN`/`Infinity`/`null` and `-0`/`0`, and ignores `Map`/`Set` contents. memoza uses `JSON.stringify` only when the value has none of those, and keys the rest correctly, along with `Date`, `RegExp`, `BigInt`, cyclic objects, and class instances.

## License

MIT
