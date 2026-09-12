export type LogMetadata = Record<string, boolean | number | string>;
export type LogMethod = (msg: string, metadata?: LogMetadata) => void;

/** What the library needs from a logger. A `@larvit/log` instance satisfies it as it stands. */
export type SmppLog = {
	debug: LogMethod;
	error: LogMethod;
	info: LogMethod;
	verbose: LogMethod;
	warn: LogMethod;
};

const noop: LogMethod = () => undefined;

/** The default: a library that says nothing unless the application asks it to. */
export const silentLog: SmppLog = {
	debug: noop,
	error: noop,
	info: noop,
	verbose: noop,
	warn: noop,
};

function contained(log: SmppLog, method: keyof SmppLog): LogMethod {
	return (msg, metadata) => {
		try {
			log[method](msg, metadata);
		} catch {
			// Reporting a broken logger would need a logger, and hard rule 1 outranks the report.
		}
	};
}

/** The application's logger with a throw from it contained, or silence when it supplied none. */
export function guardedLog(log?: SmppLog): SmppLog {
	if (log === undefined) return silentLog;

	return {
		debug: contained(log, 'debug'),
		error: contained(log, 'error'),
		info: contained(log, 'info'),
		verbose: contained(log, 'verbose'),
		warn: contained(log, 'warn'),
	};
}
