/**
 * Either a failure carrying err, or a success carrying T. Both branches declare every key, so
 * callers can destructure once and let `if (err)` narrow what is left.
 */
export type Result<T> =
	| ({ err: Error } & Partial<Record<keyof T, undefined>>)
	| ({ err?: undefined } & T);

export type VoidResult = { err?: Error };
