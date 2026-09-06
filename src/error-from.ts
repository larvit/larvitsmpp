/** Whatever was thrown or rejected, as an Error. `String()` throws on some values; this cannot. */
export function errorFrom(reason: unknown): Error {
	if (reason instanceof Error) return reason;

	try {
		return new Error(String(reason));
	} catch {
		return new Error('A thrown value that cannot be converted to a string');
	}
}

/** What a refusal names a rejected option back as: the value where printing one helps, else its type. */
export function namedValue(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : typeof value;
}
