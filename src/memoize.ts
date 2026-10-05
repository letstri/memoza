import type { AnyFunction } from './utils'
import { BY_REFERENCE, getArgsCacheKey, getCacheKey } from './key'

export interface MemoizeOptions<F extends AnyFunction> {
  /**
   * Maximum time in milliseconds a cached entry remains valid. After this,
   * the next call with the same key recomputes the result.
   * @default Number.POSITIVE_INFINITY
   */
  maxAge?: number
  /**
   * Custom function to derive the cache key from the arguments, e.g. to
   * ignore some of them.
   *
   * @example
   * ```ts
   * const fn = memoize((a: number, b: number) => a + b, {
   *   cacheKey: (a, b) => `${a}-${b > 2}`,
   * })
   *
   * fn(1, 2) // Stored
   * fn(1, 2) // From cache
   * fn(1, 5) // Stored
   * fn(1, 7) // From cache
   * ```
   *
   * A static string can also be provided to always resolve to the same key.
   */
  cacheKey?: ((...args: Parameters<F>) => unknown) | string
  /**
   * Once an entry is older than `maxAge`, return the stale value right away
   * and refresh it in the background instead of blocking. If the refresh
   * fails, the old value stays cached and keeps being served (see
   * `onError`). Pass a number to limit how long past expiry a stale value
   * may still be used (in ms), or `true` for no limit — beyond it the cache
   * behaves as if the entry wasn't there: calls block and errors propagate.
   * @default false
   */
  stale?: boolean | number
  /**
   * Called when `stale` swallows an error — the only way to find out that
   * a background refresh failed.
   * @default undefined
   */
  onError?: (error: unknown) => void
}

export interface MemoizedCacheEntry<F extends AnyFunction> {
  value?: ReturnType<F>
  storedAt?: number
  pending?: ReturnType<F>
}

/**
 * What the Map-backed stores hold. Without `maxAge` or `stale` there is no
 * per-entry bookkeeping, so results are stored raw; with either option each
 * slot is a `MemoizedCacheEntry`.
 */
export type MemoizedCacheValue<F extends AnyFunction> = MemoizedCacheEntry<F> | ReturnType<F>

const CACHE_SYMBOL = Symbol('memoize-cache')
// Zero-arg calls key on this instead of building a string every time.
const NO_ARGS = Symbol('memoize-no-args')

// Objects and functions go in WeakMaps, so a cached call never keeps its
// arguments alive.
function isWeakKey(value: unknown): value is object {
  return typeof value === 'function' || (typeof value === 'object' && value !== null)
}

function isDirectPrimitiveKey(value: unknown): boolean {
  const t = typeof value
  return t === 'string' || t === 'boolean' || t === 'bigint' || t === 'undefined'
    // -0 must not collapse into 0; NaN is fine under SameValueZero.
    || (t === 'number' && (value !== 0 || 1 / (value as number) > 0))
    || value === null
}

// `handleMap` only calls get/has/set/delete, which a WeakMap has too, so
// weak stores are passed in under this type.
type Slots<V> = Map<unknown, V>

export interface CacheStore<F extends AnyFunction> {
  cache: Map<string, MemoizedCacheValue<F>>
  /** Primitives and symbols, by value. */
  primitiveCache: Map<unknown, MemoizedCacheValue<F>>
  /** Objects and functions that can only be keyed by reference. */
  refCache: WeakMap<object, MemoizedCacheValue<F>>
  /**
   * Arg lists, one trie per arity. Negative roots hold array keys that can
   * only be compared by reference, so `fn([a, b])` never hits `fn(a, b)`.
   */
  argsTries: Map<number, ArgsTrieNode<F>>
}

export interface ArgsTrieNode<F extends AnyFunction> {
  children: Map<unknown, ArgsTrieNode<F>> | null
  entries: Map<unknown, MemoizedCacheValue<F>> | null
  weakChildren: WeakMap<object, ArgsTrieNode<F>> | null
  weakEntries: WeakMap<object, MemoizedCacheValue<F>> | null
}

function trieNode<F extends AnyFunction>(): ArgsTrieNode<F> {
  return { children: null, entries: null, weakChildren: null, weakEntries: null }
}

export type MemoizedFn<F extends AnyFunction> = F & {
  [CACHE_SYMBOL]: () => CacheStore<F>
}

export function memoize<F extends AnyFunction>(
  func: F,
  options?: MemoizeOptions<F>,
): F {
  const {
    cacheKey,
    maxAge = Number.POSITIVE_INFINITY,
    stale = false,
    onError,
  } = options || {}
  const store: CacheStore<F> = {
    cache: new Map(),
    primitiveCache: new Map(),
    // Read through `store`: clearing swaps in a new one.
    refCache: new WeakMap(),
    argsTries: new Map(),
  }
  const { cache, primitiveCache, argsTries } = store
  // Without expiry there is nothing to track per entry (and nothing ever
  // goes stale), so the maps hold results directly — no wrapper to allocate
  // on miss or chase on hit.
  const direct = maxAge === Number.POSITIVE_INFINITY
  const staticKey = typeof cacheKey === 'string' ? getCacheKey(cacheKey) : undefined
  // `true` puts no bound on how stale a served value may be; `false` means an
  // expired entry is treated as absent, which is a window that nothing fits.
  const staleFor = stale === true
    ? Number.POSITIVE_INFINITY
    : stale === false ? Number.NEGATIVE_INFINITY : stale

  const dropOnReject = (result: unknown, drop: () => void): void => {
    if (result instanceof Promise)
      result.catch(drop)
  }

  const withinStaleWindow = (storedAt: number): boolean =>
    Date.now() - storedAt - maxAge <= staleFor

  const evict = (
    map: Slots<MemoizedCacheValue<F>>,
    key: unknown,
    entry: MemoizedCacheEntry<F>,
  ): void => {
    if (map.get(key) === entry)
      map.delete(key)
  }

  const compute = (
    map: Slots<MemoizedCacheValue<F>>,
    key: unknown,
    entry: MemoizedCacheEntry<F>,
    self: unknown,
    params: Parameters<F>,
    background: boolean,
  ): ReturnType<F> => {
    let result
    try {
      result = func.apply(self, params)
    }
    catch (error) {
      if (entry.storedAt !== undefined && withinStaleWindow(entry.storedAt)) {
        onError?.(error)
        return entry.value as ReturnType<F>
      }
      evict(map, key, entry)
      if (!background)
        throw error
      onError?.(error)
      // The caller already returned the stale value; this is ignored.
      return undefined as ReturnType<F>
    }

    if (!(result instanceof Promise)) {
      entry.value = result
      entry.storedAt = Date.now()
      entry.pending = undefined
      return result
    }

    const pending = result.then(
      (resolved: unknown) => {
        entry.value = result as ReturnType<F>
        entry.storedAt = Date.now()
        if (entry.pending === pending)
          entry.pending = undefined
        return resolved
      },
      (error: unknown) => {
        if (entry.pending === pending)
          entry.pending = undefined
        if (entry.storedAt !== undefined && withinStaleWindow(entry.storedAt)) {
          onError?.(error)
          return entry.value
        }
        evict(map, key, entry)
        if (background)
          onError?.(error)
        throw error
      },
    ) as ReturnType<F>
    entry.pending = pending

    // A failed background refresh has no awaiter; without this handler it
    // would surface as an unhandled rejection.
    if (background)
      (pending as Promise<unknown>).catch(() => {})

    return pending
  }

  // Map and key are passed down rather than wrapped in insert/evict
  // closures, so a hit allocates nothing.
  const call = (
    map: Slots<MemoizedCacheValue<F>>,
    key: unknown,
    self: unknown,
    params: Parameters<F>,
  ): ReturnType<F> => {
    const existing = map.get(key) as MemoizedCacheEntry<F> | undefined
    if (existing === undefined) {
      // All fields up front, so every entry shares one shape.
      const entry: MemoizedCacheEntry<F> = { value: undefined, storedAt: undefined, pending: undefined }
      map.set(key, entry)
      return compute(map, key, entry, self, params, false)
    }

    if (existing.storedAt !== undefined) {
      const age = Date.now() - existing.storedAt
      if (age <= maxAge)
        return existing.value as ReturnType<F>

      if (withinStaleWindow(existing.storedAt)) {
        // Capture before the refresh: a synchronous refresh would replace
        // `existing.value` in the same tick.
        const staleValue = existing.value as ReturnType<F>
        if (existing.pending === undefined)
          compute(map, key, existing, self, params, true)

        return staleValue
      }
    }

    return existing.pending ?? compute(map, key, existing, self, params, false)
  }

  const handleMap: (
    map: Slots<MemoizedCacheValue<F>>,
    key: unknown,
    self: unknown,
    params: Parameters<F>,
  ) => ReturnType<F> = direct
    ? (map, key, self, params) => {
        const cached = map.get(key)
        if (cached !== undefined)
          return cached as ReturnType<F>

        // A stored `undefined` result and a miss both come back as undefined;
        // `has` settles which one this is.
        if (map.has(key))
          return undefined as ReturnType<F>

        const result = func.apply(self, params)
        map.set(key, result)
        dropOnReject(result, () => {
          if (map.get(key) === result)
            map.delete(key)
        })

        return result
      }
    : call

  // Walks (and grows) the trie rooted at `root` down to the leaf map that
  // holds `keys[keys.length - 1]`.
  const handleArgs = (
    root: number,
    keys: unknown[],
    self: unknown,
    params: Parameters<F>,
  ): ReturnType<F> => {
    let node = argsTries.get(root)
    if (node === undefined)
      argsTries.set(root, node = trieNode())

    const last = keys.length - 1
    for (let index = 0; index < last; index++) {
      const key = keys[index]
      const children = (isWeakKey(key)
        ? node.weakChildren ??= new WeakMap()
        : node.children ??= new Map()) as unknown as Slots<ArgsTrieNode<F>>
      let next = children.get(key)
      if (next === undefined)
        children.set(key, next = trieNode())
      node = next
    }

    const key = keys[last]
    const entries = (isWeakKey(key)
      ? node.weakEntries ??= new WeakMap()
      : node.entries ??= new Map()) as unknown as Slots<MemoizedCacheValue<F>>
    return handleMap(entries, key, self, params)
  }

  const handleValue = (value: unknown, self: unknown, params: Parameters<F>): ReturnType<F> => {
    // Already keyed by reference (class instances, functions, …): skip the
    // structural walk, which would only end at the same answer.
    const refCache = store.refCache as unknown as Slots<MemoizedCacheValue<F>>
    if (isWeakKey(value) && refCache.has(value))
      return handleMap(refCache, value, self, params)

    const key = getCacheKey(value)
    if (key !== BY_REFERENCE)
      return handleMap(cache, key, self, params)

    // Arrays are compared item by item, so a fresh `[fn, 1]` still hits.
    if (Array.isArray(value))
      return handleArgs(~value.length, value, self, params)

    return isWeakKey(value)
      ? handleMap(refCache, value, self, params)
      : handleMap(primitiveCache, value, self, params)
  }

  const fn = function (this: unknown, ...params: Parameters<F>) {
    if (cacheKey !== undefined) {
      if (staticKey !== undefined)
        return handleMap(cache, staticKey, this, params)

      return handleValue((cacheKey as (...args: Parameters<F>) => unknown).apply(this, params), this, params)
    }

    if (params.length === 1) {
      const arg = params[0]
      // Inlined `isDirectPrimitiveKey`: on this, the hottest path, even the
      // helper call shows up (~10%).
      const t = typeof arg
      if (t === 'string' || t === 'boolean' || t === 'bigint' || t === 'undefined'
        || (t === 'number' && (arg !== 0 || 1 / (arg as number) > 0))
        || arg === null) {
        // Default mode also skips `handleMap`: routing through it costs
        // ~30% on unary cache hits.
        if (direct) {
          const cached = primitiveCache.get(arg)
          if (cached !== undefined)
            return cached

          if (primitiveCache.has(arg))
            return undefined

          const result = func.apply(this, params)
          primitiveCache.set(arg, result)
          dropOnReject(result, () => {
            if (primitiveCache.get(arg) === result)
              primitiveCache.delete(arg)
          })

          return result
        }

        return handleMap(primitiveCache, arg, this, params)
      }

      // Inlined hit check from `handleValue` for reference keys.
      if (direct) {
        const cached = store.refCache.get(arg as object)
        if (cached !== undefined)
          return cached
      }

      return handleValue(arg, this, params)
    }

    if (params.length === 0) {
      // Same shortcut as the unary path above.
      if (direct) {
        const cached = primitiveCache.get(NO_ARGS)
        if (cached !== undefined || primitiveCache.has(NO_ARGS))
          return cached
      }

      return handleMap(primitiveCache, NO_ARGS, this, params)
    }

    // A plain loop: `params.every` costs ~15-30% on multi-arg hits.
    let allPrimitive = true
    for (let index = 0; index < params.length; index++) {
      if (!isDirectPrimitiveKey(params[index])) {
        allPrimitive = false
        break
      }
    }
    // Trie roots are split by arity so an inner node and a leaf entry never
    // share a slot. The walk is `handleArgs` inlined: the call costs ~15%
    // on two-arg hits.
    if (allPrimitive) {
      let node = argsTries.get(params.length)
      if (node === undefined)
        argsTries.set(params.length, node = trieNode())

      const last = params.length - 1
      for (let index = 0; index < last; index++) {
        const children: Map<unknown, ArgsTrieNode<F>> = node.children ??= new Map()
        let next = children.get(params[index])
        if (next === undefined)
          children.set(params[index], next = trieNode())
        node = next
      }

      return handleMap(node.entries ??= new Map(), params[last], this, params)
    }

    const key = getArgsCacheKey(params)
    return key === BY_REFERENCE
      ? handleArgs(params.length, params, this, params)
      : handleMap(cache, key, this, params)
  } as MemoizedFn<F>

  fn[CACHE_SYMBOL] = () => store

  return fn
}

export function isMemoized<F extends (...args: Parameters<F>) => ReturnType<F>>(
  fn: F,
): fn is MemoizedFn<F> {
  return CACHE_SYMBOL in fn
}

export function getCacheStore<F extends AnyFunction>(fn: F): CacheStore<F> | null {
  return isMemoized(fn) ? fn[CACHE_SYMBOL]() : null
}

export function clearMemoizeCache<F extends (...args: Parameters<F>) => ReturnType<F>>(
  fn: F,
): void {
  const store = getCacheStore(fn)
  if (!store)
    return

  store.cache.clear()
  store.primitiveCache.clear()
  store.argsTries.clear()
  store.refCache = new WeakMap()
}
