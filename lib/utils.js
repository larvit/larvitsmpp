'use strict';

var log  = require('winston'),
    defs = require('./defs');

/**
 * Calcualte cmdLength from object
 *
 * @param obj obj
 * @param func callback(err, cmdLength)
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
 * @param obj obj - the PDU object to be written to buffer
 * @param int cmdLength - The length of the pdu buffer
 * @param func callback(err, buff)
 */
function writeBuffer(obj, cmdLength, callback) {
	var offset = 16, // Start the offset on the body
	    buff,
	    param,
	    paramType,
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

		// Write parameter value to buffer using the types method write()
		paramType.write(obj.params[param], buff, offset);

		log.silly('larvitsmpp: lib/utils.js: writeBuffer() - Writing param "' + param + '" with content "' + obj.params[param] + '"');

		// Increase the offset for the next param
		offset += paramType.size(obj.params[param]);
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

	callback(null, buff);
}

/**
 * Decode a short_message
 *
 * @param buf buffer
 * @param str encoding 'ASCII', 'LATIN1' or 'UCS2' or hex values
 * @return str in utf8 format
 */
function decodeMsg(buffer, encoding) {
	var checkEnc;

	for (checkEnc in defs.consts.ENCODING) {
		if (parseInt(encoding) === defs.consts.ENCODING[checkEnc] || encoding === checkEnc) {
			encoding = checkEnc;
		}
	}

	if (defs.encodings[encoding] === undefined) {
		log.info('larvitsmpp: lib/utils.js: decodeMsg() - Invalid encoding "' + encoding + '" given. Falling back to ASCII (0x01).');
		encoding = 'ASCII';
	}

	return defs.encodings[encoding].decode(buffer);
}

function encodeMsg(str) {
	var encoding = defs.encodings.detect(str);

	return defs.encodings[encoding].encode(str);
}

/**
 * Transforms a PDU to an object
 *
 * @param buf pdu
 * @param bol stupidNullByte - Define if the short_message should be followed by a stupid NULL byte - will be auto resolved if left undefined
 * @param func callback(err, obj)
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
	retObj.isResponse = function() {
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
		err = new Error('Unknown PDU command id: ' + retObj.cmdId);
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

	// Decode the short message if it is set
	if (retObj.params.short_message !== undefined) {
		retObj.params.short_message = decodeMsg(retObj.params.short_message, retObj.params.data_coding);
	}

	log.debug('larvitsmpp: lib/utils.js: pduToObj() - Complete decoded PDU: ' + JSON.stringify(retObj));

	callback(null, retObj);
}

/**
 * Transform an object to a PDU
 *
 * @param obj obj - example {'cmdName': 'bind_transceiver_resp', 'cmdStatus': 'ESME_ROK', 'seqNr': 2} - to add parameters add a key 'params' as object
 * @param func callback(err, pdu)
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
		// Detect encoding
		obj.params.data_coding = defs.encodings.detect(obj.params.short_message);

		log.silly('larvitsmpp: lib/utils.js: objToPdu() - data_coding "' + obj.params.data_coding + '" detected');

		// Now set the hex value
		obj.params.data_coding = defs.consts.ENCODING[obj.params.data_coding];

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

		writeBuffer(obj, cmdLength, function(err, buff) {
			callback(err, buff);
		});
	});
}

/**
 * Create a PDU as a return to another PDU
 *
 * @param obj or buf pdu
 * @param str status - see list at defs.errors - defaults to 'ESME_ROK' - no error (OPTIONAL)
 * @param obj params (OPTIONAL)
 * @param obj tlvs (OPTIONAL)
 * @param func callback(err, pduBuffer) (OPTIONAL)
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

	if (pdu === undefined || pdu.cmdName === undefined || pdu.seqNr === undefined) {
		err = new Error('larvitsmpp: lib/utils.js: pduReturn() - Invalid call PDU, cannot create response PDU');
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
 * @param obj jsDateObj
 * @return str
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

// Expose some functions
exports.decodeMsg = decodeMsg;
exports.encodeMsg = encodeMsg;
exports.pduToObj  = pduToObj;
exports.objToPdu  = objToPdu;
exports.pduReturn = pduReturn;
exports.smppDate  = smppDate;