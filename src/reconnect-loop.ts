import type { Result, VoidResult } from './result.ts';
import type { SmppLog } from './log.ts';
import type { Socket } from 'node:net';

export type ReconnectLoopOptions = {
	connect: () => Promise<Result<{ sock: Socket }>>;
	log: SmppLog;
	maxDelay: number;
	minDelay: number;
	now?: (() => number) | undefined;
	/** Brings the owner back up on a freshly opened socket. An err means try again. */
	onConnected: (sock: Socket) => Promise<VoidResult>;
};

/** Reopens a dropped connection, backing off between attempts until it is told to stop. */
export class ReconnectLoop {
	private readonly now: () => number;
	private readonly options: ReconnectLoopOptions;
	private attempting = false;
	private delay: number;
	private halted = false;
	private timer: NodeJS.Timeout | undefined;
	private upAt: number | undefined;

	constructor(options: ReconnectLoopOptions) {
		this.now = options.now ?? Date.now;
		this.options = options;
		this.delay = options.minDelay;
	}

	/** Read through a method: stop() can land while an attempt is awaiting. */
	isStopped(): boolean {
		return this.halted;
	}

	schedule(): void {
		if (this.timer || this.attempting || this.isStopped()) return;

		// Coming up is not proof: a stream we cannot read is only found once the link is bound.
		if (this.upAt !== undefined && this.now() - this.upAt >= this.options.maxDelay) {
			this.delay = this.options.minDelay;
		}

		this.upAt = undefined;

		const delay = this.delay;

		this.options.log.info('reconnect - retrying after a drop', { delay });

		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.run();
		}, delay);
		this.timer.unref();

		this.delay = Math.min(delay * 2, this.options.maxDelay);
	}

	stop(): void {
		this.halted = true;

		if (this.timer) clearTimeout(this.timer);

		this.timer = undefined;
	}

	private async run(): Promise<void> {
		this.attempting = true;

		// connect() and onConnected() are the application's, so a throw from either lands here.
		const retry = await this.attempt().catch((thrown: unknown) => {
			const err = thrown instanceof Error ? thrown : new Error(String(thrown));

			this.options.log.error('reconnect - an attempt threw', { message: err.message });

			return true;
		});

		this.attempting = false;

		if (retry) this.schedule();
	}

	/** True means the attempt failed and the loop should try again. */
	private async attempt(): Promise<boolean> {
		if (this.isStopped()) return false;

		const opened = await this.options.connect();

		if (opened.err) {
			this.options.log.warn('reconnect - could not open a socket', {
				message: opened.err.message,
			});

			return true;
		}

		if (this.isStopped()) {
			opened.sock.destroy();

			return false;
		}

		const up = await this.bringUp(opened.sock);

		if (up.err) {
			this.options.log.warn('reconnect - could not come back up', { message: up.err.message });

			return true;
		}

		this.upAt = this.now();

		return false;
	}

	/** The loop owns the socket until the owner is up on it, so a failed handover must not leak it. */
	private async bringUp(sock: Socket): Promise<VoidResult> {
		try {
			const up = await this.options.onConnected(sock);

			if (up.err) sock.destroy();

			return up;
		} catch (thrown: unknown) {
			sock.destroy();

			return { err: thrown instanceof Error ? thrown : new Error(String(thrown)) };
		}
	}
}
