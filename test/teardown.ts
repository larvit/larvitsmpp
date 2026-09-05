import type { CloseOptions } from '../src/session-options.ts';
import type { Server, Socket } from 'node:net';
import type { TestContext } from 'node:test';

type Closable = { close: (options: CloseOptions) => Promise<unknown> };

/** Aborted: a cleanup that drained would hang the run in exactly the case it exists for. */
export function closeAfter(t: TestContext, closable: Closable): void {
	t.after(() => closable.close({ signal: AbortSignal.abort() }));
}

/**
 * Stops a listener, given every socket it accepted — one still open and it never closes. The wait is
 * bounded because a caller that misses one must not hang the net itself.
 */
export function closeListenerAfter(t: TestContext, listener: Server, accepted: Socket[]): void {
	t.after(async () => {
		for (const sock of accepted) {
			sock.destroy();
		}

		await Promise.race([
			new Promise<void>(resolve => { listener.close(() => { resolve(); }); }),
			new Promise<void>(resolve => { setTimeout(resolve, 1000).unref(); }),
		]);
	});
}
