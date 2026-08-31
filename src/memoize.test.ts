import type { MemoizedCacheEntry } from './memoize'
import type { AnyFunction } from './utils'
import { describe, expect, it, mock } from 'bun:test'
import { clearMemoizeCache, getCacheStore, isMemoized, memoize } from './memoize'

describe('memoize', () => {
  it('caches results for equal arguments and recomputes for different ones', () => {
    const callback = mock((x: number) => x * 2)
    const fn = memoize(callback)

    expect(fn(5)).toBe(10)
    expect(fn(5)).toBe(10)
    expect(fn(10)).toBe(20)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('caches undefined results without recomputing', () => {
    const callback = mock((_: number) => undefined)
    const fn = memoize(callback)

    expect(fn(1)).toBeUndefined()
    expect(fn(1)).toBeUndefined()
    expect(callback).toHaveBeenCalledTimes(1)

    const objCallback = mock((_: { a: number }) => undefined)
    const objFn = memoize(objCallback)

    expect(objFn({ a: 1 })).toBeUndefined()
    expect(objFn({ a: 1 })).toBeUndefined()
    expect(objCallback).toHaveBeenCalledTimes(1)
  })

  it('supports multiple object arguments by structural equality', () => {
    const callback = mock((a: { x: number }, b: { y: number }) => a.x + b.y)
    const fn = memoize(callback)

    expect(fn({ x: 1 }, { y: 2 })).toBe(3)
    expect(fn({ x: 1 }, { y: 2 })).toBe(3)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  describe('maxAge option', () => {
    it('defaults to no expiry (same as Number.POSITIVE_INFINITY)', () => {
      let now = 1_000_000
      const dateNow = Date.now
      Date.now = () => now

      try {
        const callback = mock((x: number) => x * 2)
        const fn = memoize(callback)

        expect(fn(5)).toBe(10)
        expect(callback).toHaveBeenCalledTimes(1)

        now += 9999999999
        expect(fn(5)).toBe(10)
        expect(callback).toHaveBeenCalledTimes(1)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('recomputes after maxAge for string keys', () => {
      let now = 1000
      const dateNow = Date.now
      Date.now = () => now

      try {
        const callback = mock((x: number) => x * 2)
        const fn = memoize(callback, { maxAge: 50 })

        expect(fn(5)).toBe(10)
        expect(callback).toHaveBeenCalledTimes(1)

        now += 51
        expect(fn(5)).toBe(10)
        expect(callback).toHaveBeenCalledTimes(2)

        now += 1
        expect(fn(5)).toBe(10)
        expect(callback).toHaveBeenCalledTimes(2)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('recomputes after maxAge for reference keys', () => {
      class Point { constructor(public x: number) {} }

      let now = 2000
      const dateNow = Date.now
      Date.now = () => now

      try {
        const callback = mock((_: Point) => 'ok')
        const fn = memoize(callback, { maxAge: 10 })
        const p = new Point(1)

        expect(fn(p)).toBe('ok')
        expect(callback).toHaveBeenCalledTimes(1)

        now += 11
        expect(fn(p)).toBe('ok')
        expect(callback).toHaveBeenCalledTimes(2)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('recomputes expired promises', async () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        const callback = mock(async (x: number) => x * 2)
        const fn = memoize(callback, { maxAge: 100 })

        expect(await fn(3)).toBe(6)
        expect(callback).toHaveBeenCalledTimes(1)

        now += 101
        expect(await fn(3)).toBe(6)
        expect(callback).toHaveBeenCalledTimes(2)
      }
      finally {
        Date.now = dateNow
      }
    })
  })

  describe('cacheKey option', () => {
    it('reduces the key to a subset of arguments', () => {
      const callback = mock((a: number, b: number, c: number) => a + b + c)
      const fn = memoize(callback, {
        cacheKey: firstArg => firstArg,
      })

      expect(fn(1, 2, 3)).toBe(6)
      expect(fn(1, 2, 99)).toBe(6)
      expect(fn(10, 2, 3)).toBe(15)
      expect(callback).toHaveBeenCalledTimes(2)
    })

    it('allows a custom composite key', () => {
      const callback = mock((a: number, b: number) => a + b)
      const fn = memoize(callback, {
        cacheKey: (a, b) => `${a}-${b > 2}`,
      })

      expect(fn(1, 2)).toBe(3)
      expect(fn(1, 4)).toBe(5)
      expect(fn(1, 7)).toBe(5)
      expect(fn(2, 1)).toBe(3)
      expect(callback).toHaveBeenCalledTimes(3)
    })

    it('treats a static string as a constant key for every call', () => {
      const callback = mock((x: number) => x * 2)
      const fn = memoize(callback, { cacheKey: 'constant' })

      expect(fn(5)).toBe(10)
      expect(fn(10)).toBe(10)
      expect(fn(99)).toBe(10)
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('keeps separate caches for instances with different static keys', () => {
      const callback = mock((x: number) => x * 2)
      const first = memoize(callback, { cacheKey: 'a' })
      const second = memoize(callback, { cacheKey: 'b' })

      expect(first(5)).toBe(10)
      expect(second(7)).toBe(14)
      expect(first(123)).toBe(10)
      expect(second(456)).toBe(14)
      expect(callback).toHaveBeenCalledTimes(2)
    })

    it('recomputes a static-string key after maxAge', () => {
      let now = 1000
      const dateNow = Date.now
      Date.now = () => now

      try {
        const callback = mock((x: number) => x * 2)
        const fn = memoize(callback, { cacheKey: 'constant', maxAge: 50 })

        expect(fn(5)).toBe(10)
        expect(callback).toHaveBeenCalledTimes(1)

        now += 51
        expect(fn(5)).toBe(10)
        expect(callback).toHaveBeenCalledTimes(2)
      }
      finally {
        Date.now = dateNow
      }
    })
  })

  describe('promise handling', () => {
    it('caches resolved promises', async () => {
      const callback = mock(async (x: number) => x * 2)
      const fn = memoize(callback)

      expect(await fn(5)).toBe(10)
      expect(await fn(5)).toBe(10)
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('evicts the entry when the promise rejects', async () => {
      const callback = mock(async (shouldFail: boolean) => {
        if (shouldFail)
          throw new Error('Failed')
        return 'success'
      })
      const fn = memoize(callback)

      await expect(fn(true)).rejects.toThrow('Failed')
      expect(fn(true)).rejects.toThrow('Failed')
      expect(callback).toHaveBeenCalledTimes(2)

      expect(await fn(false)).toBe('success')
      expect(await fn(false)).toBe('success')
      expect(callback).toHaveBeenCalledTimes(3)
    })
  })

  describe('clearMemoizeCache', () => {
    it('clears cached entries so the function is called again', () => {
      const callback = mock((x: number) => x * 2)
      const fn = memoize(callback)

      fn(1)
      fn(2)
      fn(1)
      expect(callback).toHaveBeenCalledTimes(2)

      clearMemoizeCache(fn)

      fn(1)
      fn(2)
      expect(callback).toHaveBeenCalledTimes(4)
    })

    it('is a no-op for non-memoized functions', () => {
      const regularFn = (x: number) => x * 2
      expect(() => clearMemoizeCache(regularFn)).not.toThrow()
    })

    it('clears both stores', () => {
      class Point { constructor(public x: number) {} }
      // eslint-disable-next-line ts/no-explicit-any
      const fn = memoize(mock((x: any) => x))
      const pointRef = new Point(1)

      fn({ id: 1 })
      fn(pointRef)

      const store = getCacheStore(fn)!
      expect(store.cache.size).toBe(1)
      expect(store.fallbackEntries.length).toBe(1)

      clearMemoizeCache(fn)

      expect(store.cache.size).toBe(0)
      expect(store.fallbackEntries.length).toBe(0)
    })
  })

  describe('serialisable keys', () => {
    it('distinguishes values that share a string form', () => {
      // eslint-disable-next-line ts/no-explicit-any
      const callback = mock((x: any) => x)
      const fn = memoize(callback)

      fn(1)
      fn('1')
      fn(true)
      fn(null)
      fn('null')
      fn(undefined)
      expect(callback).toHaveBeenCalledTimes(6)
    })

    it('treats NaN as equal to itself', () => {
      const callback = mock((x: number) => x)
      const fn = memoize(callback)

      fn(Number.NaN)
      fn(Number.NaN)
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('memoizes Date, RegExp, Map, Set, and BigInt keys', () => {
      // eslint-disable-next-line ts/no-explicit-any
      const callback = mock((_: any) => 'ok')
      const fn = memoize(callback)

      fn(new Date(1000))
      fn(new Date(1000))
      fn(/foo/g)
      fn(/foo/g)
      fn(new Map([['a', 1]]))
      fn(new Map([['a', 1]]))
      fn(new Set([1, 2, 3]))
      fn(new Set([1, 2, 3]))
      fn(10n)
      fn(10n)

      expect(callback).toHaveBeenCalledTimes(5)
    })

    it('scales to many distinct entries', () => {
      const callback = mock((x: { id: number }) => x.id)
      const fn = memoize(callback)
      const N = 5000

      for (let i = 0; i < N; i++) fn({ id: i })
      for (let i = 0; i < N; i++) fn({ id: i })

      expect(callback).toHaveBeenCalledTimes(N)
      const store = getCacheStore(fn)!
      expect(store.cache.size).toBe(N)
      expect(store.fallbackEntries.length).toBe(0)
    })

    it('handles cyclic keys via devalue without crashing', () => {
      // eslint-disable-next-line ts/no-explicit-any
      const cyclic: any = { a: 1 }
      cyclic.self = cyclic

      // eslint-disable-next-line ts/no-explicit-any
      const callback = mock((obj: any) => obj.a)
      const fn = memoize(callback)

      expect(() => fn(cyclic)).not.toThrow()
      expect(fn(cyclic)).toBe(1)
      expect(callback).toHaveBeenCalledTimes(1)
    })
  })

  describe('stale option', () => {
    it('serves the stale value immediately and refreshes once in the background', async () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        const resolvers: ((value: string) => void)[] = []
        const callback = mock(
          (_: number) => new Promise<string>((resolve) => { resolvers.push(resolve) }),
        )
        const fn = memoize(callback, { maxAge: 100, stale: true })

        const first = fn(1)
        resolvers[0]!('v1')
        expect(await first).toBe('v1')
        expect(callback).toHaveBeenCalledTimes(1)
        expect(isMemoized(fn)).toBe(true)

        now += 101
        const staleHit = fn(1)
        expect(callback).toHaveBeenCalledTimes(2)
        expect(await staleHit).toBe('v1')

        expect(await fn(1)).toBe('v1')
        expect(callback).toHaveBeenCalledTimes(2)

        const pending = (getCacheStore(fn)!.primitiveCache.get(1) as MemoizedCacheEntry<AnyFunction>).pending
        resolvers[1]!('v2')
        await pending

        expect(await fn(1)).toBe('v2')
        expect(callback).toHaveBeenCalledTimes(2)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('keeps serving the stale value across failing refreshes', async () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now
      const unhandled = mock(() => {})
      process.on('unhandledRejection', unhandled)

      try {
        const onError = mock(() => {})
        let calls = 0
        const callback = mock(async (_: number) => {
          calls++
          if (calls === 1)
            return 'v1'
          throw new Error(`fail${calls}`)
        })
        const fn = memoize(callback, { maxAge: 100, stale: true, onError })

        expect(await fn(1)).toBe('v1')

        now += 101
        expect(await fn(1)).toBe('v1')
        await (getCacheStore(fn)!.primitiveCache.get(1) as MemoizedCacheEntry<AnyFunction>).pending
        expect(onError).toHaveBeenCalledTimes(1)

        expect(await fn(1)).toBe('v1')
        await (getCacheStore(fn)!.primitiveCache.get(1) as MemoizedCacheEntry<AnyFunction>).pending
        expect(onError).toHaveBeenCalledTimes(2)
        expect(callback).toHaveBeenCalledTimes(3)

        await new Promise(resolve => setTimeout(resolve, 0))
        expect(unhandled).not.toHaveBeenCalled()
      }
      finally {
        process.off('unhandledRejection', unhandled)
        Date.now = dateNow
      }
    })

    it('retains the value after a failed refresh so the next call retries', async () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        const onError = mock(() => {})
        let calls = 0
        const callback = mock(async (_a: number, _b: number) => {
          calls++
          if (calls === 2)
            throw new Error('fail')
          return `v${calls}`
        })
        const fn = memoize(callback, { maxAge: 100, stale: true, onError })
        // Two primitive args live in the args trie: arity root -> first arg -> leaf.
        const leaf = () => getCacheStore(fn)!.argsTries.get(2)!.children!.get(1)!.entries!.get(2) as MemoizedCacheEntry<AnyFunction>

        expect(await fn(1, 2)).toBe('v1')

        now += 101
        expect(await fn(1, 2)).toBe('v1')
        await leaf().pending
        expect(onError).toHaveBeenCalledTimes(1)
        expect(leaf()).toBeDefined()

        expect(await fn(1, 2)).toBe('v1')
        await leaf().pending
        expect(await fn(1, 2)).toBe('v3')
        expect(callback).toHaveBeenCalledTimes(3)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('still rejects and evicts on a cold cache', async () => {
      const callback = mock(async (_: number) => {
        throw new Error('boom')
      })
      const fn = memoize(callback, { maxAge: 100, stale: true })

      await expect(fn(1)).rejects.toThrow('boom')
      expect(getCacheStore(fn)!.primitiveCache.size).toBe(0)
      await expect(fn(1)).rejects.toThrow('boom')
      expect(callback).toHaveBeenCalledTimes(2)
    })

    it('numeric bound: beyond the window callers block on a fresh computation', async () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        let calls = 0
        const callback = mock(async (_: number) => `v${++calls}`)
        const fn = memoize(callback, { maxAge: 100, stale: 50 })

        expect(await fn(1)).toBe('v1')

        // 30ms past expiry — inside the window.
        now += 130
        expect(await fn(1)).toBe('v1')
        await (getCacheStore(fn)!.primitiveCache.get(1) as MemoizedCacheEntry<AnyFunction>).pending // 'v2' stored at now=130

        // 51ms past expiry — outside the window, so the call blocks on the refresh.
        now += 151
        expect(await fn(1)).toBe('v3')
        expect(callback).toHaveBeenCalledTimes(3)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('numeric bound: beyond the window a rejection propagates and evicts', async () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        const onError = mock(() => {})
        let calls = 0
        const callback = mock(async (_: number) => {
          calls++
          if (calls === 1)
            return 'v1'
          throw new Error(`fail${calls}`)
        })
        const fn = memoize(callback, { maxAge: 100, stale: 50, onError })

        expect(await fn(1)).toBe('v1')

        // 20ms past expiry — inside the window.
        now += 120
        expect(await fn(1)).toBe('v1')
        await (getCacheStore(fn)!.primitiveCache.get(1) as MemoizedCacheEntry<AnyFunction>).pending
        expect(onError).toHaveBeenCalledTimes(1)

        // 100ms past expiry — outside the window.
        now += 80
        await expect(fn(1)).rejects.toThrow('fail3')
        expect(onError).toHaveBeenCalledTimes(1)
        expect(getCacheStore(fn)!.primitiveCache.size).toBe(0)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('supports reference-identity keys', async () => {
      class Point { constructor(public x: number) {} }

      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        let calls = 0
        const callback = mock(async (_: Point) => {
          calls++
          if (calls === 2)
            throw new Error('fail')
          return `v${calls}`
        })
        const fn = memoize(callback, { maxAge: 100, stale: true })
        const point = new Point(1)

        expect(await fn(point)).toBe('v1')

        now += 101
        expect(await fn(point)).toBe('v1')
        await getCacheStore(fn)!.fallbackEntries[0]!.pending
        expect(getCacheStore(fn)!.fallbackEntries.length).toBe(1)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('serves the stale value and recomputes synchronously for sync functions', () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        let calls = 0
        const callback = mock((_: number) => `v${++calls}`)
        const fn = memoize(callback, { maxAge: 100, stale: true })

        expect(fn(1)).toBe('v1')

        now += 101
        expect(fn(1)).toBe('v1')
        expect(callback).toHaveBeenCalledTimes(2)
        expect(fn(1)).toBe('v2')
        expect(callback).toHaveBeenCalledTimes(2)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('serves the previous value when a sync function throws', () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        const onError = mock(() => {})
        let calls = 0
        const callback = mock((_: number) => {
          calls++
          if (calls > 1)
            throw new Error('fail')
          return 'v1'
        })
        const fn = memoize(callback, { maxAge: 100, stale: true, onError })

        expect(fn(1)).toBe('v1')

        now += 101
        expect(fn(1)).toBe('v1')
        expect(onError).toHaveBeenCalledTimes(1)
        expect(callback).toHaveBeenCalledTimes(2)
      }
      finally {
        Date.now = dateNow
      }
    })

    it('clearMemoizeCache drops retained stale values', async () => {
      let now = 0
      const dateNow = Date.now
      Date.now = () => now

      try {
        let calls = 0
        const callback = mock(async (_: number) => {
          calls++
          if (calls === 2)
            throw new Error('fail')
          return `v${calls}`
        })
        const fn = memoize(callback, { maxAge: 100, stale: true })

        expect(await fn(1)).toBe('v1')

        now += 101
        clearMemoizeCache(fn)

        await expect(fn(1)).rejects.toThrow('fail')
        expect(callback).toHaveBeenCalledTimes(2)
      }
      finally {
        Date.now = dateNow
      }
    })
  })

  describe('unserialisable keys (by reference identity)', () => {
    class Point { constructor(public x: number) {} }

    it('memoizes class-instance keys by reference identity', () => {
      // eslint-disable-next-line ts/no-explicit-any
      const callback = mock((_: any) => 'ok')
      const fn = memoize(callback)

      const p = new Point(1)
      fn(p)
      fn(p)
      expect(callback).toHaveBeenCalledTimes(1)

      fn(new Point(1))
      expect(callback).toHaveBeenCalledTimes(2)
    })

    it('memoizes function-valued keys by reference identity', () => {
      const shared = () => 1
      // eslint-disable-next-line ts/no-explicit-any
      const callback = mock((_: any) => 'ok')
      const fn = memoize(callback)

      fn(shared)
      fn(shared)
      expect(callback).toHaveBeenCalledTimes(1)

      fn(() => 1)
      expect(callback).toHaveBeenCalledTimes(2)
    })
  })
})
