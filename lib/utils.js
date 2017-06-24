'use strict';

var log         = require('winston'),
    defs        = require('./defs'),
    bundleMsgId = 0;

/**
 * Calculate cmdLength from object
 *
 * @param {object} obj
 * @param {function} callback(err, cmdLength)
 */
function calcCmdLength(obj, callback) {
	var cmdLength = 16, // All commands are at least 16 octets long
	    err,
	    param,
	    paramType,
	    tlvValue,
	    tlvName,
	    tlvDef;

	// Handle params - All command params should always exists, even if they do not contain data.
	for (param in defs.cmds[obj.cmdName].params) {

		// Get the parameter type, int, string, cstring etc.
		// This is needed so we can calculate length etc
		paramType = defs.cmds[obj.cmdName].params[param].type;

		if (obj.params[param] === undefined) {
			obj.params[param] = paramType.default;
		}

		if (isNaN(paramType.size(obj.params[param]))) {
			err = new Error('Invalid param value "' + obj.params[param] + '" for param "' + param + '" and command "' + obj.cmdName + '". Is it of the right type?');
			log.error('larvitsmpp: lib/utils.js: calcCmdLength() - ' + err.message);
			callback(err);
			return;
		}

		cmdLength += paramType.size(obj.params[param]);
	}

	// TLV params - optional parameters
	for (tlvName in obj.tlvs) {
		tlvValue = obj.tlvs[tlvName].tagValue;
		tlvDef   = defs.tlvsById[obj.tlvs[tlvName].tagId];

		if (tlvDef === undefined) {
			tlvDef = defs.tlvs.default;
		}

		try {
			cmdLength += tlvDef.type.size(tlvValue) + 4;
		} catch(e) {
			err = new Error('Could not get size of TLV parameter "' + tlvName + '" with value "' + tlvValue + '"');
			log.error('larvitsmpp: lib/utils.js: calcCmdLength() - ' + err.message);
			callback(err);
			return;
		}
	}

	callback(null, cmdLength);
}

/**
 * Write PDU to buffer
 *
 * @param {object} obj - the PDU object to be written to buffer
 * @param {number} cmdLength - The length of the pdu buffer
 * @param {function} callback(err, buff)
 */
function writeBuffer(obj, cmdLength, callback) {
	var offset = 16, // Start the offset on the body
	    buff,
	    param,
	    paramType,
	    paramSize,
	    tlvId,
	    tlvName,
	    tlvValue,
	    tlvDef,
	    tlvSize,
	    err;

	if (isNaN(cmdLength) || cmdLength < 16) {
		if (isNaN(cmdLength)) {
			err = new Error('cmdLength is NaN');
		}

		if (cmdLength < 16) {
			err = new Error('cmdLength is less than 16 (' + cmdLength + ')');
		}

		log.error('larvitsmpp: lib/utils.js: objToPdu() - writeBuffer() - ' + err.message);
		callback(err);
		return;
	}

	buff = new Buffer(cmdLength);

	// Write PDU header
	try {
		buff.writeUInt32BE(cmdLength, 0);                  // Command length for the first 4 octets
		buff.writeUInt32BE(defs.cmds[obj.cmdName].id, 4);  // Command id for the second 4 octets
		buff.writeUInt32BE(defs.errors[obj.cmdStatus], 8); // Command status for the third 4 octets
		buff.writeUInt32BE(obj.seqNr, 12);                 // Sequence number as the fourth 4 octets
	} catch (e) {
		err = new Error('Could not write PDU header, catched err: ' + e.message, obj);
		log.error('larvitsmpp: lib/utils.js: writeBuffer() - ' + err.message);
		callback(err);
		return;
	}

	// Cycle through the defs list to make sure the params are in the right order
	for (param in defs.cmds[obj.cmdName].params) {
		paramType = defs.cmds[obj.cmdName].params[param].type;
		paramSize = paramType.size(obj.params[param]);

		if (Buffer.isBuffer(obj.params[param])) {
			log.silly('larvitsmpp: lib/utils.js: writeBuffer() - Writing param "' + param + '" with content "' + obj.params[param].toString('hex') + '" and size "' + paramSize + '"');
		} else {
			if (param === 'sm_length') {
				log.silly('larvitsmpp: lib/utils.js: writeBuffer() - sm_length is calculated by short_message: "' + obj.params.short_message.toString('hex') + '"');
			}

			log.silly('larvitsmpp: lib/utils.js: writeBuffer() - Writing param "' + param + '" with content "' + obj.params[param] + '"');
		}

		// Write parameter value to buffer using the types method write()
		paramType.write(obj.params[param], buff, offset);

		// Increase the offset for the next param
		offset += paramSize;
	}

	// Cycle through the tlvs
	for (tlvName in obj.tlvs) {
		tlvId    = obj.tlvs[tlvName].tagId;
		tlvValue = obj.tlvs[tlvName].tagValue;
		tlvDef   = defs.tlvsById[tlvId];

		if (tlvDef === undefined) {
			tlvDef = defs.tlvs.default;
		}

		tlvSize  = tlvDef.type.size(tlvValue);

		log.silly('larvitsmpp: lib/utils.js: writeBuffer() - Writing TLV "' + tlvName + '" offset: ' + offset + ' value: "' + tlvValue + '"');

		buff.writeUInt16BE(tlvId, offset);
		buff.writeUInt16BE(tlvSize, offset + 2);
		tlvDef.type.write(tlvValue, buff, offset + 4);

		offset += tlvDef.type.size(tlvValue) + 4;
	}

	log.silly('larvitsmpp: lib/utils.js: writeBuffer() - Complete PDU: "' + buff.toString('hex') + '"');

	callback(null, buff);
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
	var checkEnc;

	if (offset === undefined) {
		offset = 0;
	}

	for (checkEnc in defs.consts.ENCODING) {
		if (parseInt(encoding) === defs.consts.ENCODING[checkEnc] || encoding === checkEnc) {
			encoding = checkEnc;
		}
	}

	if (defs.encodings[encoding] === undefined) {
		log.info('larvitsmpp: lib/utils.js: decodeMsg() - Invalid encoding "' + encoding + '" given. Falling back to ASCII (0x01).');
		encoding = 'ASCII';
	}

	log.debug('larvitsmpp: lib/utils.js: decodeMsg() - Decoding msg. Encoding: "' + encoding + '" offset: "' + offset + '" buffer: "' + buffer.toString('hex') + '"');

	return defs.encodings[encoding].decode(buffer.slice(offset));
}

function encodeMsg(str) {
	var encoding = defs.encodings.detect(str);

	return defs.encodings[encoding].encode(str);
}

/**
 * Transforms a PDU to an object
 *
 * @param {buffer} pdu
 * @param {boolean} stupidNullByte - Define if the short_message should be followed by a stupid NULL byte - will be auto resolved if left undefined
 * @param {function} callback(err, obj)
 */
function pduToObj(pdu, stupidNullByte, callback) {
	var retObj = {'params': {}, 'tlvs': {}},
	    err    = null,
	    offset,
	    command,
	    param,
	    tlvCmdId,
	    tlvLength,
	    tlvValue,
	    paramSize;

	if (typeof stupidNullByte === 'function') {
		callback       = stupidNullByte;
		stupidNullByte = undefined;
	}

	// Returns true if this PDU is a response to another PDU
	retObj.isResp = function() {
		return ! ! (this.cmdId & 0x80000000);
	};

	log.silly('larvitsmpp: lib/utils.js: pduToObj() - Decoding PDU to Obj. PDU buff in hex: ' + pdu.toString('hex'));

	if (pdu.length < 16) {
		err = new Error('PDU is to small, minimum size is 16, given size is ' + pdu.length);
		log.warn('larvitsmpp: lib/utils.js: pduToObj() - ' + err.message);

		callback(err);
		return;
	}

	// Read the PDU Header
	retObj.cmdLength = parseInt(pdu.readUInt32BE(0));
	retObj.cmdId     = parseInt(pdu.readUInt32BE(4));
	retObj.cmdStatus = defs.errorsById[parseInt(pdu.readUInt32BE(8))];
	retObj.seqNr     = parseInt(pdu.readUInt32BE(12));

	// Lookup the command id in the definitions
	if (defs.cmdsById[retObj.cmdId] === undefined) {
		err = new Error('Unknown PDU command id: ' + retObj.cmdId + ' PDU buff in hex: ' + pdu.toString('hex'));
	}

	if (isNaN(retObj.seqNr)) {
		err = new Error('Invalid seqNr, is not an interger: "' + retObj.seqNr + '"');
	} else if (retObj.seqNr > 2147483646) {
		err = new Error('Invalid seqNr, maximum size of 2147483646 (0x7fffffff) exceeded.');
	}

	// If error is found, do not proceed with execution
	if (err !== null) {
		log.warn('larvitsmpp: lib/utils.js: pduToObj() - ' + err.message);
		callback(err);
		return;
	}

	command        = defs.cmdsById[retObj.cmdId];
	retObj.cmdName = command.command;

	// Get all parameters from the body that should exists with this command
	offset = 16; // 0-15 is the header, so the body starts at 16
	for (param in command.params) {

		// Get the parameter value by using the definition type read() function
		try {
			retObj.params[param] = command.params[param].type.read(pdu, offset, retObj.params.sm_length);
			paramSize            = command.params[param].type.size(retObj.params[param]);

			log.silly('larvitsmpp: lib/utils.js: pduToObj() - Reading param "' + param + '" at offset ' + offset + ' with calculated size: ' + paramSize + ' content in hex: ' + pdu.slice(offset, offset + paramSize).toString('hex'));
			if (param === 'short_message') {
				// Check if we have a trailing NULL octet after the short_message. Some idiot thought that would be a good idea
				// in some implementations, so we need to account for that.
				if (stupidNullByte === true) {
					log.silly('larvitsmpp: lib/utils.js: pduToObj() - stupidNullByte is set, so short_message is followed by a NULL octet, increase paramSize one extra to account for that');
					paramSize ++;
				}
			}

			// Increase the offset by the current params length
			offset += paramSize;
		} catch (e) {
			err = new Error('Failed to read param "' + param + '": ' + e.message);
			log.error('larvitsmpp: lib/utils.js: pduToObj() - ' + err.message);
			callback(err);

			return;
		}
	}

	// If the length is greater than the current offset, there must be TLVs - resolve them!
	// The minimal size for a TLV is its head, 4 octets
	while ((offset + 4) < retObj.cmdLength) {
		try {
			tlvCmdId  = pdu.readInt16BE(offset);
			tlvLength = pdu.readInt16BE(offset + 2);
		} catch (e) {
			err = new Error('Unable to read TLV at offset "' + offset + '", given cmdLength: "' + retObj.cmdLength + '" pdu: ' + pdu.toString('hex'));
			log.error('larvitsmpp: lib/utils.js: pduToObj() - ' + err.message);
			callback(err);
			return;
		}

		if (defs.tlvsById[tlvCmdId] === undefined) {
			tlvValue = pdu.slice(offset + 4, offset + 4 + tlvLength).toString('hex');

			retObj.tlvs[tlvCmdId] = {
				'tagId': tlvCmdId,
				'tagName': undefined,
				'tagValue': tlvValue
			};

			log.verbose('larvitsmpp: lib/utils.js: pduToObj() - Unknown TLV found. Hex ID: ' + tlvCmdId.toString(16) + ' length: ' + tlvLength + ' hex value: ' + tlvValue);
		} else {
			tlvValue = defs.tlvsById[tlvCmdId].type.read(pdu, offset + 4, tlvLength);

			if (Buffer.isBuffer(tlvValue)) {
				tlvValue = tlvValue.toString('hex');
			}

			retObj.tlvs[defs.tlvsById[tlvCmdId].tag] = {
				'tagId': tlvCmdId,
				'tagName': defs.tlvsById[tlvCmdId].tag,
				'tagValue': tlvValue
			};

			log.silly('larvitsmpp: lib/utils.js: pduToObj() - TLV found: "' + defs.tlvsById[tlvCmdId].tag + '" ID: "' + tlvCmdId + '" value: "' + tlvValue + '"');
		}

		offset = offset + 4 + tlvLength;
	}

	if (offset !== retObj.cmdLength && stupidNullByte === undefined) {
		log.verbose('larvitsmpp: lib/utils.js: pduToObj() - Offset (' + offset + ') !== cmdLength (' + retObj.cmdLength + ') for seqNr: ' + retObj.seqNr + ' - retry with the stupid NULL byte for short_message');

		pduToObj(pdu, true, callback);
		return;
	}

	if (offset !== retObj.cmdLength) {
		log.warn('larvitsmpp: lib/utils.js: pduToObj() - Offset (' + offset + ') !== cmdLength (' + retObj.cmdLength + ') for seqNr: ' + retObj.seqNr);
	}

	// Decode the short message if it is set and esm_class is 0
	// The esm_class 0x40 (64 int) means the short_message have a UDH
	// Thats why we return the short_message as a buffer
	if (retObj.params.short_message !== undefined && (retObj.params.esm_class & 0x40) !== 0x40) {
		retObj.params.short_message = decodeMsg(retObj.params.short_message, retObj.params.data_coding);
	}

	log.debug('larvitsmpp: lib/utils.js: pduToObj() - Complete decoded PDU: ' + JSON.stringify(retObj));

	callback(null, retObj);
}

/**
 * Transform an object to a PDU
 *
 * @param {object} obj - example {'cmdName': 'bind_transceiver_resp', 'cmdStatus': 'ESME_ROK', 'seqNr': 2} - to add parameters add a key 'params' as object
 * @param {function} callback(err, pdu)
 */
function objToPdu(obj, callback) {
	var err = null,
	    shortMsg,
	    seqNr;

	// Check so the command is ok
	if (defs.cmds[obj.cmdName] === undefined) {
		err = new Error('larvitsmpp: lib/utils.js: objToPdu() - Invalid cmdName: "' + obj.cmdName + '"');
	}

	// Check so the command status is ok
	if (obj.cmdStatus === undefined) {
		// Default to OK
		obj.cmdStatus = 'ESME_ROK';
	}

	if (defs.errors[obj.cmdStatus] === undefined) {
		err = new Error('larvitsmpp: lib/utils.js: objToPdu() - Invalid cmdStatus: "' + obj.cmdStatus + '"');
	}

	// Check so seqNr is ok
	seqNr = parseInt(obj.seqNr);
	if (isNaN(seqNr)) {
		err = new Error('larvitsmpp: lib/utils.js: objToPdu() - Invalid seqNr, is not an interger: "' + obj.seqNr + '"');
	} else if (seqNr > 2147483646) {
		err = new Error('larvitsmpp: lib/utils.js: objToPdu() - Invalid seqNr, maximum size of 2147483646 (0x7fffffff) exceeded.');
	}

	// If error is found, do not proceed with execution
	if (err !== null) {
		log.warn(err.message);
		callback(err);
		return;
	}

	// Params must be an object
	if (obj.params === undefined) {
		obj.params = {};
	}

	// If param "short_message" exists, encode it and set parameter "data_coding" accordingly
	if (obj.params.short_message !== undefined && ! Buffer.isBuffer(obj.params.short_message)) {

		// Detect encoding if is not set already
		if (obj.params.data_coding === undefined) {
			obj.params.data_coding = defs.encodings.detect(obj.params.short_message);

			log.silly('larvitsmpp: lib/utils.js: objToPdu() - data_coding "' + obj.params.data_coding + '" detected');

			// Now set the hex value
			obj.params.data_coding = defs.consts.ENCODING[obj.params.data_coding];
		}

		// Acutally encode the string
		shortMsg                 = obj.params.short_message;
		obj.params.short_message = encodeMsg(obj.params.short_message);

		obj.params.sm_length     = obj.params.short_message.length;
		log.silly('larvitsmpp: lib/utils.js: objToPdu() - encoding message "' + shortMsg + '" to "' + obj.params.short_message.toString('hex') + '"');
	}

	log.debug('larvitsmpp: lib/utils.js: objToPdu() - Complete object to encode: ' + JSON.stringify(obj));

	calcCmdLength(obj, function(err, cmdLength) {
		if (err) {
			callback(err);
			return;
		}

		writeBuffer(obj, cmdLength, callback);
	});
}

/**
 * Create a PDU as a return to another PDU
 *
 * @param {object|buffer} pdu
 * @param {string} status - see list at defs.errors - defaults to 'ESME_ROK' - no error (OPTIONAL)
 * @param {object} [params]
 * @param {object} [tlvs]
 * @param {function} [callback(err, pduBuffer)]
 */
function pduReturn(pdu, status, params, tlvs, callback) {
	var err    = null,
	    retPdu = {},
	    param;

	if (Buffer.isBuffer(pdu)) {
		log.silly('larvitsmpp: lib/utils.js: pduReturn() - ran with pdu as buffer, run pduToObj() and retry');

		pduToObj(pdu, function(err, pduObj) {
			if (err) {
				callback(err);
				return;
			}

			pduReturn(pduObj, status, params, tlvs, callback);
		});
		return;
	}

	log.silly('larvitsmpp: lib/utils.js: pduReturn() - ran');

	if (typeof tlvs === 'function') {
		callback = tlvs;
		tlvs     = undefined;
	}

	if (typeof params === 'function') {
		callback = params;
		params   = {};
		tlvs     = undefined;
	}

	if (typeof status === 'function') {
		callback = status;
		status   = 'ESME_ROK';
		params   = {};
		tlvs     = undefined;
	}

	if (status === undefined) {
		status = 'ESME_ROK';
	}

	if (callback === undefined) {
		callback = function() {};
	}

	if (params === undefined) {
		params = {};
	}

	if (pdu === undefined) {
		err = new Error('larvitsmpp: lib/utils.js: pduReturn() - PDU is undefined, cannot create response PDU');
	}

	if (pdu.cmdName === undefined) {
		err = new Error('larvitsmpp: lib/utils.js: pduReturn() - pdu.cmdName is undefined, cannot create response PDU');
	}

	if (pdu.seqNr === undefined) {
		err = new Error('larvitsmpp: lib/utils.js: pduReturn() - pdu.seqNr is undefined, cannot create response PDU');
	}

	if (err === null && defs.errors[status] === undefined) {
		err = new Error('larvitsmpp: lib/utils.js: pduReturn() - Invalid status: "' + status + '"');
	}

	if (err === null && defs.cmds[pdu.cmdName + '_resp'] === undefined) {
		err = new Error('larvitsmpp: lib/utils.js: pduReturn() - This command does not have a response listed. Given command: "' + pdu.cmdName + '"');
	}

	if (err !== null) {
		log.warn(err.message);
		callback(err);
		return;
	}

	retPdu.cmdName   = pdu.cmdName + '_resp';
	retPdu.cmdStatus = status;
	retPdu.seqNr     = pdu.seqNr;
	retPdu.params    = params;
	retPdu.tlvs      = tlvs;

	// Populate parameters that should exist in the response
	for (param in defs.cmds[pdu.cmdName + '_resp'].params) {

		// Do not override the manually supplied parameters
		if (retPdu.params[param] === undefined) {
			retPdu.params[param] = pdu.params[param];
		}
	}

	objToPdu(retPdu, function(err, retPdu) {
		callback(err, retPdu);
	});
}

/**
 * Format a js date object as ugly SMPP date format
 *
 * @param {object} jsDateObj
 * @return {string}
 */
function smppDate(jsDateObj) {
	var uglyStr = '';

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
	var msgPart     = '',
	    msgs        = [],
	    encoding    = encoding || defs.encodings.detect(msg),
	    totBitCount = bitCount(msg, encoding),
	    udh,
	    i,
	    i2,
	    partCharLimit;

	// A single message could contain up to 1120 bits
	// Return directly if the message fits into that
	if (totBitCount < 1121) {
		log.silly('larvitsmpp: lib/utils.js: splitMsg() - bitCount below 1121 (' + totBitCount + ') return only one part');
		return [defs.encodings[encoding].encode(msg)];
	}

	bundleMsgId ++; // This will identify this message "bundle"

	if (bundleMsgId === 256) {
		bundleMsgId = 1;
	}

	log.silly('larvitsmpp: lib/utils.js: splitMsg() - bundleMsgId set to ' + bundleMsgId);

	if (encoding === 'ASCII') {
		partCharLimit = 153;
	} else {
		partCharLimit = 67;
	}

	i  = 0;
	i2 = 0;
	while (msg[i] !== undefined) {
		msgPart += msg[i];

		i2 ++;

		if (i2 === partCharLimit) {
			// We've reached the message limit

			// Reset the local counter
			i2 = 0;

			// Add this msgPart minus the last character to the msgs array as an encoded buffer
			msgs.push(defs.encodings[encoding].encode(msgPart.slice(0, - 1)));

			// Reset msgPart
			msgPart = '';

			// Put i back one to account for the last character we removed from the msgPart
			i --;
		}

		i ++;
	}

	// Add the last msgPart to the msgs array
	msgs.push(defs.encodings[encoding].encode(msgPart));

	// Add the UDH (http://en.wikipedia.org/wiki/Concatenated_SMS)
	i = 0;
	while (msgs[i] !== undefined) {

		// Create the UDH buffer
		udh = new Buffer([
			0x05,        // Length of User Data Header, in this case 05.
			0x00,        // Information Element Identifier, equal to 00 (Concatenated short messages, 8-bit reference number)
			0x03,        // Length of the header, excluding the first two fields; equal to 03
			bundleMsgId, // CSMS reference number, must be same for all the SMS parts in the CSMS
			msgs.length, // Total number of parts. The value shall remain constant for every short message which makes up the concatenated short message. If the value is zero then the receiving entity shall ignore the whole information element
			i + 1        // This part's number in the sequence. The value shall start at 1 and increment for every short message which makes up the concatenated short message.
		]);

		msgs[i] = Buffer.concat([udh, msgs[i]]);

		i ++;
	}

	return msgs;
}

/**
 * Send a dlr to an sms
 * This must be called from an sms object context
 *
 * @param {string} status - see list at defs.consts.MESSAGE_STATE - defaults to 'DELIVERED'
 * @param {function} callback(err, retPdu, dlrPduObj)
 */
function smsDlr(status, callback) {
	var shortMessage,
	    dlrPduObj,
	    err,
	    sms = this;

	if (typeof status === 'function') {
		callback = status;
		status   = undefined;
	}

	if (status === undefined || status === true || status === 2 || status === 'true') {
		status = 2;
	} else if (defs.consts.MESSAGE_STATE[status] !== undefined) {
		status = defs.consts.MESSAGE_STATE[status];
	} else if (defs.constsById.MESSAGE_STATE[status]) {
		status = parseInt(status);
	} else {
		status = 5; // UNDELIVERABLE
	}

	if (typeof callback !== 'function') {
		callback = function() {};
	}

	if (sms.smsId === undefined) {
		err = new Error('Trying to send DLR with no smsId.');
		log.warn('larvitsmpp: lib/utils.js: smsDlr() - ' + err.message);
		callback(err);
		return;
	}

	shortMessage = 'id:' + sms.smsId + ' sub:001 ';

	if (status === 2) {
		shortMessage += 'dlvrd:1 ';
	} else {
		shortMessage += 'dlvrd:0 ';
	}

	shortMessage += 'submit date:' + smppDate(sms.submitTime);
	shortMessage += ' done date:' + smppDate(new Date());

	if (status === 2) {
		shortMessage += ' stat:DELIVRD err:0 text:xxx';
	} else {
		shortMessage += ' stat:UNDELIVERABLE err:1 text:xxx';
	}

	log.verbose('larvitsmpp: lib/utils.js: smsDlr() - Sending DLR message: "' + shortMessage + '"');

	dlrPduObj = {
		'cmdName': 'deliver_sm',
		'params': {
			'source_addr': sms.from,
			'destination_addr': sms.to,
			'esm_class': 4,
			'short_message': shortMessage
		},
		'tlvs': {
			'receipted_message_id': {
				'tagId': 0x001E,
				'tagName': 'receipted_message_id',
				'tagValue': sms.smsId
			},
			'message_state': {
				'tagId': 0x0427,
				'tagName': 'message_state',
				'tagValue': status
			}
		}
	};

	sms.session.send(dlrPduObj, false, function(err, retPdu) {
		callback(err, retPdu, dlrPduObj);
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
