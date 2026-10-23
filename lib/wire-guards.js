/** Non-throwing value guards for untrusted provider payloads. */
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function stringValue(value) {
    return typeof value === 'string' ? value : undefined;
}
export function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function booleanValue(value) {
    return typeof value === 'boolean' ? value : undefined;
}
/**
 * Tool arguments may arrive as an object OR as a complete JSON string; an
 * unfinished string fragment is never treated as complete arguments.
 */
export function recordOrEmpty(value) {
    if (isRecord(value))
        return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (isRecord(parsed))
                return parsed;
        }
        catch {
            // Some providers stream incomplete JSON argument fragments.
        }
    }
    return {};
}
/** A non-empty string, or undefined. Blank-after-trim counts as absent. */
export function nonEmptyString(value) {
    const text = stringValue(value);
    if (text === undefined)
        return undefined;
    return text.trim() === '' ? undefined : text;
}
//# sourceMappingURL=wire-guards.js.map