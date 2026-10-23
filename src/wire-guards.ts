/** Non-throwing value guards for untrusted provider payloads. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Tool arguments may arrive as an object OR as a complete JSON string; an
 * unfinished string fragment is never treated as complete arguments.
 */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Some providers stream incomplete JSON argument fragments.
    }
  }
  return {}
}

/** A non-empty string, or undefined. Blank-after-trim counts as absent. */
export function nonEmptyString(value: unknown): string | undefined {
  const text = stringValue(value)
  if (text === undefined) return undefined
  return text.trim() === '' ? undefined : text
}
