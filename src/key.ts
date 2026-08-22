import { stringify } from 'devalue'

export const BY_REFERENCE = Symbol('memoize-by-reference')

function getPrimitiveCacheKey(value: unknown): string | null | typeof BY_REFERENCE {
  if (value === null)
    return 'l'

  switch (typeof value) {
    case 'undefined':
      return 'u'
    case 'boolean':
      return value ? 'b1' : 'b0'
    case 'bigint':
      return `i${value}`
    case 'string':
      // The length prefix keeps concatenated structural keys unambiguous.
      return `s${value.length}:${value}`
    case 'number':
      if (Number.isNaN(value))
        return 'nNaN'
      if (value === Number.POSITIVE_INFINITY)
        return 'n+Inf'
      if (value === Number.NEGATIVE_INFINITY)
        return 'n-Inf'
      if (Object.is(value, -0))
        return 'n-0'
      return `n${value}`
    case 'object':
      return null
    default:
      return BY_REFERENCE
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function getStructuralCacheKey(
  value: unknown,
  seen: Map<object, number>,
): string | typeof BY_REFERENCE {
  const primitiveKey = getPrimitiveCacheKey(value)
  if (primitiveKey === BY_REFERENCE)
    return BY_REFERENCE

  if (primitiveKey !== null)
    return primitiveKey

  return walkStructural(value as object, seen)
}

function walkStructural(
  objectValue: object,
  seen: Map<object, number>,
): string | typeof BY_REFERENCE {
  const seenId = seen.get(objectValue)
  if (seenId !== undefined)
    return `r${seenId}`

  if (Array.isArray(objectValue)) {
    seen.set(objectValue, seen.size)
    let key = `[${objectValue.length}|`

    for (let index = 0; index < objectValue.length; index++) {
      const itemKey = getStructuralCacheKey(objectValue[index], seen)
      if (itemKey === BY_REFERENCE)
        return BY_REFERENCE

      key += itemKey
      key += ','
    }

    return `${key}]`
  }

  if (isPlainObject(objectValue)) {
    seen.set(objectValue, seen.size)
    const keys = Object.keys(objectValue)
    let key = `o${keys.length}|`

    for (const propertyKey of keys) {
      const valueKey = getStructuralCacheKey(objectValue[propertyKey], seen)
      if (valueKey === BY_REFERENCE)
        return BY_REFERENCE

      key += `${propertyKey.length}:${propertyKey}=${valueKey},`
    }

    return `${key}}`
  }

  // Dates and RegExps are value-keyed but can never participate in a cycle,
  // so they are intentionally never registered in `seen` — two structurally
  // equal instances must produce the same key regardless of identity.
  if (objectValue instanceof Date)
    return `d${objectValue.getTime()}`

  if (objectValue instanceof RegExp)
    return `x${objectValue.source}/${objectValue.flags}`

  if (objectValue instanceof Map) {
    seen.set(objectValue, seen.size)
    let key = `m${objectValue.size}|`

    for (const [entryKey, entryValue] of objectValue) {
      const mappedKey = getStructuralCacheKey(entryKey, seen)
      if (mappedKey === BY_REFERENCE)
        return BY_REFERENCE

      const mappedValue = getStructuralCacheKey(entryValue, seen)
      if (mappedValue === BY_REFERENCE)
        return BY_REFERENCE

      key += `${mappedKey}=>${mappedValue},`
    }

    return `${key}}`
  }

  if (objectValue instanceof Set) {
    seen.set(objectValue, seen.size)
    let key = `t${objectValue.size}|`

    for (const entryValue of objectValue) {
      const entryKeyPart = getStructuralCacheKey(entryValue, seen)
      if (entryKeyPart === BY_REFERENCE)
        return BY_REFERENCE

      key += entryKeyPart
      key += ','
    }

    return `${key})`
  }

  seen.set(objectValue, seen.size)

  try {
    return stringify(objectValue)
  }
  catch {
    return BY_REFERENCE
  }
}

// Reused across calls to avoid allocating a Map per structural key. If a key
// computation re-enters (e.g. a property getter calls a memoized function),
// the inner call falls back to a fresh Map.
let pooledSeen: Map<object, number> | null = new Map()

function withPooledSeen(value: object): string | typeof BY_REFERENCE {
  const seen = pooledSeen ?? new Map<object, number>()
  pooledSeen = null

  try {
    return walkStructural(value, seen)
  }
  finally {
    seen.clear()
    pooledSeen = seen
  }
}

export function getCacheKey(value: unknown): string | typeof BY_REFERENCE {
  // Top-level fast path for the most common key type. No length prefix is
  // needed here — nothing is concatenated after a top-level string key.
  if (typeof value === 'string')
    return `s${value}`

  const primitiveKey = getPrimitiveCacheKey(value)
  if (primitiveKey === BY_REFERENCE)
    return BY_REFERENCE

  if (primitiveKey !== null)
    return primitiveKey

  return withPooledSeen(value as object)
}

/**
 * Cache key for a full arguments list. Fast path: when every argument is a
 * primitive (the overwhelmingly common case), the key is built with plain
 * string concatenation — no `seen` map, no recursion. Falls back to the
 * structural walk as soon as a non-primitive argument shows up.
 */
export function getArgsCacheKey(params: unknown[]): string | typeof BY_REFERENCE {
  let key = `[${params.length}|`

  for (let index = 0; index < params.length; index++) {
    const primitiveKey = getPrimitiveCacheKey(params[index])
    if (primitiveKey === BY_REFERENCE)
      return BY_REFERENCE

    if (primitiveKey === null)
      return withPooledSeen(params)

    key += primitiveKey
    key += ','
  }

  return `${key}]`
}

export function findReferenceEntry<T extends { key: unknown }>(
  entries: T[],
  key: unknown,
): T | undefined {
  for (const entry of entries) {
    if (entry.key === key)
      return entry

    if (Array.isArray(entry.key) && Array.isArray(key)) {
      if (entry.key.length !== key.length)
        continue

      let isEqual = true

      for (let index = 0; index < key.length; index++) {
        if (entry.key[index] !== key[index]) {
          isEqual = false
          break
        }
      }

      if (isEqual)
        return entry
    }
  }

  return undefined
}
