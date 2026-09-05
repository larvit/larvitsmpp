import type { SmppLog } from './log.ts';

export type LinkTimersOptions = {
	/** How long between enquire_link probes. Undefined or 0 never probes. */
	enquireLinkInterval?: number | undefined;
	/** How long a silent peer is kept. Undefined or 0 keeps it forever. */
	idleTimeout?: number | undefined;
	log: SmppLog;
	onEnquireLink: () => void;
	onIdle: () => void;
};

/** Keeps a quiet connection honest: probes the peer, and gives up on one that stays silent. */
export class LinkTimers {
	private readonly options: LinkTimersOptions;
	private enquireLink: NodeJS.Timeout | undefined;
	private idle: NodeJS.Timeout | undefined;

	constructor(options: LinkTimersOptions) {
		this.options = options;
	}

	/** Starts both timers over, which every sign of life from the peer should do. */
	reset(): void {
		const { enquireLinkInterval, idleTimeout, log, onEnquireLink, onIdle } = this.options;

		this.clear();

		if (enquireLinkInterval !== undefined && enquireLinkInterval > 0) {
			this.enquireLink = setTimeout(onEnquireLink, enquireLinkInterval);
			this.enquireLink.unref();
		}

		if (idleTimeout !== undefined && idleTimeout > 0) {
			this.idle = setTimeout(() => {
				log.info('linkTimers - closing an idle peer', { idleTimeout });
				onIdle();
			}, idleTimeout);
			this.idle.unref();
		}
	}

	clear(): void {
		if (this.enquireLink) clearTimeout(this.enquireLink);
		if (this.idle) clearTimeout(this.idle);

		this.enquireLink = undefined;
		this.idle = undefined;
	}
}
