'use strict';

const	topLogPrefix	= 'larvitsmpp: lib/utils.js: ',
	defs	= require(__dirname + '/defs.js'),
	log	= require('winston');

let	bundleMsgId	= 0;

/**
 * Calculate cmdLength from object
 *
 * @param {object} obj
 * @param {function} cb - cb(err, cmdLength)
 */
function calcCmdLength(obj, cb) {
	const	logPrefix	= topLogPrefix + 'calcCmdLength() - ';

	let	cmdLength	= 16;	// All commands are at least 16 octets long

	// Handle params - All command params should always exists, even if they do not contain data.
	for (const param in defs.cmds[obj.cmdName].params) {
		// Get the parameter type, int, string, cstring etc.
		// This is needed so we can calculate length etc
		const	paramType = defs.cmds[obj.cmdName].params[param].type;

		if (obj.params[param] === undefined) {
			obj.params[param]	= paramType.default;
		}

		if (isNaN(paramType.size(obj.params[param]))) {
			const	err	= new Error('Invalid param value "' + obj.params[param] + '" for param "' + param + '" and command "' + obj.cmdName + '". Is it of the right type?');
			log.error(logPrefix + err.message);
			return cb(err);
		}

		cmdLength += paramType.size(obj.params[param]);
	}

	// TLV params - optional parameters
	for (const tlvName in obj.tlvs) {
		const	tlvValue	= obj.tlvs[tlvName].tagValue;

		let	tlvDef	= defs.tlvsById[obj.tlvs[tlvName].tagId];

		if (tlvDef === undefined) {
			tlvDef = defs.tlvs.default;
		}

		try {
			cmdLength += tlvDef.type.size(tlvValue) + 4;
		} catch (err) {
			const	manErr	= new Error('Could not get size of TLV parameter "' + tlvName + '" with value "' + tlvValue + '", err: ' + err.message);
			log.error(logPrefix + manErr.message);
			return cb(manErr);
		}
	}

	cb(null, cmdLength);
}

/**
 * Write PDU to buffer
 *
 * @param {object} obj - the PDU object to be written to buffer
 * @param {number} cmdLength - The length of the pdu buffer
 * @param {function} cb - cb(err, buff)
 */
function writeBuffer(obj, cmdLength, cb) {
	const	logPrefix	= topLogPrefix + 'writeBuffer() - ';

	let	offset	= 16, // Start the offset on the body
		buff;

	if (isNaN(cmdLength)) {
		const	err	= new Error('cmdLength is NaN');
		log.error(logPrefix + err.message);
		return cb(err);
	}

	if (cmdLength < 16) {
		const	err	= new Error('cmdLength is less than 16 (' + cmdLength + ')');
		log.error(logPrefix + err.message);
		return cb(err);
	}

	buff = new Buffer(cmdLength);

	// Write PDU header
	try {
		buff.writeUInt32BE(cmdLength, 0);	// Command length for the first 4 octets
		buff.writeUInt32BE(defs.cmds[obj.cmdName].id, 4);	// Command id for the second 4 octets
		buff.writeUInt32BE(defs.errors[obj.cmdStatus], 8);	// Command status for the third 4 octets
		buff.writeUInt32BE(obj.seqNr, 12);	// Sequence number as the fourth 4 octets
	} catch (err) {
		const	manErr = new Error('Could not write PDU header, catched err: ' + err.message, obj);
		log.error(logPrefix + manErr.message);
		return cb(manErr);
	}

	// Cycle through the defs list to make sure the params are in the right order
	for (const param in defs.cmds[obj.cmdName].params) {
		const	paramType	= defs.cmds[obj.cmdName].params[param].type,
			paramSize	= paramType.size(obj.params[param]);

		if (Buffer.isBuffer(obj.params[param])) {
			log.silly(logPrefix + 'Writing param "' + param + '" with content "' + obj.params[param].toString('hex') + '" and size "' + paramSize + '"');
		} else {
			if (param === 'sm_length') {
				log.silly(logPrefix + 'sm_length is calculated by short_message: "' + obj.params.short_message.toString('hex') + '"');
			}

			log.silly(logPrefix + 'Writing param "' + param + '" with content "' + obj.params[param] + '"');
		}

		// Write parameter value to buffer using the types method write()
		paramType.write(obj.params[param], buff, offset);

		// Increase the offset for the next param
		offset += paramSize;
	}

	// Cycle through the tlvs
	for (const tlvName in obj.tlvs) {
		const	tlvValue	= obj.tlvs[tlvName].tagValue,
			tlvId	= obj.tlvs[tlvName].tagId;

		let	tlvDef	= defs.tlvsById[tlvId],
			tlvSize;

		if (tlvDef === undefined) {
			tlvDef = defs.tlvs.default;
		}

		tlvSize	= tlvDef.type.size(tlvValue);

		log.silly(logPrefix + 'Writing TLV "' + tlvName + '" offset: ' + offset + ' value: "' + tlvValue + '"');

		buff.writeUInt16BE(tlvId, offset);
		buff.writeUInt16BE(tlvSize, offset + 2);
		tlvDef.type.write(tlvValue, buff, offset + 4);

		offset += tlvDef.type.size(tlvValue) + 4;
	}

	log.silly(logPrefix + 'Complete PDU: "' + buff.toString('hex') + '"');

	cb(null, buff);
}

/**
 * Decode a short_message
 *
 * @param {buffer} buffer
 * @param {string} encoding 'ASCII', 'LATIN1' or 'UCS2' or hex values
 * @param {number} offset - defaults to 0
 * @return {string} in utf8 format
 */
function decodeMsg(buffer, encoding, offset) {
	const	logPrefix	= topLogPrefix + 'decodeMsg() - ';

	if (offset === undefined) {
		offset = 0;
	}

	for (const checkEnc in defs.consts.ENCODING) {
		if (parseInt(encoding) === defs.consts.ENCODING[checkEnc] || encoding === checkEnc) {
			encoding = checkEnc;
		}
	}

	if (defs.encodings[encoding] === undefined) {
		log.info(logPrefix + 'Invalid encoding "' + encoding + '" given. Falling back to ASCII (0x01).');
		encoding = 'ASCII';
	}

	log.debug(logPrefix + 'Decoding msg. Encoding: "' + encoding + '" offset: "' + offset + '" buffer: "' + buffer.toString('hex') + '"');

	return defs.encodings[encoding].decode(buffer.slice(offset));
}

function encodeMsg(str) {
	const	encoding	= defs.encodings.detect(str);

	return defs.encodings[encoding].encode(str);
}

/**
 * Transforms a PDU to an object
 *
 * @param {buffer} pdu
 * @param {boolean} stupidNullByte - Define if the short_message should be followed by a stupid NULL byte - will be auto resolved if left undefined
 * @param {function} cb - cb(err, obj)
 */
function pduToObj(pdu, stupidNullByte, cb) {
	const	logPrefix	= topLogPrefix + 'pduToObj() - ',
		retObj	= {'params': {}, 'tlvs': {}};

	let	offset	= 16,	// 0-15 is the header, so the body starts at 16
		command;

	if (typeof stupidNullByte === 'function') {
		cb	= stupidNullByte;
		stupidNullByte	= undefined;
	}

	// Returns true if this PDU is a response to another PDU
	retObj.isResp = function () {
		return ! ! (this.cmdId & 0x80000000);
	};

	log.silly(logPrefix + 'Decoding PDU to Obj. PDU buff in hex: ' + pdu.toString('hex'));

	if (pdu.length < 16) {
		const	err	= new Error('PDU is to small, minimum size is 16, given size is ' + pdu.length);
		log.warn(logPrefix + '' + err.message);
		return cb(err);
	}

	// Read the PDU Header
	retObj.cmdLength	= parseInt(pdu.readUInt32BE(0));
	retObj.cmdId	= parseInt(pdu.readUInt32BE(4));
	retObj.cmdStatus	= defs.errorsById[parseInt(pdu.readUInt32BE(8))];
	retObj.seqNr	= parseInt(pdu.readUInt32BE(12));

	// Lookup the command id in the definitions
	if (defs.cmdsById[retObj.cmdId] === undefined) {
		const	err	= new Error('Unknown PDU command id: ' + retObj.cmdId + ' PDU buff in hex: ' + pdu.toString('hex'));
		log.warn(logPrefix + '' + err.message);
		return cb(err);
	}

	if (isNaN(retObj.seqNr)) {
		const	err	= new Error('Invalid seqNr, is not an interger: "' + retObj.seqNr + '"');
		log.warn(logPrefix + '' + err.message);
		return cb(err);
	}

	if (retObj.seqNr > 2147483646) {
		const	err	= new Error('Invalid seqNr, maximum size of 2147483646 (0x7fffffff) exceeded.');
		log.warn(logPrefix + '' + err.message);
		return cb(err);
	}

	command	= defs.cmdsById[retObj.cmdId];
	retObj.cmdName	= command.command;

	// Get all parameters from the body that should exists with this command
	for (const param in command.params) {

		// Get the parameter value by using the definition type read() function
		try {
			let	paramSize;

			retObj.params[param]	= command.params[param].type.read(pdu, offset, retObj.params.sm_length);
			paramSize	= command.params[param].type.size(retObj.params[param]);

			log.silly(logPrefix + 'Reading param "' + param + '" at offset ' + offset + ' with calculated size: ' + paramSize + ' content in hex: ' + pdu.slice(offset, offset + paramSize).toString('hex'));
			if (param === 'short_message') {
				// Check if we have a trailing NULL octet after the short_message. Some idiot thought that would be a good idea
				// in some implementations, so we need to account for that.
				if (stupidNullByte === true) {
					log.silly(logPrefix + 'stupidNullByte is set, so short_message is followed by a NULL octet, increase paramSize one extra to account for that');
					paramSize ++;
				}
			}

			// Increase the offset by the current params length
			offset += paramSize;
		} catch (err) {
			const	manErr	= new Error('Failed to read param "' + param + '", err: ' + err.message);
			log.error(logPrefix + '' + manErr.message);
			return cb(err);
		}
	}

	// If the length is greater than the current offset, there must be TLVs - resolve them!
	// The minimal size for a TLV is its head, 4 octets
	while ((offset + 4) < retObj.cmdLength) {
		let	tlvLength,
			tlvCmdId,
			tlvValue;

		try {
			tlvCmdId	= pdu.readInt16BE(offset);
			tlvLength	= pdu.readInt16BE(offset + 2);
		} catch (err) {
			const	manErr	= new Error('Unable to read TLV at offset "' + offset + '", given cmdLength: "' + retObj.cmdLength + '" pdu: ' + pdu.toString('hex') + ', err: ' + err.message);
			log.error(logPrefix + '' + manErr.message);
			return cb(manErr);
		}

		if (defs.tlvsById[tlvCmdId] === undefined) {
			tlvValue = pdu.slice(offset + 4, offset + 4 + tlvLength).toString('hex');

			retObj.tlvs[tlvCmdId] = {
				'tagId': tlvCmdId,
				'tagName': undefined,
				'tagValue': tlvValue
			};

			log.verbose(logPrefix + 'Unknown TLV found. Hex ID: ' + tlvCmdId.toString(16) + ' length: ' + tlvLength + ' hex value: ' + tlvValue);
		} else {
			tlvValue = defs.tlvsById[tlvCmdId].type.read(pdu, offset + 4, tlvLength);

			if (Buffer.isBuffer(tlvValue)) {
				tlvValue = tlvValue.toString('hex');
			}

			retObj.tlvs[defs.tlvsById[tlvCmdId].tag] = {
				'tagId':	tlvCmdId,
				'tagName':	defs.tlvsById[tlvCmdId].tag,
				'tagValue':	tlvValue
			};

			log.silly(logPrefix + 'TLV found: "' + defs.tlvsById[tlvCmdId].tag + '" ID: "' + tlvCmdId + '" value: "' + tlvValue + '"');
		}

		offset = offset + 4 + tlvLength;
	}

	if (offset !== retObj.cmdLength && stupidNullByte === undefined) {
		log.verbose(logPrefix + 'Offset (' + offset + ') !== cmdLength (' + retObj.cmdLength + ') for seqNr: ' + retObj.seqNr + ' - retry with the stupid NULL byte for short_message');

		return pduToObj(pdu, true, cb);
	}

	if (offset !== retObj.cmdLength) {
		log.warn(logPrefix + 'Offset (' + offset + ') !== cmdLength (' + retObj.cmdLength + ') for seqNr: ' + retObj.seqNr);
	}

	// Decode the short message if it is set and esm_class is 0
	// The esm_class 0x40 (64 int) means the short_message have a UDH
	// Thats why we return the short_message as a buffer
	if (retObj.params.short_message !== undefined && (retObj.params.esm_class & 0x40) !== 0x40) {
		retObj.params.short_message	= decodeMsg(retObj.params.short_message, retObj.params.data_coding);
	}

	log.debug(logPrefix + 'Complete decoded PDU: ' + JSON.stringify(retObj));

	cb(null, retObj);
}

/**
 * Transform an object to a PDU
 *
 * @param {object} obj - example {'cmdName': 'bind_transceiver_resp', 'cmdStatus': 'ESME_ROK', 'seqNr': 2} - to add parameters add a key 'params' as object
 * @param {function} cb - cb(err, pdu)
 */
function objToPdu(obj, cb) {
	const	logPrefix	= topLogPrefix + 'objToPdu() - ',
		seqNr	= parseInt(obj.seqNr);

	// Check so the command is ok
	if (defs.cmds[obj.cmdName] === undefined) {
		const	err	= new Error('Invalid cmdName: "' + obj.cmdName + '"');
		log.warn(logPrefix + err.message);
		return cb(err);
	}

	// Check so the command status is ok
	if (obj.cmdStatus === undefined) {
		obj.cmdStatus	= 'ESME_ROK';	// Default to OK
	}

	if (defs.errors[obj.cmdStatus] === undefined) {
		const	err	= new Error('Invalid cmdStatus: "' + obj.cmdStatus + '"');
		log.warn(logPrefix + err.message);
		return cb(err);
	}

	// Check so seqNr is ok
	if (isNaN(seqNr)) {
		const	err	= new Error('Invalid seqNr, is not an interger: "' + obj.seqNr + '"');
		log.warn(logPrefix + err.message);
		return cb(err);
	}

	if (seqNr > 2147483646) {
		const	err	= new Error('Invalid seqNr, maximum size of 2147483646 (0x7fffffff) exceeded.');
		log.warn(logPrefix + err.message);
		return cb(err);
	}

	// Params must be an object
	if (obj.params === undefined) {
		obj.params	= {};
	}

	// If param "short_message" exists, encode it and set parameter "data_coding" accordingly
	if (obj.params.short_message !== undefined && ! Buffer.isBuffer(obj.params.short_message)) {
		let	shortMsg;

		// Detect encoding if is not set already
		if (obj.params.data_coding === undefined) {
			obj.params.data_coding = defs.encodings.detect(obj.params.short_message);

			log.silly(logPrefix + 'data_coding "' + obj.params.data_coding + '" detected');

			// Now set the hex value
			obj.params.data_coding	= defs.consts.ENCODING[obj.params.data_coding];
		}

		// Acutally encode the string
		shortMsg	= obj.params.short_message;
		obj.params.short_message	= encodeMsg(obj.params.short_message);
		obj.params.sm_length	= obj.params.short_message.length;
		log.silly(logPrefix + 'Encoding message "' + shortMsg + '" to "' + obj.params.short_message.toString('hex') + '"');
	}

	log.debug(logPrefix + 'Complete object to encode: ' + JSON.stringify(obj));

	calcCmdLength(obj, function (err, cmdLength) {
		if (err) return cb(err);

		writeBuffer(obj, cmdLength, cb);
	});
}

/**
 * Create a PDU as a return to another PDU
 *
 * @param {object|buffer} pdu
 * @param {string} status - see list at defs.errors - defaults to 'ESME_ROK' - no error (OPTIONAL)
 * @param {object} [params]
 * @param {object} [tlvs]
 * @param {function} [cb(err, pduBuffer)]
 */
function pduReturn(pdu, status, params, tlvs, cb) {
	const	logPrefix	= topLogPrefix + 'pduReturn() - ',
		retPdu = {};

	let	err	= null;

	if (Buffer.isBuffer(pdu)) {
		log.silly(logPrefix + 'Ran with pdu as buffer, run pduToObj() and retry');

		pduToObj(pdu, function (err, pduObj) {
			if (err) return cb(err);

			pduReturn(pduObj, status, params, tlvs, cb);
		});
		return;
	}

	log.silly(logPrefix + 'ran');

	if (typeof tlvs === 'function') {
		cb	= tlvs;
		tlvs	= undefined;
	}

	if (typeof params === 'function') {
		cb	= params;
		params	= {};
		tlvs	= undefined;
	}

	if (typeof status === 'function') {
		cb	= status;
		status	= 'ESME_ROK';
		params	= {};
		tlvs	= undefined;
	}

	if (status === undefined) {
		status	= 'ESME_ROK';
	}

	if (cb === undefined) {
		cb	= function () {};
	}

	if (params === undefined) {
		params	= {};
	}

	if (pdu	=== undefined)		err = new Error('PDU is undefined, cannot create response PDU');
	if (pdu.cmdName	=== undefined)		err = new Error('pdu.cmdName is undefined, cannot create response PDU');
	if (pdu.seqNr	=== undefined)		err = new Error('pdu.seqNr is undefined, cannot create response PDU');
	if (err	=== null && defs.errors[status]	=== undefined)	err = new Error('Invalid status: "' + status + '"');
	if (err	=== null && defs.cmds[pdu.cmdName + '_resp']	=== undefined)	err = new Error('This command does not have a response listed. Given command: "' + pdu.cmdName + '"');

	if (err !== null) {
		log.warn(logPrefix + err.message);
		return cb(err);
	}

	retPdu.cmdName	= pdu.cmdName + '_resp';
	retPdu.cmdStatus	= status;
	retPdu.seqNr	= pdu.seqNr;
	retPdu.params	= params;
	retPdu.tlvs	= tlvs;

	// Populate parameters that should exist in the response
	for (const param in defs.cmds[pdu.cmdName + '_resp'].params) {

		// Do not override the manually supplied parameters
		if (retPdu.params[param] === undefined) {
			retPdu.params[param] = pdu.params[param];
		}
	}

	objToPdu(retPdu, cb);
}

/**
 * Format a js date object as ugly SMPP date format
 *
 * @param {object} jsDateObj
 * @return {string}
 */
function smppDate(jsDateObj) {
	let	uglyStr	= '';

	uglyStr += jsDateObj.getFullYear().toString().substring(2);

	if (jsDateObj.getMonth() < 10) {
		uglyStr += '0';
	}

	uglyStr += jsDateObj.getMonth();

	if (jsDateObj.getDate() < 10) {
		uglyStr += '0';
	}

	uglyStr += jsDateObj.getDate();

	if (jsDateObj.getHours() < 10) {
		uglyStr += '0';
	}

	uglyStr += jsDateObj.getHours();

	if (jsDateObj.getMinutes() < 10) {
		uglyStr += '0';
	}

	uglyStr += jsDateObj.getMinutes();

	return uglyStr;
}

/**
 * Calculate bitCount of short_message
 *
 * @param {string} msg
 * @param {string} encoding - Force encoding ASCII or UCS2 (OPTIONAL)
 * @return integer
 */
function bitCount(msg, encoding) {
	if (defs.encodings[encoding] === undefined) {
		encoding = defs.encodings.detect(msg);
	}

	if (encoding === 'ASCII') {
		return defs.encodings.ASCII.encode(msg).length * 7; // * 7 since each character takes up 7 bits
	} else {
		return defs.encodings.UCS2.encode(msg).length * 8; // * 8 since its encoded as 16-bits.
	}
}

/**
 * Split a message into multiple messages
 *
 * @param {string} msg
 * @param {string} encoding - Force encoding ASCII or UCS2 (OPTIONAL)
 * @return array of buffers
 */
function splitMsg(msg, encoding) {
	const	resolvedEncoding	= encoding || defs.encodings.detect(msg),
		totBitCount	= bitCount(msg, resolvedEncoding),
		logPrefix	= topLogPrefix + 'splitMsg() - ',
		msgs	= [];

	let	msgPart     = '',
		partCharLimit,
		i2;

	// A single message could contain up to 1120 bits
	// Return directly if the message fits into that
	if (totBitCount < 1121) {
		log.silly(logPrefix + 'bitCount below 1121 (' + totBitCount + ') return only one part');
		return [defs.encodings[resolvedEncoding].encode(msg)];
	}

	bundleMsgId ++; // This will identify this message "bundle"

	if (bundleMsgId === 256) {
		bundleMsgId = 1;
	}

	log.silly(logPrefix + 'bundleMsgId set to ' + bundleMsgId);

	if (resolvedEncoding === 'ASCII') {
		partCharLimit = 153;
	} else {
		partCharLimit = 67;
	}

	i2	= 0;
	for (let i = 0; msg[i] !== undefined; i ++) {
		msgPart += msg[i];

		i2 ++;

		if (i2 === partCharLimit) {
			// We've reached the message limit

			// Reset the local counter
			i2 = 0;

			// Add this msgPart minus the last character to the msgs array as an encoded buffer
			msgs.push(defs.encodings[resolvedEncoding].encode(msgPart.slice(0, - 1)));

			// Reset msgPart
			msgPart = '';

			// Put i back one to account for the last character we removed from the msgPart
			i --;
		}
	}

	// Add the last msgPart to the msgs array
	msgs.push(defs.encodings[resolvedEncoding].encode(msgPart));

	// Add the UDH (http://en.wikipedia.org/wiki/Concatenated_SMS)
	for (let i = 0; msgs[i] !== undefined; i ++) {
		// Create the UDH buffer
		const udh = new Buffer([
			0x05,	// Length of User Data Header, in this case 05.
			0x00,	// Information Element Identifier, equal to 00 (Concatenated short messages, 8-bit reference number)
			0x03,	// Length of the header, excluding the first two fields; equal to 03
			bundleMsgId,	// CSMS reference number, must be same for all the SMS parts in the CSMS
			msgs.length,	// Total number of parts. The value shall remain constant for every short message which makes up the concatenated short message. If the value is zero then the receiving entity shall ignore the whole information element
			i + 1	// This part's number in the sequence. The value shall start at 1 and increment for every short message which makes up the concatenated short message.
		]);

		msgs[i]	= Buffer.concat([udh, msgs[i]]);
	}

	return msgs;
}

/**
 * Send a dlr to an sms
 * This must be called from an sms object context
 *
 * @param {string} status - see list at defs.consts.MESSAGE_STATE - defaults to 'DELIVERED'
 * @param {function} cb - cb(err, retPdu, dlrPduObj)
 */
function smsDlr(status, cb) {
	const	logPrefix	= topLogPrefix + 'smsDlr() - ',
		dlrPduObj	= {},
		sms	= this;

	let	shortMessage	= 'id:' + sms.smsId + ' sub:001 ';

	if (typeof status === 'function') {
		cb	= status;
		status	= undefined;
	}

	if (status === undefined || status === true || status === 2 || status === 'true') {
		status	= 2;
	} else if (defs.consts.MESSAGE_STATE[status] !== undefined) {
		status	= defs.consts.MESSAGE_STATE[status];
	} else if (defs.constsById.MESSAGE_STATE[status]) {
		status	= parseInt(status);
	} else {
		status	= 5; // UNDELIVERABLE
	}

	if (typeof cb !== 'function') {
		cb = function () {};
	}

	if (sms.smsId === undefined) {
		const	err	= new Error('Trying to send DLR with no smsId.');
		log.warn(logPrefix + err.message);
		return cb(err);
	}

	if (status === 2) {
		shortMessage	+= 'dlvrd:1 ';
	} else {
		shortMessage	+= 'dlvrd:0 ';
	}

	shortMessage	+= 'submit date:' + smppDate(sms.submitTime);
	shortMessage	+= ' done date:' + smppDate(new Date());

	if (status === 2) {
		shortMessage	+= ' stat:DELIVRD err:0 text:xxx';
	} else {
		shortMessage	+= ' stat:UNDELIVERABLE err:1 text:xxx';
	}

	log.verbose(logPrefix	+ 'Sending DLR message: "' + shortMessage + '"');

	dlrPduObj.cmdName	= 'deliver_sm';
	dlrPduObj.params = {
		'source_addr':	sms.from,
		'destination_addr':	sms.to,
		'esm_class':	4,
		'short_message':	shortMessage
	};
	dlrPduObj.tlvs = {
		'receipted_message_id': {
			'tagId':	0x001E,
			'tagName':	'receipted_message_id',
			'tagValue':	sms.smsId
		},
		'message_state': {
			'tagId':	0x0427,
			'tagName':	'message_state',
			'tagValue':	status
		}
	};

	sms.session.send(dlrPduObj, false, function (err, retPdu) {
		cb(err, retPdu, dlrPduObj);
	});
}

// Expose some functions
exports.decodeMsg = decodeMsg;
exports.encodeMsg = encodeMsg;
exports.pduToObj  = pduToObj;
exports.objToPdu  = objToPdu;
exports.pduReturn = pduReturn;
exports.smppDate  = smppDate;
exports.bitCount  = bitCount;
exports.splitMsg  = splitMsg;
exports.smsDlr    = smsDlr;
