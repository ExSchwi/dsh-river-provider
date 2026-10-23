/** Non-throwing value guards for untrusted provider payloads. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function stringValue(value: unknown): string | undefined;
export declare function numberValue(value: unknown): number | undefined;
export declare function booleanValue(value: unknown): boolean | undefined;
/**
 * Tool arguments may arrive as an object OR as a complete JSON string; an
 * unfinished string fragment is never treated as complete arguments.
 */
export declare function recordOrEmpty(value: unknown): Record<string, unknown>;
/** A non-empty string, or undefined. Blank-after-trim counts as absent. */
export declare function nonEmptyString(value: unknown): string | undefined;
