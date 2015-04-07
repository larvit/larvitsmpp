'use strict';

var log    = require('winston'),
    merge  = require('utils-merge'),
    net    = require('net'),
    events = require('events'),
    defs   = require('./defs');

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
		log.info('larvitsmpp: decodeMsg() - Invalid encoding "' + encoding + '" given. Falling back to ASCII (0x01).');
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
 * @param func callback(err, obj)
 */
function pduToObj(pdu, callback) {
	var retObj = {'params': {}, 'tlvs': {}},
	    err    = null,
	    offset,
	    command,
	    param,
	    tlvCmdId,
	    tlvLength,
	    tlvValue,
	    paramSize;

	// Returns true if this PDU is a response to another PDU
	retObj.isResponse = function() {
		return ! ! (this.cmdId & 0x80000000);
	};

	log.silly('larvitsmpp: pduToObj() - Decoding PDU to Obj. PDU buff in hex: ' + pdu.toString('hex'));

	if (pdu.length < 16) {
		err = new Error('larvitsmpp: pduToObj() - PDU is to small, minimum size is 16, given size is ' + pdu.length);
		log.warn(err.message);

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
		err = new Error('larvitsmpp: pduToObj() - Unknown PDU command id: ' + retObj.cmdId);
	}

	if (isNaN(retObj.seqNr)) {
		err = new Error('larvitsmpp: pduToObj() - Invalid seqNr, is not an interger: "' + retObj.seqNr + '"');
	} else if (retObj.seqNr > 2147483646) {
		err = new Error('larvitsmpp: pduToObj() - Invalid seqNr, maximum size of 2147483646 (0x7fffffff) exceeded.');
	}

	// If error is found, do not proceed with execution
	if (err !== null) {
		log.warn(err.message);
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

			log.silly('larvitsmpp: pduToObj() - Reading param "' + param + '" at offset ' + offset + ' with calculated size: ' + paramSize + ' content in hex: ' + pdu.slice(offset, offset + paramSize).toString('hex'));

			if (param === 'short_message') {
				// Check if we have a trailing NULL octet after the short_message. Some idiot thought that would be a good idea
				// in some implementations, so we need to account for that.

				if (pdu.slice(offset + retObj.params.sm_length, offset + retObj.params.sm_length + 1).toString('hex') === '00') {
					log.silly('larvitsmpp: pduToObj() - short_message is followed by a NULL octet, increase paramSize one extra to account for that');

					paramSize ++;
				}
			}

			// Increase the offset by the current params length
			offset += paramSize;
		} catch (e) {
			err = new Error('larvitsmpp: pduToObj() - Failed to read param "' + param + '": ' + e.message);
			callback(err);

			return;
		}
	}

	// If the length is greater than the current offset, there must be TLVs - resolve them!
	while (offset < retObj.cmdLength) {
		tlvCmdId  = pdu.readInt16BE(offset);
		tlvLength = pdu.readInt16BE(offset + 2);

		if (defs.tlvsById[tlvCmdId] === undefined) {
			tlvValue = pdu.slice(offset + 4, offset + 4 + tlvLength).toString('hex');

			retObj.tlvs[tlvCmdId] = {
				'tagId': tlvCmdId,
				'tagName': undefined,
				'tagValue': tlvValue
			};

			log.verbose('larvitsmpp: pduToObj() - Unknown TLV found. Hex ID: ' + tlvCmdId.toString(16) + ' length: ' + tlvLength + ' hex value: ' + tlvValue);
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
		}

		offset = offset + 4 + tlvLength;
	}

	// Decode the short message if it is set
	if (retObj.params.short_message !== undefined) {
		retObj.params.short_message = decodeMsg(retObj.params.short_message, retObj.params.data_coding);

		callback(null, retObj);
	} else {
		// We need to do the standard callback in an else statement since
		// this always would be called before the above callback if we didn't
		callback(null, retObj);
	}
}

/**
 * Transform an object to a PDU
 *
 * @param obj obj - example {'cmdName': 'bind_transceiver_resp', 'cmdStatus': 'ESME_ROK', 'seqNr': 2} - to add parameters add a key 'params' as object
 * @param func callback(err, pdu)
 */
function objToPdu(obj, callback) {
	var cmdLength = 16, // All commands are at least 16 octets long
	    err       = null,
	    shortMsg,
	    param,
	    paramType,
	    buff,
	    seqNr,
	    i;

	// Used to write buffer once the command length is known
	function writeBuffer() {
		var offset = 16; // Start the offset on the body

		buff = new Buffer(cmdLength);

		// Write PDU header
		buff.writeUInt32BE(cmdLength, 0);                  // Command length for the first 4 octets
		buff.writeUInt32BE(defs.cmds[obj.cmdName].id, 4);  // Command id for the second 4 octets
		buff.writeUInt32BE(defs.errors[obj.cmdStatus], 8); // Command status for the third 4 octets
		buff.writeUInt32BE(seqNr, 12);                     // Sequence number as the fourth 4 octets

		// Cycle through the defs list to make sure the params are in the right order
		for (param in defs.cmds[obj.cmdName].params) {
			paramType = defs.cmds[obj.cmdName].params[param].type;

			// Write parameter value to buffer using the types method write()
			paramType.write(obj.params[param], buff, offset);

			// Increase the offset for the next param
			offset += paramType.size(obj.params[param]);
		}
	}

	// Check so the command is ok
	if (defs.cmds[obj.cmdName] === undefined) {
		err = new Error('larvitsmpp: objToPdu() - Invalid cmdName: "' + obj.cmdName + '"');
	}

	// Check so the command status is ok
	if (obj.cmdStatus === undefined) {
		// Default to OK
		obj.cmdStatus = 'ESME_ROK';
	}

	if (defs.errors[obj.cmdStatus] === undefined) {
		err = new Error('larvitsmpp: objToPdu() - Invalid cmdStatus: "' + obj.cmdStatus + '"');
	}

	// Check so seqNr is ok
	seqNr = parseInt(obj.seqNr);
	if (isNaN(seqNr)) {
		err = new Error('larvitsmpp: objToPdu() - Invalid seqNr, is not an interger: "' + obj.seqNr + '"');
	} else if (seqNr > 2147483646) {
		err = new Error('larvitsmpp: objToPdu() - Invalid seqNr, maximum size of 2147483646 (0x7fffffff) exceeded.');
	}

	// If error is found, do not proceed with execution
	if (err !== null) {
		log.warn(err.message);
		callback(err);
		return;
	}

	// All params are mandatory. Set them if they are not set
	if (obj.params === undefined) {
		obj.params = {};
	}

	// If param "short_message" exists, encode it and set parameter "data_coding" accordingly
	if (obj.params.short_message !== undefined && ! Buffer.isBuffer(obj.params.short_message)) {
		// Detect encoding
		obj.params.data_coding = defs.encodings.detect(obj.params.short_message);

		log.silly('larvitsmpp: objToPdu() - data_coding "' + obj.params.data_coding + '" detected');

		// Now set the hex value
		obj.params.data_coding = defs.consts.ENCODING[obj.params.data_coding];

		// Acutally encode the string
		shortMsg                 = obj.params.short_message;
		obj.params.short_message = encodeMsg(obj.params.short_message);
		obj.params.sm_length     = obj.params.short_message.length;
		log.silly('larvitsmpp: objToPdu() - encoding message "' + shortMsg + '" to "' + obj.params.short_message.toString('hex') + '"');
	}

	// Handle params - All command params should always exists, even if they do not contain data.
	for (param in defs.cmds[obj.cmdName].params) {

		// Get the parameter type, int, string, cstring etc.
		// This is needed so we can calculate length etc
		paramType = defs.cmds[obj.cmdName].params[param].type;

		if (obj.params[param] === undefined) {
			obj.params[param] = paramType.default;
		}

		cmdLength += paramType.size(obj.params[param]);
	}

	if (obj.params !== undefined) {
		i = 0;
		while (obj.params[i] !== undefined) {


			i ++;
		}
	}

	// TLV params - optional parameters

	writeBuffer();
	callback(null, buff);
}

/**
 * Create a PDU as a return to another PDU
 *
 * @param obj or buf pdu
 * @param str status - see list at defs.errors - defaults to 'ESME_ROK' - no error
 * @param func callback(err, pduBuffer)
 */
function pduReturn(pdu, status, callback) {
	var err    = null,
	    retPdu = {},
	    param;

	if (Buffer.isBuffer(pdu)) {
		log.silly('larvitsmpp: pduReturn() - ran with pdu as buffer, run pduToObj() and retry');

		pduToObj(pdu, function(err, pduObj) {
			if (err) {
				callback(err);
				return;
			}

			pduReturn(pduObj, status, callback);
		});
		return;
	}

	log.silly('larvitsmpp: pduReturn() - ran');

	// If status is a function, it is the callback.
	// Default to OK status and sett callback correctly
	if (typeof status === 'function') {
		callback = status;
		status   = 'ESME_ROK';
	}

	if (status === undefined) {
		status = 'ESME_ROK';
	}

	if (pdu === undefined || pdu.cmdName === undefined || pdu.seqNr === undefined) {
		err = new Error('larvitsmpp: pduReturn() - Invalid call PDU, cannot create response PDU');
	}

	if (err === null && defs.errors[status] === undefined) {
		err = new Error('larvitsmpp: pduReturn() - Invalid status');
	}

	if (err === null && defs.cmds[pdu.cmdName + '_resp'] === undefined) {
		err = new Error('larvitsmpp: pduReturn() - This command does not have a response listed. Given command: "' + pdu.cmdName + '"');
	}

	if (err !== null) {
		log.warn(err.message);
		callback(err);
		return;
	}

	retPdu.cmdName   = pdu.cmdName + '_resp';
	retPdu.cmdStatus = status;
	retPdu.seqNr     = pdu.seqNr;
	retPdu.params    = {};

	// Populate parameters that should exist in the response
	for (param in defs.cmds[pdu.cmdName + '_resp'].params) {
		retPdu.params[param] = pdu.params[param];
	}

	objToPdu(retPdu, function(err, retPdu) {
		callback(err, retPdu);
	});
}

/**
 * Generic session function
 *
 * @param obj sock - socket object
 * @return obj (returnObj)
 */
function session(sock) {
	var returnObj = new events.EventEmitter();

	log.silly('larvitsmpp: session() - New session started from ' + sock.remoteAddress + ':' + sock.remotePort);

	returnObj.loggedIn = false;

	// Sequence number used for commands initiated from us
	returnObj.ourSeqNr = 1;

	// Make the socket transparent via the returned emitter
	returnObj.sock = sock;

	/**
	 * Increase our sequence number
	 */
	returnObj.incOurSeqNr = function() {
		returnObj.ourSeqNr = returnObj.ourSeqNr + 1;

		// If we pass the maximum, start over at 1
		if (returnObj.ourSeqNr > 2147483646) {
			returnObj.ourSeqNr = 1;
		}
	};

	/**
	 * Close the socket
	 * Always use this function to close the socket so we get it on log
	 */
	returnObj.closeSocket = function() {
		log.verbose('larvitsmpp: session() - closeSocket() - Closing socket for ' + sock.remoteAddress + ':' + sock.remotePort);
		if (returnObj.enqLinkTimer) {
			clearTimeout(returnObj.enqLinkTimer);
		}
		sock.destroy();
	};

	/**
	 * Write PDU to socket
	 *
	 * @param buf or obj pdu - can also take PDU object
	 * @param bol closeAfterSend - if true will close the socket after sending
	 */
	returnObj.sockWrite = function(pdu, closeAfterSend) {
		if ( ! Buffer.isBuffer(pdu)) {
			objToPdu(pdu, function(err, buffer) {
				if (err) {
					log.warn('larvitsmpp: session() - sockWrite() - Could not convert PDU to buffer');
					returnObj.closeSocket();
					return;
				}

				returnObj.sockWrite(buffer);
			});
			return;
		}

		log.verbose('larvitsmpp: session() - sockWrite() - sending PDU. SeqNr: ' + pdu.readUInt32BE(12) + ' cmd: ' + defs.cmdsById[pdu.readUInt32BE(4)].command + ' cmdStatus: ' + defs.errorsById[parseInt(pdu.readUInt32BE(8))] + ' hex: ' + pdu.toString('hex'));
		sock.write(pdu);

		if (closeAfterSend) {
			returnObj.closeSocket();
		}
	};

	/**
	 * Send a PDU to the remote
	 *
	 * @param buf or obj pdu
	 * @param bol closeAfterSend - Will close after return is fetched. Defaults to false (OPTIONAL)
	 * @param func callback(err, retPdu) (OPTIONAL)
	 */
	returnObj.send = function(pdu, closeAfterSend, callback) {
		var pduObj = pdu,
		    err    = null;

		// Make sure the sequence number is set and is correct
		if ( ! Buffer.isBuffer(pdu)) {
			pdu.seqNr = returnObj.ourSeqNr;
		}

		// Make sure the pdu is an object
		if (Buffer.isBuffer(pdu)) {
			pduToObj(pdu, function(err, pduObj) {
				if (err) {
					callback(err);
					return;
				}

				returnObj.send(pduObj, closeAfterSend, callback);
			});
			return;
		}

		log.debug('larvitsmpp: session() - returnObj.send() - Sending PDU to remote. cmdName: ' + pdu.cmdName + ' seqNr: ' + pdu.seqNr);

		// If closeAndSend is omitted, put callback in its place
		if (typeof closeAfterSend === 'function') {
			callback       = closeAfterSend;
			closeAfterSend = undefined;
		}

		// Make sure the callack is a function
		if (typeof callback !== 'function') {
			callback = function(){};
		}

		// Response PDUs are not allowed with the send() command, they should use the sendReturn()
		if (pduObj.cmdName.substring(pduObj.cmdName - 5) === '_resp') {
			err = new Error('larvitsmpp: session() - returnObj.send() - Given pduObj is a response, use sendReturn() instead. cmdName: ' + pduObj.cmdName);
			callback(err);
			return;
		}

		// When the return is fetched, call the callback
		returnObj.on('incomingPdu' + pduObj.seqNr, function(incPduObj) {

			log.debug('larvitsmpp: session() - returnObj.send() - returnObj.on(incomingPdu) - cmdName: ' + incPduObj.cmdName + ' seqNr: ' + incPduObj.seqNr + ' cmdStatus: ' + incPduObj.cmdStatus);

			// Clean up by removing this listener or else it will lurk along forever
			returnObj.removeAllListeners('incomingPdu' + pduObj.seqNr);

			// Make sure this is the actual response to the sent PDU
			if (incPduObj.isResponse() && incPduObj.seqNr === pduObj.seqNr) {
				callback(null, incPduObj);

				if (closeAfterSend) {
					returnObj.closeSocket();
				}
			} else {
				err = new Error('larvitsmpp: session() - returnObj.send() - returnObj.on(incomingPdu) - Event triggered but incoming PDU is not a response or seqNr does not match. isResponse: ' + incPduObj.isResponse().toString() + ' incSeqNr: ' + incPduObj.seqNr + ' expected seqNr: ' + pduObj.seqNr);
				log.warn(err.message);
				callback(err);
			}
		});

		// Increase our internal sequence number
		returnObj.incOurSeqNr();

		// Write the PDU to socket
		returnObj.sockWrite(pduObj);
	};

	/**
	 * Send a return to given PDU
	 *
	 * @param obj or buf pdu
	 * @param str status - see list at defs.errors - defaults to 'ESME_ROK' - no error
	 * @param bol closeAfterSend - if true will close the socket after sending (OPTIONAL)
	 * @param func callback(err)
	 */
	returnObj.sendReturn = function(pdu, status, closeAfterSend, callback) {
		if (typeof closeAfterSend === 'function') {
			callback       = closeAfterSend;
			closeAfterSend = undefined;
		}

		pduReturn(pdu, status, function(err, retPdu) {
			if (err) {
				log.error('larvitsmpp: session() - returnObj.sendReturn() - Could not create return PDU: ' + err.message);
				returnObj.closeSocket();

				if (typeof callback === 'function') {
					callback(err);
				}

				return;
			}

			returnObj.sockWrite(retPdu, closeAfterSend);

			if (typeof callback === 'function') {
				callback();
			}
		});
	};

	/**
	 * Send an SMS
	 *
	 * @param obj smsOptions
	 *                       from - alphanum or international format
	 *                       to - international format
	 *                       message - string
	 *                       dlr - boolean defaults to false
	 * @param func callback(err, smsId, retPduObj)
	 */
	returnObj.sendSms = function(smsOptions, callback) {
		var pduObj = {};

		pduObj.cmdName = 'submit_sm';
		pduObj.params  = {
			'source_addr': smsOptions.from,
			'destination_addr': smsOptions.to,
			'short_message': smsOptions.message
		};

		// Request DLRs!
		if (smsOptions.dlr) {
			pduObj.params.registered_delivery = 0x01;
		}

		returnObj.send(pduObj, function(err, retPduObj) {
			if (typeof callback === 'function') {
				callback(err, retPduObj.params.message_id, retPduObj);
			}
		});
	};

	// Handle incoming deliver_sm
	returnObj.deliverSm = function(pduObj) {
		var dlrObj;

		// TLV message_state must exists
		if (pduObj.tlvs.message_state === undefined) {
			log.info('larvitsmpp: session() - returnObj.deliverSm() - TLV message_state is missing. SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		// TLV message_state needs to be valid
		if (defs.constsById.MESSAGE_STATE[pduObj.tlvs.message_state.tagValue] === undefined) {
			log.info('larvitsmpp: session() - returnObj.deliverSm() - Invalid TLV message_state: "' + pduObj.tlvs.message_state.tagValue + '". SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		// TLV receipted_message_id must exist
		if (pduObj.tlvs.receipted_message_id === undefined) {
			log.info('larvitsmpp: session() - returnObj.deliverSm() - TLV receipted_message_id is missing. SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		dlrObj = {
			'statusMsg': defs.constsById.MESSAGE_STATE[pduObj.tlvs.message_state.tagValue],
			'statusId':  pduObj.tlvs.message_state.tagValue,
			'smsId':     pduObj.tlvs.receipted_message_id.tagValue
		};

		returnObj.emit('dlr', dlrObj, pduObj);
		returnObj.sendReturn(pduObj);
	};

	returnObj.submitSm = function(pduObj) {
		returnObj.emit('sms', {
			'from':         pduObj.params.source_addr,
			'to':           pduObj.params.destination_addr,
			'message':      pduObj.params.short_message,
			'dlrRequested': Boolean(pduObj.params.registered_delivery),
			'smsId':        pduObj.params.message_id
		}, pduObj);
		returnObj.sendReturn(pduObj);
	};

	// Dummy, should be extended by serverSession or clientSession
	returnObj.login = function() {
		log.info('larvitsmpp: session() - login() - Dummy login function ran, this might be a mistake');
		returnObj.loggedIn = true;
	};

	// Dummy method - should be used by serverSession or clientSession
	returnObj.resetEnqLinkTimer = function() {
		log.silly('larvitsmpp: session() - resetEnqLinkTimer() - Resetting the kill timer');
	};

	returnObj.enquireLink = function(pduObj) {
		log.silly('larvitsmpp: session() - enquireLink() - Enquiring link');
		returnObj.resetEnqLinkTimer();
		returnObj.sendReturn(pduObj);
	};

	returnObj.unbind = function() {
		returnObj.send({
			'cmdName': 'unbind'
		}, true);
	};

	// Add a 'data' event handler to this instance of socket
	sock.on('data', function(pduBuf) {
		// Pass the data along to the returnObj
		returnObj.emit('data', pduBuf);

		// Reset the enquire link timer
		returnObj.resetEnqLinkTimer();

		log.silly('larvitsmpp: session() - sock.on(data) - Incoming PDU: ' + pduBuf.toString('hex'));

		pduToObj(pduBuf, function(err, pduObj) {
			if (err) {
				log.warn('larvitsmpp: session() - Invalid PDU. ' + err.message);

				returnObj.closeSocket();
			} else {
				log.verbose('larvitsmpp: session() - sock.on(data) - Incoming PDU. Seqnr: ' + pduObj.seqNr + ' cmd: ' + pduObj.cmdName + ' cmdStatus: ' + pduObj.cmdStatus + ' hex: ' + pduBuf.toString('hex'));

				if (pduObj.isResponse()) {
					// We do this so we can remove the dynamic event listeners to not have a memory leak
					returnObj.emit('incomingPdu' + pduObj.seqNr, pduObj);
				} else {
					returnObj.emit('incomingPdu', pduObj);
				}
			}
		});
  });

	// Add a 'close' event handler to this instance of socket
	sock.on('close', function() {
		returnObj.emit('close');
		log.debug('larvitsmpp: session() - socket closed');
	});

	return returnObj;
}

/**
 * Server session function - inherits from session()
 *
 * @param obj sock - socket object
 * @param obj options - as derived from server()
 * @return obj (returnObj)
 */
function serverSession(sock, options) {
	var parent = session(sock);

	/**
	 * Try to log a connecting peer in
	 *
	 * @param obj pduObj
	 */
	parent.login = function(pduObj) {
		log.debug('larvitsmpp: serverSession() - login() - Data received and session is not loggedIn');

		// Pause socket so we do not receive any other commands until we have processed the login
		parent.sock.pause();

		// Only bind_* is accepted when the client is not logged in
		if (pduObj.cmdName !== 'bind_transceiver' && pduObj.cmdName !== 'bind_receiver' && pduObj.cmdName !== 'bind_transmitter') {
			log.debug('larvitsmpp: serverSession() - login()) - Session is not loggedIn and no bind_* command is given. Return error "ESME_RINVBNDSTS');

			pduReturn(pduObj, 'ESME_RINVBNDSTS', function(err, retPdu) {
				if (err) {
					parent.closeSocket();
					return;
				}

				parent.sock.resume();
				parent.sockWrite(retPdu);
			});

			return;
		}

		// If there is a checkuserpass(), use it to check system_id and password from the PDU
		if (typeof options.checkuserpass === 'function') {
			options.checkuserpass(pduObj.params.system_id, pduObj.params.password, function(err, res) {
				if (err) {
					parent.closeSocket();
					return;
				}

				if ( ! res) {
					log.info('larvitsmpp: serverSession() - login() - Login failed! Connected host: ' + sock.remoteAddress + ':' + sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');

					parent.sock.resume();
					parent.sendReturn(pduObj, 'ESME_RBINDFAIL');
					return;
				}

				log.verbose('larvitsmpp: serverSession() - login() - Login successful! Connected host: ' + sock.remoteAddress + ':' + sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');
				parent.loggedIn = true;
				parent.sock.resume();
				parent.sendReturn(pduObj);
			});

			return;
		}

		// If we arrived here it means we are not logged in and that a bind_* event happened and no checkuserpass() method exists. Lets login!
		parent.loggedIn = true;
		parent.sock.resume();
		parent.sendReturn(pduObj);
	};

	/**
	 * Reset the enquire link timer
	 * If this is not ran within options.timeout milliseconds, this session will self terminate
	 */
	parent.resetEnqLinkTimer = function() {
		log.silly('larvitsmpp: serverSession() - resetEnqLinkTimer() - Resetting the kill timer');
		if (parent.enqLinkTimer) {
			clearTimeout(parent.enqLinkTimer);
		}

		parent.enqLinkTimer = setTimeout(function() {
			log.info('larvitsmpp: serverSession() - resetEnqLinkTimer() - Closing session due to timeout');
			parent.closeSocket();
		}, options.timeout);
	};
	parent.resetEnqLinkTimer();

	parent.on('incomingPdu', function(pduObj) {
		if (pduObj.cmdName === 'unbind') {
			parent.sendReturn(pduObj, 'ESME_ROK', true);
		} else if (parent.loggedIn === false) {
			log.debug('larvitsmpp: serverSession() - parent.handleIncomingPdu() - Not logged in, running login function');
			parent.login(pduObj);
		} else if (pduObj.cmdName === 'deliver_sm') {
			parent.deliverSm(pduObj);
		} else if (pduObj.cmdName === 'enquire_link') {
			parent.enquireLink(pduObj);
		} else if (pduObj.cmdName === 'submit_sm') {
			parent.submitSm(pduObj);
		} else {
			// All other commands we do not support
			parent.sendReturn(pduObj, 'ESME_RINVCMDID');
		}
	});

	return parent;
}

/**
 * Client session function - inherits from session()
 *
 * @param obj sock - socket object
 * @param obj options - as derived from client()
 * @return obj (returnObj)
 */
function clientSession(sock, options) {
	var parent = session(sock);

	parent.login = function() {
		var loginPdu = {
			'cmdName': 'bind_transceiver',
			'seqNr': parent.ourSeqNr,
			'params': {
				'system_id': options.username,
				'password': options.password
			}
		};

		parent.send(loginPdu, function(err, retPduObj) {
			if (err) {
				parent.emit('loginFailed');
				return;
			}

			if (retPduObj.cmdStatus === 'ESME_ROK') {
				log.info('larvitsmpp: clientSession() - parent.login() - Successful login!');
				parent.loggedIn = true;
				parent.emit('loggedIn');
			} else {
				log.info('larvitsmpp: clientSession() - parent.login() - Login failed. Status msg: ' + retPduObj.cmdStatus);
				parent.emit('loginFailed');
			}
		});
	};
	parent.login();

	parent.on('incomingPdu', function(pduObj) {
		if (pduObj.cmdName === 'deliver_sm') {
			parent.deliverSm(pduObj);
		} else if (pduObj.cmdName === 'enquire_link') {
			parent.enquireLink(pduObj);
		} else if (pduObj.cmdName === 'submit_sm') {
			parent.submitSm(pduObj);
		} else if (pduObj.cmdName === 'unbind') {
			parent.sendReturn(pduObj, 'ESME_ROK', true);
		} else {
			// All other commands we do not support
			parent.sendReturn(pduObj, 'ESME_RINVCMDID');
		}
	});

	return parent;
}

/**
 * Setup a server
 *
 * @param obj options - host, port, checkuserpass() etc (OPTIONAL)
 * @param func callback(err, session)
 */
function server(options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options  = {};
	}

	// Set default options
	options = merge({
		'host': 'localhost',
		'port': 2775,
		'timeout': 30000 // 30 sec
	}, options || {});

	// Create a server instance, and chain the listen function to it
	// The function passed to net.createServer() becomes the event handler for the 'connection' event
	// The sock object the callback function receives UNIQUE for each connection
	net.createServer(function(sock) {
		var returnObj = serverSession(sock, options);

		// We have a connection - a socket object is assigned to the connection automatically
		log.verbose('larvitsmpp: server() - Incomming connection! From: ' + sock.remoteAddress + ':' + sock.remotePort);

		callback(null, returnObj);
	}).listen(options.port, options.host);

	log.info('larvitsmpp: server() - Up and running at ' + options.host + ':' + options.port);
}

/**
 * Setup a client
 *
 * @param obj options - host, port, username, password
 * @param func callback(err, session)
 */
function client(options, callback) {
	var sock = new net.Socket();

	// Set default options
	options = merge({
		'host':          'localhost',
		'port':          2775,
		'username':      'user',
		'password':      'pass',
		'enqLinkTiming': 20000 // 20 sec
	}, options || {});

	sock.connect(options.port, options.host, function() {
		var session = clientSession(sock, options);

		log.info('larvitsmpp: client() - Connected to ' + sock.remoteAddress + ':' + sock.remotePort);

		session.on('loggedIn', function() {
			callback(null, session);
		});

		session.on('loginFailed', function() {
			var err = new Error('larvitsmpp: client() - Remote host refused login.');
			log.warn(err.message);
			callback(err);
		});
	});
}

// Expose some functions
exports.server    = server;
exports.client    = client;
exports.pduToObj  = pduToObj;
exports.objToPdu  = objToPdu;
exports.pduReturn = pduReturn;