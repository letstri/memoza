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
}

export interface MemoizedCacheEntry<F extends AnyFunction> {
  value: ReturnType<F>
  storedAt: number
}

export interface MemoizedEntry<F extends AnyFunction> {
  key: unknown
  value: ReturnType<F>
  storedAt: number
}

const CACHE_SYMBOL = Symbol('memoize-cache')

export interface CacheStore<F extends AnyFunction> {
  cache: Map<string, MemoizedCacheEntry<F>>
  /**
   * Single primitive arguments are cached by raw value — no key string is
   * built for them. The Map's SameValueZero semantics already distinguish
   * `5` from `'5'`, `true`, `null`, etc.
   */
  primitiveCache: Map<unknown, MemoizedCacheEntry<F>>
  fallbackEntries: MemoizedEntry<F>[]
}

export type MemoizedFn<F extends AnyFunction> = F & {
  [CACHE_SYMBOL]: () => CacheStore<F>
}

export function memoize<F extends AnyFunction>(
  func: F,
  options?: MemoizeOptions<F>,
): F {
  const { cacheKey, maxAge = Number.POSITIVE_INFINITY } = options || {}
  const cache = new Map<string, MemoizedCacheEntry<F>>()
  const primitiveCache = new Map<unknown, MemoizedCacheEntry<F>>()
  const fallbackEntries: MemoizedEntry<F>[] = []
  const hasMaxAge = maxAge !== Number.POSITIVE_INFINITY
  // A static string cacheKey always resolves to the same cache key.
  const staticKey = typeof cacheKey === 'string' ? getCacheKey(cacheKey) : undefined

  const fn = ((...params: Parameters<F>) => {
    let args: unknown
    let key: string | typeof BY_REFERENCE

    if (cacheKey === undefined) {
      if (params.length === 1) {
        args = params[0]

        // Fast path: a single primitive argument is used directly as a Map
        // key — no serialization at all. Symbols keep their by-reference
        // fallback semantics and -0 keeps its distinct-from-0 key, so both
        // stay on the slow path.
        if (
          (args === null
            || (typeof args !== 'object' && typeof args !== 'function' && typeof args !== 'symbol'))
          && !Object.is(args, -0)
        ) {
          const wrapped = primitiveCache.get(args)
          if (wrapped !== undefined) {
            if (!hasMaxAge || Date.now() - wrapped.storedAt <= maxAge)
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

        key = getCacheKey(args)
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

    if (typeof key === 'string') {
      const wrapped = cache.get(key)
      if (wrapped !== undefined) {
        if (!hasMaxAge || Date.now() - wrapped.storedAt <= maxAge)
          return wrapped.value

        cache.delete(key)
      }

      const result = func(...params)
      cache.set(key, { value: result, storedAt: hasMaxAge ? Date.now() : 0 })

      if (result instanceof Promise) {
        result.catch(() => {
          const entry = cache.get(key as string)
          if (entry !== undefined && entry.value === result)
            cache.delete(key as string)
        })
      }

      return result
    }

    const hit = findReferenceEntry(fallbackEntries, args)
    if (hit) {
      if (!hasMaxAge || Date.now() - hit.storedAt <= maxAge)
        return hit.value

      const index = fallbackEntries.indexOf(hit)
      if (index !== -1)
        fallbackEntries.splice(index, 1)
    }

    const result = func(...params)
    const entry: MemoizedEntry<F> = { key: args, value: result, storedAt: hasMaxAge ? Date.now() : 0 }
    fallbackEntries.push(entry)

    if (result instanceof Promise) {
      result.catch(() => {
        const index = fallbackEntries.indexOf(entry)
        if (index !== -1)
          fallbackEntries.splice(index, 1)
      })
    }

    return result
  }) as MemoizedFn<F>

  fn[CACHE_SYMBOL] = () => ({ cache, primitiveCache, fallbackEntries })

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
  store.fallbackEntries.length = 0
}
