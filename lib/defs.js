'use strict';

// More or less copied from https://github.com/farhadi/node-smpp

const	topLogPrefix	= 'larvitsmpp: lib/defs.js: ',
	constsById	= {},
	errorsById	= {},
	encodings	= {},
	tlvsById	= {},
	cmdsById	= {},
	filters	= {},
	errors	= {},
	consts	= {},
	types	= {},
	tlvs	= {},
	cmds	= {},
	iconv	= require('iconv-lite'),
	LUtils	= require('larvitutils'),
	lUtils	= new LUtils(),
	log	= new lUtils.Log('error');

consts.REGISTERED_DELIVERY = {
	'FINAL':	0x01,
	'FAILURE':	0x02,
	'SUCCESS':	0x03,
	'DELIVERY_ACKNOWLEDGEMENT':	0x04,
	'USER_ACKNOWLEDGEMENT':	0x08,
	'INTERMEDIATE':	0x10
};
consts.ESM_CLASS = {
	'DATAGRAM':	0x01,
	'FORWARD':	0x02,
	'STORE_FORWARD':	0x03,
	'MC_DELIVERY_RECEIPT':	0x04,
	'DELIVERY_ACKNOWLEDGEMENT':	0x08,
	'USER_ACKNOWLEDGEMENT':	0x10,
	'CONVERSATION_ABORT':	0x18,
	'INTERMEDIATE_DELIVERY':	0x20,
	'UDH_INDICATOR':	0x40,
	'SET_REPLY_PATH':	0x80
};
consts.MESSAGE_STATE = {
	'SCHEDULED':	0,
	'ENROUTE':	1,
	'DELIVERED':	2,
	'EXPIRED':	3,
	'DELETED':	4,
	'UNDELIVERABLE':	5,
	'ACCEPTED':	6,
	'UNKNOWN':	7,
	'REJECTED':	8,
	'SKIPPED':	9
};
consts.TON = {
	'UNKNOWN':	0x00,
	'INTERNATIONAL':	0x01,
	'NATIONAL':	0x02,
	'NETWORK_SPECIFIC':	0x03,
	'SUBSCRIBER_NUMBER':	0x04,
	'ALPHANUMERIC':	0x05,
	'ABBREVIATED':	0x06
};
consts.NPI = {
	'UNKNOWN':	0x00,
	'ISDN':	0x01,
	'DATA':	0x03,
	'TELEX':	0x04,
	'LAND_MOBILE':	0x06,
	'NATIONAL':	0x08,
	'PRIVATE':	0x09,
	'ERMES':	0x0A,
	'INTERNET':	0x0E,
	'IP':	0x0E,
	'WAP':	0x12
};
consts.ENCODING = {
	'ASCII':	0x01,
	'IA5':	0x01,
	'LATIN1':	0x03,
	'ISO_8859_1':	0x03,
	'BINARY':	0x04,
	'JIS':	0x05,
	'X_0208_1990':	0x05,
	'CYRILLIC':	0x06,
	'ISO_8859_5':	0x06,
	'HEBREW':	0x07,
	'ISO_8859_8':	0x07,
	'UCS2':	0x08,
	'PICTOGRAM':	0x09,
	'ISO_2022_JP':	0x0A,
	'EXTENDED_KANJI_JIS':	0x0D,
	'X_0212_1990':	0x0D,
	'KS_C_5601':	0x0E,
	'FLASH':	0x10
};
consts.NETWORK = {
	'GENERIC':	0x00,
	'GSM':	0x01,
	'TDMA':	0x02,
	'CDMA':	0x03
};
consts.BROADCAST_AREA_FORMAT = {
	'NAME':	0x00,
	'ALIAS':	0x00,
	'ELLIPSOID_ARC':	0x01,
	'POLYGON':	0x02
};
consts.BROADCAST_FREQUENCY_INTERVAL = {
	'MAX_POSSIBLE':	0x00,
	'SECONDS':	0x08,
	'MINUTES':	0x09,
	'HOURS':	0x0A,
	'DAYS':	0x0B,
	'WEEKS':	0x0C,
	'MONTHS':	0x0D,
	'YEARS':	0x0E
};

for (const constGrp in consts) {
	if (constsById[constGrp] === undefined) {
		constsById[constGrp]	= {};
	}

	for (const constName in consts[constGrp]) {
		constsById[constGrp][consts[constGrp][constName]]	= constName;
	}
}

types.int8 = {
	'read': function read(buffer, offset) {
		return buffer.readUInt8(offset);
	},
	'write': function write(value, buffer, offset) {
		const	logPrefix	= topLogPrefix + 'types.int8.write() - ';

		value	= value || 0;

		try {
			buffer.writeUInt8(value, offset);
		} catch (err) {
			log.error(logPrefix + 'Could not write integer value "' + value + '" on offset "' + offset + '" when buffer length is "' + buffer.length + '"');
			throw err;
		}
	},
	'size': function size() {
		return 1;
	},
	'default': 0
};

types.int16 = {
	'read': function read(buffer, offset) {
		return buffer.readUInt16BE(offset);
	},
	'write': function write(value, buffer, offset) {
		value = value || 0;
		buffer.writeUInt16BE(value, offset);
	},
	'size': function size() {
		return 2;
	},
	'default': 0
};

types.int32 = {
	'read': function read(buffer, offset) {
		return buffer.readUInt32BE(offset);
	},
	'write': function write(value, buffer, offset) {
		value = value || 0;
		buffer.writeUInt32BE(value, offset);
	},
	'size': function size() {
		return 4;
	},
	'default': 0
};

types.string = {
	'read': function read(buffer, offset) {
		const	length	= buffer.readUInt8(offset ++);
		return buffer.toString('ascii', offset, offset + length);
	},
	'write': function write(value, buffer, offset) {
		buffer.writeUInt8(value.length, offset ++);
		if (typeof value === 'number') {
			value = value.toString();
		}
		if (typeof value === 'string') {
			value = new Buffer(value, 'ascii');
		}
		value.copy(buffer, offset);
	},
	'size': function size(value) {
		if (typeof value === 'number') {
			value = value.toString();
		}
		return value.length + 1;
	},
	'default': ''
};

types.cstring = {
	'read': function read(buffer, offset) {
		let	length	= 0;

		// Increase length until the null-octet is found
		while (buffer[offset + length]) {
			length ++;
		}

		return buffer.toString('ascii', offset, offset + length);
	},
	'write': function write(value, buffer, offset) {
		if (typeof value === 'number') {
			value = value.toString();
		}
		if (typeof value === 'string') {
			value = new Buffer(value, 'ascii');
		}
		value.copy(buffer, offset);
		buffer[offset + value.length] = 0;
	},
	'size': function size(value) {
		if (typeof value === 'number') {
			value = value.toString();
		}

		return value.length + 1;
	},
	'default': ''
};

types.buffer = {
	'read': function read(buffer, offset, length) {
		return buffer.slice(offset, offset + length);
	},
	'write': function write(value, buffer, offset) {
		if (typeof value === 'number') {
			value = value.toString();
		}
		if (typeof value === 'string') {
			value = new Buffer(value, 'ascii');
		}
		value.copy(buffer, offset);
	},
	'size': function size(buffer) {
		if (buffer[buffer.length - 1] === 0x00) {
			return buffer.length - 1;
		} else {
			return buffer.length;
		}
	},
	'default': new Buffer(0)
};

types.dest_address_array = {
	'read': function read(buffer, offset) {
		const	result	= [];

		let	number_of_dests	= buffer.readUInt8(offset ++),
			dest_address,
			dest_flag;

		while (number_of_dests -- > 0) {
			dest_flag	= buffer.readUInt8(offset ++);
			if (dest_flag === 1) {
				dest_address = {
					'dest_addr_ton':	buffer.readUInt8(offset ++),
					'dest_addr_npi':	buffer.readUInt8(offset ++),
					'destination_addr':	types.cstring.read(buffer, offset)
				};
				offset	+= types.cstring.size(dest_address.destination_addr);
			} else {
				dest_address = {
					'dl_name':	types.cstring.read(buffer, offset)
				};
				offset	+= types.cstring.size(dest_address.dl_name);
			}
			result.push(dest_address);
		}
		return result;
	},
	'write': function write(value, buffer, offset) {
		buffer.writeUInt8(value.length, offset ++);
		value.forEach(function (dest_address) {
			if (Object.keys(dest_address).indexOf('dl_name') !== - 1) {
				buffer.writeUInt8(2, offset ++);
				types.cstring.write(dest_address.dl_name, buffer, offset);
				offset	+= types.cstring.size(dest_address.dl_name);
			} else {
				buffer.writeUInt8(1,	offset ++);
				buffer.writeUInt8(dest_address.dest_addr_ton || 0,	offset ++);
				buffer.writeUInt8(dest_address.dest_addr_npi || 0,	offset ++);
				types.cstring.write(dest_address.destination_addr, buffer, offset);
				offset	+= types.cstring.size(dest_address.destination_addr);
			}
		});
	},
	'size': function size(value) {
		let	size	= 1;
		value.forEach(function (dest_address) {
			if (Object.keys(dest_address).indexOf('dl_name') !== - 1) {
				size	+= types.cstring.size(dest_address.dl_name) + 1;
			} else {
				size	+= types.cstring.size(dest_address.destination_addr) + 3;
			}
		});
		return size;
	},
	'default': []
};

types.unsuccess_sme_array = {
	'read': function read(buffer, offset) {
		const	result	= [];

		let	no_unsuccess	= buffer.readUInt8(offset ++);

		while (no_unsuccess -- > 0) {
			const unsuccess_sme = {
				'dest_addr_ton':	buffer.readUInt8(offset ++),
				'dest_addr_npi':	buffer.readUInt8(offset ++),
				'destination_addr':	types.cstring.read(buffer, offset)
			};
			offset	+= types.cstring.size(unsuccess_sme.destination_addr);
			unsuccess_sme.error_status_code	= buffer.readUInt32BE(offset);
			offset	+= 4;
			result.push(unsuccess_sme);
		}
		return result;
	},
	'write': function write(value, buffer, offset) {
		buffer.writeUInt8(value.length, offset ++);
		value.forEach(function (unsuccess_sme) {
			buffer.writeUInt8(unsuccess_sme.dest_addr_ton || 0, offset ++);
			buffer.writeUInt8(unsuccess_sme.dest_addr_npi || 0, offset ++);
			types.cstring.write(unsuccess_sme.destination_addr, buffer, offset);
			offset += types.cstring.size(unsuccess_sme.destination_addr);
			buffer.writeUInt32BE(unsuccess_sme.error_status_code, offset);
			offset += 4;
		});
	},
	'size': function size(value) {
		let	size	= 1;
		value.forEach(function (unsuccess_sme) {
			size += types.cstring.size(unsuccess_sme.destination_addr) + 6;
		});
		return size;
	},
	'default': []
};

types.tlv = {
	'int8':	types.int8,
	'int16':	types.int16,
	'int32':	types.int32,
	'cstring':	types.cstring,
	'string': {
		'read': function read(buffer, offset, length) {
			return buffer.toString('ascii', offset, offset + length);
		},
		'write': function write(value, buffer, offset) {
			if (typeof value === 'number') {
				value = value.toString();
			}
			if (typeof value === 'string') {
				value = new Buffer(value, 'ascii');
			}
			value.copy(buffer, offset);
		},
		'size': function size(value) {
			if (typeof value === 'number') {
				value = value.toString();
			}
			return value.length;
		},
		'default': ''
	},
	'buffer': {
		'read': function read(buffer, offset, length) {
			return buffer.slice(offset, offset + length);
		},
		'write': function write(value, buffer, offset) {
			if (typeof value === 'number') {
				value = value.toString();
			}
			if (typeof value === 'string') {
				value = new Buffer(value, 'ascii');
			}
			value.copy(buffer, offset);
		},
		'size': function size(value) {
			if (typeof value === 'number') {
				value = value.toString();
			}
			return value.length;
		},
		'default': null
	}
};

encodings.ASCII = { // GSM 03.38
	'chars':	'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
	'charCodes':	{},
	'extChars':	{},
	'regex':	/^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\f^{}\\[~\]|€]*$/,

	'init': function init() {
		const	from	= '\f^{}\\[~]|€',
			to	= '\nΛ()/<=>¡e';

		for (let i = 0; i < this.chars.length; i ++) {
			this.charCodes[this.chars[i]] = i;
		}

		for (let i = 0; i < from.length; i ++) {
			this.extChars[from[i]] = to[i];
			this.extChars[to[i]] = from[i];
		}
	},

	'match': function match(value) {
		return this.regex.test(value);
	},

	'encode': function encode(value) {
		const	result	= [];

		value = value.replace(/[\f^{}\\[~\]|€]/g, function (match) {
			return '\x1B' + this.extChars[match];
		}.bind(this));

		for (let i = 0; i < value.length; i ++) {
			result.push(value[i] in this.charCodes ? this.charCodes[value[i]] : 0x20);
		}

		return new Buffer(result);
	},

	'decode': function (value) {
		let	result	= '';

		for (let i = 0; i < value.length; i ++) {
			result += this.chars[value[i]] || ' ';
		}

		result = result.replace(/\x1B([\nΛ()\/<=>¡e])/g, function (match, p1) {
			return this.extChars[p1];
		}.bind(this));

		return result;
	}
};

encodings.FLASH = encodings.ASCII;

encodings.ASCII.init();

encodings.LATIN1 = {
	// Never use this for new messages
	'match': function match() {
		return false;
	},
	/*'match': function match(value) {
		return value === iconv.decode(iconv.encode(value, 'latin1'), 'latin1');
	},*/
	'encode': function encode(value) {
		return iconv.encode(value, 'latin1');
	},
	'decode': function decode(value) {
		return iconv.decode(value, 'latin1');
	}
};

encodings.UCS2 = {
	'match': function match() {
		return true;
	},
	'encode': function encode(value) {
		return iconv.encode(value, 'utf16-be');
	},
	'decode': function decode(value) {
		return iconv.decode(value, 'utf16-be');
	}
};

Object.defineProperty(encodings, 'detect', {
	'value': function value(value) {
		for (const key in encodings) {
			if (encodings[key].match(value)) {
				return key;
			}
		}

		return false;
	}
});

filters.time = {
	'encode': function encode(value) {
		let	result;

		if ( ! value) {
			return value;
		}

		if (typeof value === 'string') {
			if (value.length <= 12) {
				value	= ('000000000000' + value).substr(- 12) + '000R';
			}

			return value;
		}

		if (value instanceof Date) {
			result	= value.getUTCFullYear().toString().substr(- 2);
			result	+= ('0' + (value.getUTCMonth() + 1)).substr(- 2);
			result	+= ('0' + value.getUTCDate()).substr(- 2);
			result	+= ('0' + value.getUTCHours()).substr(- 2);
			result	+= ('0' + value.getUTCMinutes()).substr(- 2);
			result	+= ('0' + value.getUTCSeconds()).substr(- 2);
			result	+= ('00' + value.getUTCMilliseconds()).substr(- 3, 1);
			result	+= '00+';

			return result;
		}

		return value;
	},

	'decode': function decode(value) {
		const	century	= ('000' + new Date().getUTCFullYear()).substr(- 4, 2);

		let	result	= new Date(value.replace(/^(..)(..)(..)(..)(..)(..)(.)?.*$/, century + '$1-$2-$3 $4:$5:$6:$700 UTC')),
			match   = value.match(/(..)([-+])$/),
			diff;

		if ( ! value || typeof value !== 'string') {
			return value;
		}

		if (value.substr(- 1) === 'R') {
			result	= new Date();
			match	= value.match(/^(..)(..)(..)(..)(..)(..).*$/);

			['FullYear', 'Month', 'Date', 'Hours', 'Minutes', 'Seconds'].forEach(
				function (method, i) {
					result['set' + method](result['get' + method]() + + match[++ i]);
				}
			);

			return result;
		}

		if (match && match[1] !== '00') {
			diff = match[1] * 15;
			if (match[2] === '+') {
				diff = - diff;
			}
			result.setMinutes(result.getMinutes() + diff);
		}

		return result;
	}
};

filters.message = {
	'encode': function encode(value) {
		let	message	= typeof value === 'string' ? value : value.message,
			encoding	= encodings.detect(message);

		if (Buffer.isBuffer(value)) {
			return value;
		}

		if (typeof message === 'string') {
			if (message && ! this.data_coding) {
				this.data_coding = consts.ENCODING[encoding];
			}

			message	= encodings[encoding].encode(message);
		}

		if ( ! value.udh || ! value.udh.length) {
			return message;
		}

		this.esm_class	= this.esm_class | consts.ESM_CLASS.UDH_INDICATOR;

		return Buffer.concat([value.udh, message]);
	},

	'decode': function decode(value) {
		const	result	= {};

		let	encoding	= this.data_coding & 0x0F,
			udhi	= this.esm_class & consts.ESM_CLASS.UDH_INDICATOR,
			key;

		if ( ! Buffer.isBuffer(value)) {
			return value;
		}

		if ( ! encoding) {
			encoding	= 'ASCII';
		} else {
			for (key in consts.ENCODING) {
				if (consts.ENCODING[key] === encoding) {
					encoding	= key;
					break;
				}
			}
		}

		if (value.length && udhi) {
			result.udh	= value.slice(0, value[0] + 1);
			result.message	= value.slice(value[0] + 1);
		} else {
			result.message	= value;
		}

		if (encodings[encoding]) {
			result.message	= encodings[encoding].decode(result.message);
		}

		return result;
	}
};

filters.billing_identification = {
	'encode': function encode(value) {
		let	result	= new Buffer(value.data.length + 1);

		if (Buffer.isBuffer(value)) {
			return value;
		}

		result.writeUInt8(value.format, 0);
		value.data.copy(result, 1);

		return result;
	},

	'decode': function decode(value) {
		if ( ! Buffer.isBuffer(value)) {
			return value;
		}

		return {
			'format':	value.readUInt8(0),
			'data':	value.slice(1)
		};
	}
};

filters.broadcast_area_identifier = {
	'encode': function encode(value) {
		let	result	= new Buffer(value.data.length + 1);

		if (Buffer.isBuffer(value)) {
			return value;
		}

		if (typeof value === 'string') {
			value = {
				'format':	consts.BROADCAST_AREA_FORMAT.NAME,
				'data':	value
			};
		}

		if (typeof value.data === 'string') {
			value.data	= new Buffer(value.data, 'ascii');
		}

		result.writeUInt8(value.format, 0);
		value.data.copy(result, 1);

		return result;
	},

	'decode': function decode(value) {
		const result = {
			'format':	value.readUInt8(0),
			'data':	value.slice(1)
		};

		if ( ! Buffer.isBuffer(value)) {
			return value;
		}

		if (result.format === consts.BROADCAST_AREA_FORMAT.NAME) {
			result.data = result.data.toString('ascii');
		}

		return result;
	}
};

filters.broadcast_content_type = {
	'encode': function encode(value) {
		let	result	= new Buffer(3);

		if (Buffer.isBuffer(value)) {
			return value;
		}

		result.writeUInt8(value.network, 0);
		result.writeUInt16BE(value.content_type, 1);

		return result;
	},

	'decode': function decode(value) {
		if ( ! Buffer.isBuffer(value)) {
			return value;
		}

		return {
			'network':	value.readUInt8(0),
			'content_type':	value.readUInt16BE(1)
		};
	}
};

filters.broadcast_frequency_interval = {
	'encode': function encode(value) {
		let	result	= new Buffer(3);

		if (Buffer.isBuffer(value)) {
			return value;
		}

		result.writeUInt8(value.unit, 0);
		result.writeUInt16BE(value.interval, 1);

		return result;
	},

	'decode': function decode(value) {
		if ( ! Buffer.isBuffer(value)) {
			return value;
		}

		return {
			'unit':	value.readUInt8(0),
			'interval':	value.readUInt16BE(1)
		};
	}
};

filters.callback_num = {
	'encode': function encode(value) {
		let	result	= new Buffer(value.number.length + 3);

		if (Buffer.isBuffer(value)) {
			return value;
		}

		result.writeUInt8(value.digit_mode || 0, 0);
		result.writeUInt8(value.ton || 0, 1);
		result.writeUInt8(value.npi || 0, 2);
		result.write(value.number, 3, 'ascii');

		return result;
	},
	'decode': function decode(value) {
		if ( ! Buffer.isBuffer(value)) {
			return value;
		}

		return {
			'digit_mode':	value.readUInt8(0),
			'ton':	value.readUInt8(1),
			'npi':	value.readUInt8(2),
			'number':	value.toString('ascii', 3)
		};
	}
};

filters.callback_num_atag = {
	'encode': function encode(value) {
		let	result	= new Buffer(value.display.length + 1);

		if (Buffer.isBuffer(value)) {
			return value;
		}

		result.writeUInt8(value.encoding, 0);

		if (typeof value.display === 'string') {
			value.display = new Buffer(value.display, 'ascii');
		}

		value.display.copy(result, 1);

		return result;
	},

	'decode': function decode(value) {
		if ( ! Buffer.isBuffer(value)) {
			return value;
		}

		return {
			'encoding':	value.readUInt8(0),
			'display':	value.slice(1)
		};
	}
};

tlvs.default = {
	'id':	undefined,
	'type':	types.tlv.buffer
};
tlvs.dest_addr_subunit = {
	'id':	0x0005,
	'type':	types.tlv.int8
};
tlvs.dest_network_type = {
	'id':	0x0006,
	'type':	types.tlv.int8
};
tlvs.dest_bearer_type = {
	'id':	0x0007,
	'type':	types.tlv.int8
};
tlvs.dest_telematics_id = {
	'id':	0x0008,
	'type':	types.tlv.int16
};
tlvs.source_addr_subunit = {
	'id':	0x000D,
	'type':	types.tlv.int8
};
tlvs.source_network_type = {
	'id':	0x000E,
	'type':	types.tlv.int8
};
tlvs.source_bearer_type = {
	'id':	0x000F,
	'type':	types.tlv.int8
};
tlvs.source_telematics_id = {
	'id':	0x0010,
	'type':	types.tlv.int16
};
tlvs.qos_time_to_live = {
	'id':	0x0017,
	'type':	types.tlv.int32
};
tlvs.payload_type = {
	'id':	0x0019,
	'type':	types.tlv.int8
};
tlvs.additional_status_info_text = {
	'id':	0x001D,
	'type':	types.tlv.cstring
};
tlvs.receipted_message_id = {
	'id':	0x001E,
	'type':	types.tlv.cstring
};
tlvs.ms_msg_wait_facilities = {
	'id':	0x0030,
	'type':	types.tlv.int8
};
tlvs.privacy_indicator = {
	'id':	0x0201,
	'type':	types.tlv.int8
};
tlvs.source_subaddress = {
	'id':	0x0202,
	'type':	types.tlv.buffer
};
tlvs.dest_subaddress = {
	'id':	0x0203,
	'type':	types.tlv.buffer
};
tlvs.user_message_reference = {
	'id':	0x0204,
	'type':	types.tlv.int16
};
tlvs.user_response_code = {
	'id':	0x0205,
	'type':	types.tlv.int8
};
tlvs.source_port = {
	'id':	0x020A,
	'type':	types.tlv.int16
};
tlvs.dest_port = {
	'id':	0x020B,
	'type':	types.tlv.int16
};
tlvs.sar_msg_ref_num = {
	'id':	0x020C,
	'type':	types.tlv.int16
};
tlvs.language_indicator = {
	'id':	0x020D,
	'type':	types.tlv.int8
};
tlvs.sar_total_segments = {
	'id':	0x020E,
	'type':	types.tlv.int8
};
tlvs.sar_segment_seqnum = {
	'id':	0x020F,
	'type':	types.tlv.int8
};
tlvs.sc_interface_version = {
	'id':	0x0210,
	'type':	types.tlv.int8
};
tlvs.callback_num_pres_ind = {
	'id':	0x0302,
	'type':	types.tlv.int8,
	'multiple':	true
};
tlvs.callback_num_atag = {
	'id':	0x0303,
	'type':	types.tlv.buffer,
	'filter':	filters.callback_num_atag,
	'multiple':	true
};
tlvs.number_of_messages = {
	'id':	0x0304,
	'type':	types.tlv.int8
};
tlvs.callback_num = {
	'id':	0x0381,
	'type':	types.tlv.buffer,
	'filter':	filters.callback_num,
	'multiple':	true
};
tlvs.dpf_result = {
	'id':	0x0420,
	'type':	types.tlv.int8
};
tlvs.set_dpf = {
	'id':	0x0421,
	'type':	types.tlv.int8
};
tlvs.ms_availability_status = {
	'id':	0x0422,
	'type':	types.tlv.int8
};
tlvs.network_error_code = {
	'id':	0x0423,
	'type':	types.tlv.buffer
};
tlvs.message_payload = {
	'id':	0x0424,
	'type':	types.tlv.buffer,
	'filter':	filters.message
};
tlvs.delivery_failure_reason = {
	'id':	0x0425,
	'type':	types.tlv.int8
};
tlvs.more_messages_to_send = {
	'id':	0x0426,
	'type':	types.tlv.int8
};
tlvs.message_state = {
	'id':	0x0427,
	'type':	types.tlv.int8
};
tlvs.congestion_state = {
	'id':	0x0428,
	'type':	types.tlv.int8
};
tlvs.ussd_service_op = {
	'id':	0x0501,
	'type':	types.tlv.int8
};
tlvs.broadcast_channel_indicator = {
	'id':	0x0600,
	'type':	types.tlv.int8
};
tlvs.broadcast_content_type = {
	'id':	0x0601,
	'type':	types.tlv.buffer,
	'filter':	filters.broadcast_content_type
};
tlvs.broadcast_content_type_info = {
	'id':	0x0602,
	'type':	types.tlv.string
};
tlvs.broadcast_message_class = {
	'id':	0x0603,
	'type':	types.tlv.int8
};
tlvs.broadcast_rep_num = {
	'id':	0x0604,
	'type':	types.tlv.int16
};
tlvs.broadcast_frequency_interval = {
	'id':	0x0605,
	'type':	types.tlv.buffer,
	'filter':	filters.broadcast_frequency_interval
};
tlvs.broadcast_area_identifier = {
	'id':	0x0606,
	'type':	types.tlv.buffer,
	'filter':	filters.broadcast_area_identifier,
	'multiple':	true
};
tlvs.broadcast_error_status = {
	'id':	0x0607,
	'type':	types.tlv.int32,
	'multiple':	true
};
tlvs.broadcast_area_success = {
	'id':	0x0608,
	'type':	types.tlv.int8
};
tlvs.broadcast_end_time = {
	'id':	0x0609,
	'type':	types.tlv.string,
	'filter':	filters.time
};
tlvs.broadcast_service_group = {
	'id':	0x060A,
	'type':	types.tlv.string
};
tlvs.billing_identification = {
	'id':	0x060B,
	'type':	types.tlv.buffer,
	'filter':	filters.billing_identification
};
tlvs.source_network_id = {
	'id':	0x060D,
	'type':	types.tlv.cstring
};
tlvs.dest_network_id = {
	'id':	0x060E,
	'type':	types.tlv.cstring
};
tlvs.source_node_id = {
	'id':	0x060F,
	'type':	types.tlv.string
};
tlvs.dest_node_id = {
	'id':	0x0610,
	'type':	types.tlv.string
};
tlvs.dest_addr_np_resolution = {
	'id':	0x0611,
	'type':	types.tlv.int8
};
tlvs.dest_addr_np_information = {
	'id':	0x0612,
	'type':	types.tlv.string
};
tlvs.dest_addr_np_country = {
	'id':	0x0613,
	'type':	types.tlv.int32
};
tlvs.display_time = {
	'id':	0x1201,
	'type':	types.tlv.int8
};
tlvs.sms_signal = {
	'id':	0x1203,
	'type':	types.tlv.int16
};
tlvs.ms_validity = {
	'id':	0x1204,
	'type':	types.tlv.buffer
};
tlvs.alert_on_message_delivery = {
	'id':	0x130C,
	'type':	types.tlv.int8
};
tlvs.its_reply_type = {
	'id':	0x1380,
	'type':	types.tlv.int8
};
tlvs.its_session_info = {
	'id':	0x1383,
	'type':	types.tlv.buffer
};

for (const tag in tlvs) {
	tlvsById[tlvs[tag].id]	= tlvs[tag];
	tlvs[tag].tag	= tag;
}

tlvs.alert_on_msg_delivery	= tlvs.alert_on_message_delivery;
tlvs.failed_broadcast_area_identifier	= tlvs.broadcast_area_identifier;

cmds.alert_notification = {
	'id':	0x00000102,
	'params': {
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring},
		'esme_addr_ton':	{type: types.int8},
		'esme_addr_npi':	{type: types.int8},
		'esme_addr':	{type: types.cstring}
	}
};
cmds.bind_receiver = {
	'id':	0x00000001,
	'params': {
		'system_id':	{type: types.cstring},
		'password':	{type: types.cstring},
		'system_type':	{type: types.cstring},
		'interface_version':	{type: types.int8, 'default': 0x50},
		'addr_ton':	{type: types.int8},
		'addr_npi':	{type: types.int8},
		'address_range':	{type: types.cstring}
	}
};
cmds.bind_receiver_resp = {
	'id':	0x80000001,
	'params': {
		'system_id':	{type: types.cstring}
	}
};
cmds.bind_transmitter = {
	'id':	0x00000002,
	'params': {
		'system_id':	{type: types.cstring},
		'password':	{type: types.cstring},
		'system_type':	{type: types.cstring},
		'interface_version':	{type: types.int8, 'default': 0x50},
		'addr_ton':	{type: types.int8},
		'addr_npi':	{type: types.int8},
		'address_range':	{type: types.cstring}
	}
};
cmds.bind_transmitter_resp = {
	'id':	0x80000002,
	'params': {
		'system_id':	{type: types.cstring}
	}
};
cmds.bind_transceiver = {
	'id':	0x00000009,
	'params': {
		'system_id':	{type: types.cstring},
		'password':	{type: types.cstring},
		'system_type':	{type: types.cstring},
		'interface_version':	{type: types.int8, 'default': 0x50},
		'addr_ton':	{type: types.int8},
		'addr_npi':	{type: types.int8},
		'address_range':	{type: types.cstring}
	}
};
cmds.bind_transceiver_resp = {
	'id':	0x80000009,
	'params': {
		'system_id': {type: types.cstring}
	}
};
cmds.broadcast_sm = {
	'id':	0x00000111,
	'params': {
		'service_type':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring},
		'message_id':	{type: types.cstring},
		'priority_flag':	{type: types.int8},
		'schedule_delivery_time':	{type: types.cstring, filter: filters.time},
		'validity_period':	{type: types.cstring, filter: filters.time},
		'replace_if_present_flag':	{type: types.int8},
		'data_coding':	{type: types.int8},
		'sm_default_msg_id':	{type: types.int8}
	}
};
cmds.broadcast_sm_resp = {
	'id':	0x80000111,
	'params': {
		'message_id':	{type: types.cstring}
	},
	'tlvMap': {
		'broadcast_area_identifier':	'failed_broadcast_area_identifier'
	}
};
cmds.cancel_broadcast_sm = {
	'id':	0x00000113,
	'params': {
		'service_type':	{type: types.cstring},
		'message_id':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring}
	}
};
cmds.cancel_broadcast_sm_resp = {
	'id':	0x80000113
};
cmds.cancel_sm = {
	'id':	0x00000008,
	'params': {
		'service_type':	{type: types.cstring},
		'message_id':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring},
		'dest_addr_ton':	{type: types.int8},
		'dest_addr_npi':	{type: types.int8},
		'destination_addr':	{type: types.cstring}
	}
};
cmds.cancel_sm_resp = {
	'id':	0x80000008
};
cmds.data_sm = {
	'id':	0x00000103,
	'params': {
		'service_type':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring},
		'dest_addr_ton':	{type: types.int8},
		'dest_addr_npi':	{type: types.int8},
		'destination_addr':	{type: types.cstring},
		'esm_class':	{type: types.int8},
		'registered_delivery':	{type: types.int8},
		'data_coding':	{type: types.int8}
	}
};
cmds.data_sm_resp = {
	'id':	0x80000103,
	'params': {
		'message_id':	{type: types.cstring}
	}
};
cmds.deliver_sm = {
	'id':	0x00000005,
	'params': {
		'service_type':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring},
		'dest_addr_ton':	{type: types.int8},
		'dest_addr_npi':	{type: types.int8},
		'destination_addr':	{type: types.cstring},
		'esm_class':	{type: types.int8},
		'protocol_id':	{type: types.int8},
		'priority_flag':	{type: types.int8},
		'schedule_delivery_time':	{type: types.cstring, filter: filters.time},
		'validity_period':	{type: types.cstring, filter: filters.time},
		'registered_delivery':	{type: types.int8},
		'replace_if_present_flag':	{type: types.int8},
		'data_coding':	{type: types.int8},
		'sm_default_msg_id':	{type: types.int8},
		'sm_length':	{type: types.int8},
		'short_message':	{type: types.buffer, filter: filters.message}
	}
};
cmds.deliver_sm_resp = {
	'id':	0x80000005,
	'params': {
		'message_id':	{type: types.cstring}
	}
};
cmds.enquire_link = {
	'id':	0x00000015
};
cmds.enquire_link_resp = {
	'id':	0x80000015
};
cmds.generic_nack = {
	'id':	0x80000000
};
cmds.outbind = {
	'id':	0x0000000B,
	'params': {
		'system_id':	{type: types.cstring},
		'password':	{type: types.cstring}
	}
};
cmds.query_broadcast_sm = {
	'id':	0x00000112,
	'params': {
		'message_id':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring}
	}
};
cmds.query_broadcast_sm_resp = {
	'id':	0x80000112,
	'params': {
		'message_id':	{type: types.cstring}
	}
};
cmds.query_sm = {
	'id':	0x00000003,
	'params': {
		'message_id':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring}
	}
};
cmds.query_sm_resp = {
	'id':	0x80000003,
	'params': {
		'message_id':	{type: types.cstring},
		'final_date':	{type: types.cstring, filter: filters.time},
		'message_state':	{type: types.int8},
		'error_code':	{type: types.int8}
	}
};
cmds.replace_sm = {
	'id':	0x00000007,
	'params': {
		'message_id':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring},
		'schedule_delivery_time':	{type: types.cstring, filter: filters.time},
		'validity_period':	{type: types.cstring, filter: filters.time},
		'registered_delivery':	{type: types.int8},
		'sm_default_msg_id':	{type: types.int8},
		'sm_length':	{type: types.int8},
		'short_message':	{type: types.buffer, filter: filters.message}
	}
};
cmds.replace_sm_resp = {
	'id':	0x80000007
};
cmds.submit_multi = {
	'id':	0x00000021,
	'params': {
		'service_type':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring},
		//'number_of_dests':	{type: types.int8},
		'dest_address':	{type: types.dest_address_array},
		'esm_class':	{type: types.int8},
		'protocol_id':	{type: types.int8},
		'priority_flag':	{type: types.int8},
		'schedule_delivery_time':	{type: types.cstring, filter: filters.time},
		'validity_period':	{type: types.cstring, filter: filters.time},
		'registered_delivery':	{type: types.int8},
		'replace_if_present_flag':	{type: types.int8},
		'data_coding':	{type: types.int8},
		'sm_default_msg_id':	{type: types.int8},
		//'sm_length':	{type: types.int8},
		'short_message':	{type: types.buffer, filter: filters.message}
	}
};
cmds.submit_multi_resp = {
	'id':	0x80000021,
	'params': {
		'message_id':	{type: types.cstring},
		//'no_unsuccess':	{type: types.int8},
		'unsuccess_sme':	{type: types.unsuccess_sme_array}
	}
};
cmds.submit_sm = {
	'id':	0x00000004,
	'params': {
		'service_type':	{type: types.cstring},
		'source_addr_ton':	{type: types.int8},
		'source_addr_npi':	{type: types.int8},
		'source_addr':	{type: types.cstring},
		'dest_addr_ton':	{type: types.int8},
		'dest_addr_npi':	{type: types.int8},
		'destination_addr':	{type: types.cstring},
		'esm_class':	{type: types.int8},
		'protocol_id':	{type: types.int8},
		'priority_flag':	{type: types.int8},
		'schedule_delivery_time':	{type: types.cstring, filter: filters.time},
		'validity_period':	{type: types.cstring, filter: filters.time},
		'registered_delivery':	{type: types.int8},
		'replace_if_present_flag':	{type: types.int8},
		'data_coding':	{type: types.int8},
		'sm_default_msg_id':	{type: types.int8},
		'sm_length':	{type: types.int8},
		'short_message':	{type: types.buffer, filter: filters.message}
	}
};
cmds.submit_sm_resp = {
	'id':	0x80000004,
	'params': {
		'message_id': {type: types.cstring}
	}
};
cmds.unbind = {
	'id':	0x00000006
};
cmds.unbind_resp = {
	'id':	0x80000006
};

for (const command in cmds) {
	cmdsById[cmds[command].id]	= cmds[command];
	cmds[command].command	= command;
}

errors.ESME_ROK	= 0x0000;
errors.ESME_RINVMSGLEN	= 0x0001;
errors.ESME_RINVCMDLEN	= 0x0002;
errors.ESME_RINVCMDID	= 0x0003;
errors.ESME_RINVBNDSTS	= 0x0004;
errors.ESME_RALYBND	= 0x0005;
errors.ESME_RINVPRTFLG	= 0x0006;
errors.ESME_RINVREGDLVFLG	= 0x0007;
errors.ESME_RSYSERR	= 0x0008;
errors.ESME_RINVSRCADR	= 0x000A;
errors.ESME_RINVDSTADR	= 0x000B;
errors.ESME_RINVMSGID	= 0x000C;
errors.ESME_RBINDFAIL	= 0x000D;
errors.ESME_RINVPASWD	= 0x000E;
errors.ESME_RINVSYSID	= 0x000F;
errors.ESME_RCANCELFAIL	= 0x0011;
errors.ESME_RREPLACEFAIL	= 0x0013;
errors.ESME_RMSGQFUL	= 0x0014;
errors.ESME_RINVSERTYP	= 0x0015;
errors.ESME_RINVNUMDESTS	= 0x0033;
errors.ESME_RINVDLNAME	= 0x0034;
errors.ESME_RINVDESTFLAG	= 0x0040;
errors.ESME_RINVSUBREP	= 0x0042;
errors.ESME_RINVESMCLASS	= 0x0043;
errors.ESME_RCNTSUBDL	= 0x0044;
errors.ESME_RSUBMITFAIL	= 0x0045;
errors.ESME_RINVSRCTON	= 0x0048;
errors.ESME_RINVSRCNPI	= 0x0049;
errors.ESME_RINVDSTTON	= 0x0050;
errors.ESME_RINVDSTNPI	= 0x0051;
errors.ESME_RINVSYSTYP	= 0x0053;
errors.ESME_RINVREPFLAG	= 0x0054;
errors.ESME_RINVNUMMSGS	= 0x0055;
errors.ESME_RTHROTTLED	= 0x0058;
errors.ESME_RINVSCHED	= 0x0061;
errors.ESME_RINVEXPIRY	= 0x0062;
errors.ESME_RINVDFTMSGID	= 0x0063;
errors.ESME_RX_T_APPN	= 0x0064;
errors.ESME_RX_P_APPN	= 0x0065;
errors.ESME_RX_R_APPN	= 0x0066;
errors.ESME_RQUERYFAIL	= 0x0067;
errors.ESME_RINVTLVSTREAM	= 0x00C0;
errors.ESME_RTLVNOTALLWD	= 0x00C1;
errors.ESME_RINVTLVLEN	= 0x00C2;
errors.ESME_RMISSINGTLV	= 0x00C3;
errors.ESME_RINVTLVVAL	= 0x00C4;
errors.ESME_RDELIVERYFAILURE	= 0x00FE;
errors.ESME_RUNKNOWNERR	= 0x00FF;
errors.ESME_RSERTYPUNAUTH	= 0x0100;
errors.ESME_RPROHIBITED	= 0x0101;
errors.ESME_RSERTYPUNAVAIL	= 0x0102;
errors.ESME_RSERTYPDENIED	= 0x0103;
errors.ESME_RINVDCS	= 0x0104;
errors.ESME_RINVSRCADDRSUBUNIT	= 0x0105;
errors.ESME_RINVDSTADDRSUBUNIT	= 0x0106;
errors.ESME_RINVBCASTFREQINT	= 0x0107;
errors.ESME_RINVBCASTALIAS_NAME	= 0x0108;
errors.ESME_RINVBCASTAREAFMT	= 0x0109;
errors.ESME_RINVNUMBCAST_AREAS	= 0x010A;
errors.ESME_RINVBCASTCNTTYPE	= 0x010B;
errors.ESME_RINVBCASTMSGCLASS	= 0x010C;
errors.ESME_RBCASTFAIL	= 0x010D;
errors.ESME_RBCASTQUERYFAIL	= 0x010E;
errors.ESME_RBCASTCANCELFAIL	= 0x010F;
errors.ESME_RINVBCAST_REP	= 0x0110;
errors.ESME_RINVBCASTSRVGRP	= 0x0111;
errors.ESME_RINVBCASTCHANIND	= 0x011;

for (const error in errors) {
	errorsById[errors[error]] = error;
}

exports.encodings  = encodings;
exports.filters    = filters;
exports.consts     = consts;
exports.constsById = constsById;
exports.cmds       = cmds;
exports.cmdsById   = cmdsById;
exports.types      = types;
exports.tlvs       = tlvs;
exports.tlvsById   = tlvsById;
exports.errors     = errors;
exports.errorsById = errorsById;
