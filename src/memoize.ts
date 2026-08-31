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

const CACHE_SYMBOL = Symbol('memoize-cache')

function isDirectPrimitiveKey(value: unknown): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'bigint':
    case 'undefined':
      return true
    case 'number':
      // -0 must not collapse into 0; NaN is fine under SameValueZero.
      return value !== 0 || 1 / value > 0
    case 'object':
      return value === null
    default:
      return false
  }
}

export interface CacheStore<F extends AnyFunction> {
  cache: Map<string, MemoizedCacheEntry<F>>
  primitiveCache: Map<unknown, MemoizedCacheEntry<F>>
  argsTries: Map<number, ArgsTrieNode<F>>
  fallbackEntries: MemoizedEntry<F>[]
}

export interface ArgsTrieNode<F extends AnyFunction> {
  children: Map<unknown, ArgsTrieNode<F>> | null
  entries: Map<unknown, MemoizedCacheEntry<F>> | null
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
  const cache = new Map<string, MemoizedCacheEntry<F>>()
  const primitiveCache = new Map<unknown, MemoizedCacheEntry<F>>()
  const argsTries = new Map<number, ArgsTrieNode<F>>()
  const fallbackEntries: MemoizedEntry<F>[] = []
  const hasMaxAge = maxAge !== Number.POSITIVE_INFINITY
  const staticKey = typeof cacheKey === 'string' ? getCacheKey(cacheKey) : undefined

  let handleMap: (
    map: Map<unknown, MemoizedCacheEntry<F>>,
    key: unknown,
    params: Parameters<F>,
  ) => ReturnType<F>
  let handleRef: (refKey: unknown, params: Parameters<F>) => ReturnType<F>

  if (stale === false) {
    handleMap = (map, key, params) => {
      const wrapped = map.get(key)
      if (wrapped !== undefined) {
        if (!hasMaxAge || Date.now() - wrapped.storedAt! <= maxAge)
          return wrapped.value!

        map.delete(key)
      }

      const result = func(...params)
      map.set(key, { value: result, storedAt: hasMaxAge ? Date.now() : 0 })

      if (result instanceof Promise) {
        result.catch(() => {
          if (map.get(key)?.value === result)
            map.delete(key)
        })
      }

      return result
    }

    handleRef = (refKey, params) => {
      const hit = findReferenceEntry(fallbackEntries, refKey)
      if (hit) {
        if (!hasMaxAge || Date.now() - hit.storedAt! <= maxAge)
          return hit.value!

        fallbackEntries.splice(fallbackEntries.indexOf(hit), 1)
      }

      const result = func(...params)
      const entry: MemoizedEntry<F> = { key: refKey, value: result, storedAt: hasMaxAge ? Date.now() : 0 }
      fallbackEntries.push(entry)

      if (result instanceof Promise) {
        result.catch(() => {
          const index = fallbackEntries.indexOf(entry)
          if (index !== -1)
            fallbackEntries.splice(index, 1)
        })
      }

      return result
    }
  }
  else {
    const withinStaleWindow = (storedAt: number): boolean =>
      stale === true || Date.now() - storedAt - maxAge <= stale

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

    handleMap = (map, key, params) => call(
      map.get(key),
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

    const evictRef = (entry: MemoizedCacheEntry<F>): void => {
      const index = fallbackEntries.indexOf(entry as MemoizedEntry<F>)
      if (index !== -1)
        fallbackEntries.splice(index, 1)
    }

    handleRef = (refKey, params) => call(
      findReferenceEntry(fallbackEntries, refKey),
      params,
      () => {
        const entry: MemoizedEntry<F> = { key: refKey }
        fallbackEntries.push(entry)
        return entry
      },
      evictRef,
    )
  }

  const fn = ((...params: Parameters<F>) => {
    let args: unknown
    let key: string | typeof BY_REFERENCE

    if (cacheKey === undefined) {
      if (params.length === 1) {
        args = params[0]

        if (isDirectPrimitiveKey(args)) {
          // Default mode keeps the hottest path inlined: routing it through
          // `handleMap` costs ~30% on unary cache hits.
          if (stale === false) {
            const wrapped = primitiveCache.get(args)
            if (wrapped !== undefined) {
              if (!hasMaxAge || Date.now() - wrapped.storedAt! <= maxAge)
                return wrapped.value

              primitiveCache.delete(args)
            }

            const result = func(...params)
            primitiveCache.set(args, { value: result, storedAt: hasMaxAge ? Date.now() : 0 })

            if (result instanceof Promise) {
              result.catch(() => {
                const entry = primitiveCache.get(args)
                if (entry !== undefined && entry.value === result)
                  primitiveCache.delete(args)
              })
            }

            return result
          }

          return handleMap(primitiveCache, args, params)
        }

        key = getCacheKey(args)
      }
      else if (params.length > 1) {
        // Trie roots are split by arity so an inner node and a leaf entry
        // never share a slot.
        let allPrimitive = true
        for (let index = 0; index < params.length; index++) {
          if (!isDirectPrimitiveKey(params[index])) {
            allPrimitive = false
            break
          }
        }

        if (allPrimitive) {
          let node = argsTries.get(params.length)
          if (node === undefined) {
            node = { children: null, entries: null }
            argsTries.set(params.length, node)
          }

          const last = params.length - 1
          for (let index = 0; index < last; index++) {
            let children: Map<unknown, ArgsTrieNode<F>> | null = node.children
            if (children === null) {
              children = new Map()
              node.children = children
            }

            let next: ArgsTrieNode<F> | undefined = children.get(params[index])
            if (next === undefined) {
              next = { children: null, entries: null }
              children.set(params[index], next)
            }
            node = next
          }

          let entries = node.entries
          if (entries === null) {
            entries = new Map()
            node.entries = entries
          }

          return handleMap(entries, params[last], params)
        }

        args = params
        key = getArgsCacheKey(params)
      }
      else {
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
