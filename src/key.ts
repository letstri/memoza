import { stringify } from 'devalue'

export const BY_REFERENCE = Symbol('memoize-by-reference')

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function getStructuralCacheKey(value: unknown): string | typeof BY_REFERENCE {
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
      // NaN and ±Infinity already stringify uniquely; only -0 would turn into "0".
      return Object.is(value, -0) ? 'n-0' : `n${value}`
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
    // `Object.keys` skips symbol keys, and those only compare by identity.
    if (Object.getOwnPropertySymbols(objectValue).length > 0)
      return BY_REFERENCE

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

  // Class instances: devalue rejects them anyway, and a throw per call is
  // slow. A null grandparent prototype means a plain object from another
  // realm, which devalue can still handle.
  if (Object.prototype.toString.call(objectValue) === '[object Object]'
    && Object.getPrototypeOf(Object.getPrototypeOf(objectValue)) !== null) {
    return BY_REFERENCE
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

// True when `JSON.stringify` keys the value exactly: plain objects and
// arrays of strings, booleans, null and finite numbers other than -0.
// Native stringify is much faster than building the key by hand. Deep
// nesting (or a cycle) bails out to the structural walk.
function isJsonSafe(value: unknown, depth: number): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value) && (value !== 0 || 1 / value > 0)
    case 'object':
      break
    default:
      return false
  }

  if (value === null)
    return true

  if (depth > 32)
    return false

  if (Array.isArray(value)) {
    // Holes read as undefined, so they bail out too.
    for (let index = 0; index < value.length; index++) {
      if (!isJsonSafe(value[index], depth + 1))
        return false
    }
    return true
  }

  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0)
    return false

  for (const propertyKey in value) {
    if (!isJsonSafe(value[propertyKey], depth + 1))
      return false
  }
  return true
}

export function getCacheKey(value: unknown): string | typeof BY_REFERENCE {
  // No length prefix here — nothing is concatenated after a top-level key.
  if (typeof value === 'string')
    return `s${value}`

  if (typeof value !== 'object' || value === null)
    return getStructuralCacheKey(value)

  return isJsonSafe(value, 0) ? `j${JSON.stringify(value)}` : withStack(value)
}

export function getArgsCacheKey(params: unknown[]): string | typeof BY_REFERENCE {
  const key = isJsonSafe(params, 0) ? `j${JSON.stringify(params)}` : withStack(params)
  // The prefix keeps `fn(a, b)` apart from `fn([a, b])`.
  return key === BY_REFERENCE ? key : `a${key}`
}
