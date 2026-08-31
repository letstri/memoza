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

// Duplicates getPrimitiveCacheKey so the hot structural loops skip a call
// and a null-sentinel check per value.
function getStructuralCacheKey(value: unknown): string | typeof BY_REFERENCE {
  switch (typeof value) {
    case 'undefined':
      return 'u'
    case 'boolean':
      return value ? 'b1' : 'b0'
    case 'bigint':
      return `i${value}`
    case 'string':
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
      return value === null ? 'l' : walkStructural(value)
    default:
      return BY_REFERENCE
  }
}

// Frames pop only on successful returns — aborted and throwing walks are
// cleaned up by `withStack`, whose base index also keeps re-entrant walks
// (a property getter calling a memoized function) from seeing each other's
// ancestors.
const stack: object[] = []
let stackBase = 0

function walkStructural(objectValue: object): string | typeof BY_REFERENCE {
  const cycleIndex = stack.indexOf(objectValue, stackBase)
  if (cycleIndex !== -1)
    return `r${cycleIndex - stackBase}`

  if (Array.isArray(objectValue)) {
    stack.push(objectValue)
    let key = `[${objectValue.length}|`

    for (let index = 0; index < objectValue.length; index++) {
      const itemKey = getStructuralCacheKey(objectValue[index])
      if (itemKey === BY_REFERENCE)
        return BY_REFERENCE

      key += itemKey
      key += ','
    }

    stack.pop()
    return `${key}]`
  }

  if (isPlainObject(objectValue)) {
    stack.push(objectValue)
    const keys = Object.keys(objectValue)
    let key = `o${keys.length}|`

    for (const propertyKey of keys) {
      const valueKey = getStructuralCacheKey(objectValue[propertyKey])
      if (valueKey === BY_REFERENCE)
        return BY_REFERENCE

      key += `${propertyKey.length}:${propertyKey}=${valueKey},`
    }

    stack.pop()
    return `${key}}`
  }

  // Dates and RegExps never join the stack — two structurally equal
  // instances must key the same regardless of identity.
  if (objectValue instanceof Date)
    return `d${objectValue.getTime()}`

  if (objectValue instanceof RegExp)
    return `x${objectValue.source}/${objectValue.flags}`

  if (objectValue instanceof Map) {
    stack.push(objectValue)
    let key = `m${objectValue.size}|`

    for (const [entryKey, entryValue] of objectValue) {
      const mappedKey = getStructuralCacheKey(entryKey)
      if (mappedKey === BY_REFERENCE)
        return BY_REFERENCE

      const mappedValue = getStructuralCacheKey(entryValue)
      if (mappedValue === BY_REFERENCE)
        return BY_REFERENCE

      key += `${mappedKey}=>${mappedValue},`
    }

    stack.pop()
    return `${key}}`
  }

  if (objectValue instanceof Set) {
    stack.push(objectValue)
    let key = `t${objectValue.size}|`

    for (const entryValue of objectValue) {
      const entryKeyPart = getStructuralCacheKey(entryValue)
      if (entryKeyPart === BY_REFERENCE)
        return BY_REFERENCE

      key += entryKeyPart
      key += ','
    }

    stack.pop()
    return `${key})`
  }

  try {
    return stringify(objectValue)
  }
  catch {
    return BY_REFERENCE
  }
}

function withStack(value: object): string | typeof BY_REFERENCE {
  const previousBase = stackBase
  stackBase = stack.length

  try {
    return walkStructural(value)
  }
  finally {
    stack.length = stackBase
    stackBase = previousBase
  }
}

export function getCacheKey(value: unknown): string | typeof BY_REFERENCE {
  // No length prefix here — nothing is concatenated after a top-level key.
  if (typeof value === 'string')
    return `s${value}`

  if (typeof value === 'object' && value !== null)
    return withStack(value)

  const primitiveKey = getPrimitiveCacheKey(value)
  // `null` marks non-null objects, which were already handled above.
  return primitiveKey === null ? BY_REFERENCE : primitiveKey
}

export function getArgsCacheKey(params: unknown[]): string | typeof BY_REFERENCE {
  let key = `[${params.length}|`

  for (let index = 0; index < params.length; index++) {
    const primitiveKey = getPrimitiveCacheKey(params[index])
    if (primitiveKey === BY_REFERENCE)
      return BY_REFERENCE

    if (primitiveKey === null)
      return withStack(params)

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
