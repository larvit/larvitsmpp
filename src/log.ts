import type { LogInt } from '@larvit/log';
import { Log } from '@larvit/log';

/** The default: a library that says nothing unless the application asks it to. */
export const silentLog: LogInt = new Log({ logLevel: 'none' });
