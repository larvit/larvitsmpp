/** The request went out and no answer came back: the peer may have accepted it. */
export class UnansweredError extends Error {
	constructor(cause: Error) {
		super(`No answer came back, so the peer may have accepted it: ${cause.message}`, { cause });
		this.name = 'UnansweredError';
	}
}
