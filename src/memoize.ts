import type { BY_REFERENCE } from './key'
import type { AnyFunction } from './utils'
import { findReferenceEntry, getArgsCacheKey, getCacheKey } from './key'

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

export interface MemoizedEntry<F extends AnyFunction> extends MemoizedCacheEntry<F> {
  key: unknown
}

/**
 * What the Map-backed stores hold. Without `maxAge` or `stale` there is no
 * per-entry bookkeeping, so results are stored raw; with either option each
 * slot is a `MemoizedCacheEntry`.
 */
export type MemoizedCacheValue<F extends AnyFunction> = MemoizedCacheEntry<F> | ReturnType<F>

const CACHE_SYMBOL = Symbol('memoize-cache')

function isDirectPrimitiveKey(value: unknown): boolean {
  const t = typeof value
  return t === 'string' || t === 'boolean' || t === 'bigint' || t === 'undefined'
    // -0 must not collapse into 0; NaN is fine under SameValueZero.
    || (t === 'number' && (value !== 0 || 1 / (value as number) > 0))
    || value === null
}

export interface CacheStore<F extends AnyFunction> {
  cache: Map<string, MemoizedCacheValue<F>>
  primitiveCache: Map<unknown, MemoizedCacheValue<F>>
  argsTries: Map<number, ArgsTrieNode<F>>
  fallbackEntries: MemoizedEntry<F>[]
}

export interface ArgsTrieNode<F extends AnyFunction> {
  children: Map<unknown, ArgsTrieNode<F>> | null
  entries: Map<unknown, MemoizedCacheValue<F>> | null
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
  const cache = new Map<string, MemoizedCacheValue<F>>()
  const primitiveCache = new Map<unknown, MemoizedCacheValue<F>>()
  const argsTries = new Map<number, ArgsTrieNode<F>>()
  const fallbackEntries: MemoizedEntry<F>[] = []
  const hasMaxAge = maxAge !== Number.POSITIVE_INFINITY
  // Without expiry or staleness there is nothing to track per entry, so the
  // maps hold results directly — no wrapper to allocate on miss or chase on hit.
  const direct = stale === false && !hasMaxAge
  const staticKey = typeof cacheKey === 'string' ? getCacheKey(cacheKey) : undefined
  // `true` puts no bound on how stale a served value may be; `false` means an
  // expired entry is treated as absent, which is a window that nothing fits.
  const staleFor = stale === true
    ? Number.POSITIVE_INFINITY
    : stale === false ? Number.NEGATIVE_INFINITY : stale

  const dropRefEntry = (entry: MemoizedCacheEntry<F>): void => {
    const index = fallbackEntries.indexOf(entry as MemoizedEntry<F>)
    if (index !== -1)
      fallbackEntries.splice(index, 1)
  }

  const dropOnReject = (result: unknown, drop: () => void): void => {
    if (result instanceof Promise)
      result.catch(drop)
  }

  const withinStaleWindow = (storedAt: number): boolean =>
    Date.now() - storedAt - maxAge <= staleFor

  const compute = (
    entry: MemoizedCacheEntry<F>,
    params: Parameters<F>,
    evict: (entry: MemoizedCacheEntry<F>) => void,
    background: boolean,
  ): ReturnType<F> => {
    let result
    try {
      result = func(...params)
    }
    catch (error) {
      if (entry.storedAt !== undefined && withinStaleWindow(entry.storedAt)) {
        onError?.(error)
        return entry.value as ReturnType<F>
      }
      evict(entry)
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
        evict(entry)
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

  const call = (
    existing: MemoizedCacheEntry<F> | undefined,
    params: Parameters<F>,
    insert: () => MemoizedCacheEntry<F>,
    evict: (entry: MemoizedCacheEntry<F>) => void,
  ): ReturnType<F> => {
    if (existing === undefined)
      return compute(insert(), params, evict, false)

    if (existing.storedAt !== undefined) {
      const age = Date.now() - existing.storedAt
      if (age <= maxAge)
        return existing.value as ReturnType<F>

      if (withinStaleWindow(existing.storedAt)) {
        // Capture before the refresh: a synchronous refresh would replace
        // `existing.value` in the same tick.
        const staleValue = existing.value as ReturnType<F>
        if (existing.pending === undefined)
          compute(existing, params, evict, true)

        return staleValue
      }
    }

    return existing.pending ?? compute(existing, params, evict, false)
  }

  const handleMap: (
    map: Map<unknown, MemoizedCacheValue<F>>,
    key: unknown,
    params: Parameters<F>,
  ) => ReturnType<F> = direct
    ? (map, key, params) => {
        const cached = map.get(key)
        if (cached !== undefined)
          return cached as ReturnType<F>

        // A stored `undefined` result and a miss both come back as undefined;
        // `has` settles which one this is.
        if (map.has(key))
          return undefined as ReturnType<F>

        const result = func(...params)
        map.set(key, result)
        dropOnReject(result, () => {
          if (map.get(key) === result)
            map.delete(key)
        })

        return result
      }
    : (map, key, params) => call(
        map.get(key) as MemoizedCacheEntry<F> | undefined,
        params,
        () => {
          const entry: MemoizedCacheEntry<F> = {}
          map.set(key, entry)
          return entry
        },
        (entry) => {
          if (map.get(key) === entry)
            map.delete(key)
        },
      )

  const handleRef = (refKey: unknown, params: Parameters<F>): ReturnType<F> => call(
    findReferenceEntry(fallbackEntries, refKey),
    params,
    () => {
      const entry: MemoizedEntry<F> = { key: refKey }
      fallbackEntries.push(entry)
      return entry
    },
    dropRefEntry,
  )

  const fn = ((...params: Parameters<F>) => {
    let args: unknown
    let key: string | typeof BY_REFERENCE

    if (cacheKey === undefined) {
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

            const result = func(...params)
            primitiveCache.set(arg, result)
            dropOnReject(result, () => {
              if (primitiveCache.get(arg) === result)
                primitiveCache.delete(arg)
            })

            return result
          }

          return handleMap(primitiveCache, arg, params)
        }

        args = arg
        key = getCacheKey(arg)
      }
      else {
        if (params.length > 1 && params.every(isDirectPrimitiveKey)) {
          // Trie roots are split by arity so an inner node and a leaf entry
          // never share a slot.
          let node = argsTries.get(params.length)
          if (node === undefined) {
            node = { children: null, entries: null }
            argsTries.set(params.length, node)
          }

          const last = params.length - 1
          for (let index = 0; index < last; index++) {
            const children: Map<unknown, ArgsTrieNode<F>> = node.children ??= new Map()
            let next = children.get(params[index])
            if (next === undefined) {
              next = { children: null, entries: null }
              children.set(params[index], next)
            }
            node = next
          }

          return handleMap(node.entries ??= new Map(), params[last], params)
        }

        args = params
        key = getArgsCacheKey(params)
      }
    }
    else if (typeof cacheKey === 'function') {
      args = cacheKey(...params)
      key = getCacheKey(args)
    }
    else {
      args = cacheKey
      key = staticKey!
    }

    if (typeof key === 'string')
      return handleMap(cache, key, params)

    return handleRef(args, params)
  }) as MemoizedFn<F>

  fn[CACHE_SYMBOL] = () => ({ cache, primitiveCache, argsTries, fallbackEntries })

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
  store.fallbackEntries.length = 0
}
