import type { LogInt } from '@larvit/log';
import type { Result, VoidResult } from './result.ts';
import type { Socket } from 'node:net';

export type ReconnectLoopOptions = {
	connect: () => Promise<Result<{ sock: Socket }>>;
	log: LogInt;
	maxDelay: number;
	minDelay: number;
	/** Brings the owner back up on a freshly opened socket. An err means try again. */
	onConnected: (sock: Socket) => Promise<VoidResult>;
};

/** Reopens a dropped connection, backing off between attempts until it is told to stop. */
export class ReconnectLoop {
	private readonly options: ReconnectLoopOptions;
	private delay: number;
	private halted = false;
	private timer: NodeJS.Timeout | undefined;

	constructor(options: ReconnectLoopOptions) {
		this.options = options;
		this.delay = options.minDelay;
	}

	/** Read through a method: stop() can land while an attempt is awaiting. */
	isStopped(): boolean {
		return this.halted;
	}

	schedule(): void {
		if (this.timer || this.isStopped()) return;

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
		if (this.isStopped()) return;

		const opened = await this.options.connect();

		if (opened.err) {
			this.options.log.warn('reconnect - could not open a socket', {
				message: opened.err.message,
			});
			this.schedule();

			return;
		}

		if (this.isStopped()) {
			opened.sock.destroy();

			return;
		}

		const up = await this.options.onConnected(opened.sock);

		if (up.err) {
			this.options.log.warn('reconnect - could not come back up', { message: up.err.message });
			this.schedule();

			return;
		}

		this.delay = this.options.minDelay;
	}
}
