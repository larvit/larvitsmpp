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
