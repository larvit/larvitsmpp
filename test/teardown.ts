import type { CloseOptions } from '../src/session-options.ts';
import type { Server, Socket } from 'node:net';
import type { TestContext } from 'node:test';

type Closable = { close: (options: CloseOptions) => Promise<unknown> };

/** Aborted: a cleanup that drained would hang the run in exactly the case it exists for. */
export function closeAfter(t: TestContext, closable: Closable): void {
	t.after(() => closable.close({ signal: AbortSignal.abort() }));
}

/** A listener with a socket still on it never closes, so the sockets go first. */
export function endListenerAfter(t: TestContext, listener: Server, sockets: Socket[]): void {
	t.after(async () => {
		for (const sock of sockets) {
			sock.destroy();
		}

		await new Promise<void>(resolve => { listener.close(() => { resolve(); }); });
	});
}
