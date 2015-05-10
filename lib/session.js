'use strict';

var log    = require('winston'),
    events = require('events'),
    utils  = require('./utils'),
    defs   = require('./defs');

/**
 * Generic session function
 *
 * @param obj sock - socket object
 * @return obj (returnObj)
 */
function session(sock) {
	var returnObj = new events.EventEmitter();

	log.silly('larvitsmpp: lib/session.js: session() - New session started from ' + sock.remoteAddress + ':' + sock.remotePort);

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
		log.verbose('larvitsmpp: lib/session.js: session() - closeSocket() - Closing socket for ' + sock.remoteAddress + ':' + sock.remotePort);
		if (returnObj.enqLinkTimer) {
			log.debug('larvitsmpp: lib/session.js: session() - closeSocket() - enqLinkTimer found, clearing.');
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
			utils.objToPdu(pdu, function(err, buffer) {
				if (err) {
					log.warn('larvitsmpp: lib/session.js: session() - sockWrite() - Could not convert PDU to buffer');
					returnObj.closeSocket();
					return;
				}

				returnObj.sockWrite(buffer);
			});
			return;
		}

		try {
			log.verbose('larvitsmpp: lib/session.js: session() - sockWrite() - sending PDU. SeqNr: ' + pdu.readUInt32BE(12) + ' cmd: ' + defs.cmdsById[pdu.readUInt32BE(4)].command + ' cmdStatus: ' + defs.errorsById[parseInt(pdu.readUInt32BE(8))] + ' hex: ' + pdu.toString('hex'));
		} catch (e) {
			log.error('larvitsmpp: lib/session.js: session() - sockWrite() - PDU buffer is invalid. Buffer hex: "' + pdu.toString('hex') + '"');
			return;
		}

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

		// Make sure the pdu is an object
		if (Buffer.isBuffer(pdu)) {
			utils.pduToObj(pdu, function(err, pduObj) {
				if (err) {
					callback(err);
					return;
				}

				returnObj.send(pduObj, closeAfterSend, callback);
			});
			return;
		}

		// Make sure the sequence number is set and is correct
		pduObj.seqNr = returnObj.ourSeqNr;

		log.debug('larvitsmpp: lib/session.js: session() - returnObj.send() - Sending PDU to remote. pduObj: ' + JSON.stringify(pduObj));

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
			err = new Error('larvitsmpp: lib/session.js: session() - returnObj.send() - Given pduObj is a response, use sendReturn() instead. cmdName: ' + pduObj.cmdName);
			callback(err);
			return;
		}

		// When the return is fetched, call the callback
		returnObj.on('incomingPduObj' + pduObj.seqNr, function(incPduObj) {

			log.debug('larvitsmpp: lib/session.js: session() - returnObj.send() - returnObj.on(incomingPduObj) - cmdName: ' + incPduObj.cmdName + ' seqNr: ' + incPduObj.seqNr + ' cmdStatus: ' + incPduObj.cmdStatus);

			// Make sure this is the actual response to the sent PDU
			if (incPduObj.isResponse() && incPduObj.seqNr === pduObj.seqNr) {
				callback(null, incPduObj);

				if (closeAfterSend) {
					returnObj.closeSocket();
				}
			} else {
				err = new Error('larvitsmpp: lib/session.js: session() - returnObj.send() - returnObj.on(incomingPduObj) - Event triggered but incoming PDU is not a response or seqNr does not match. isResponse: ' + incPduObj.isResponse().toString() + ' incSeqNr: ' + incPduObj.seqNr + ' expected seqNr: ' + pduObj.seqNr);
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
	 * @param str status - see list at defs.errors - defaults to 'ESME_ROK' - no error (OPTIONAL)
	 * @param obj params (OPTIONAL)
	 * @param bol closeAfterSend - if true will close the socket after sending (OPTIONAL)
	 * @param func callback(err, retPdu) (OPTIONAL)
	 */
	returnObj.sendReturn = function(pdu, status, params, closeAfterSend, callback) {
		if (typeof params === 'function') {
			callback       = params;
			params         = undefined;
			closeAfterSend = undefined;
		}

		if (typeof closeAfterSend === 'function') {
			callback       = closeAfterSend;
			closeAfterSend = undefined;
		}

		utils.pduReturn(pdu, status, params, function(err, retPdu) {
			if (err) {
				log.error('larvitsmpp: lib/session.js: session() - returnObj.sendReturn() - Could not create return PDU: ' + err.message);
				returnObj.closeSocket();

				if (typeof callback === 'function') {
					callback(err);
				}

				return;
			}

			returnObj.sockWrite(retPdu, closeAfterSend);

			if (typeof callback === 'function') {
				callback(null, retPdu);
			}
		});
	};

	/**
	 * Send a longer SMS than 1120 bits
	 *
	 * @param obj smsOptions
	 *                       from - alphanum or international format
	 *                       to - international format
	 *                       message - string
	 *                       dlr - boolean defaults to false
	 * @param func callback(err, smsId, retPduObj)
	 */
	returnObj.sendLongSms = function(smsOptions, callback) {
		var msgs     = utils.splitMsg(smsOptions.message),
		    encoding = defs.encodings.detect(smsOptions.message); // Set encoding once for all message parts

		function sendPart(i) {
			var pduObj = {
				'cmdName': 'submit_sm',
				'params': {
					'source_addr_ton': 1, // Default to international format
					'esm_class': 0x40, // This indicates that there is a UDH in the short_message
					'source_addr': smsOptions.from,
					'destination_addr': smsOptions.to,
					'data_coding': defs.consts.ENCODING[encoding],
					'short_message': msgs[i],
					'sm_length': msgs[i].length
				}
			};

			// Request DLRs!
			if (smsOptions.dlr) {
				pduObj.params.registered_delivery = 0x01;
			}

			log.debug('larvitsmpp: lib/session.js: returnObj.sendLongSms() - pduObj: ' + JSON.stringify(pduObj));

			returnObj.send(pduObj, function(err, retPduObj) {
				if (typeof callback === 'function' && msgs[i + 1] === undefined) {
					callback(err, retPduObj.params.message_id, retPduObj);
				} else if (msgs[i + 1] !== undefined) {
					sendPart(i + 1);
				}
			});
		}

		sendPart(0);
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
			'source_addr_ton': 1, // Default to international format
			'source_addr': smsOptions.from,
			'destination_addr': smsOptions.to,
			'short_message': smsOptions.message
		};

		// Request DLRs!
		if (smsOptions.dlr) {
			pduObj.params.registered_delivery = 0x01;
		}

		// Check if we must split this message into multiple
		if (utils.bitCount(smsOptions.message) > 1120) {
			returnObj.sendLongSms(smsOptions, callback);

			return;
		}

		log.debug('larvitsmpp: lib/session.js: returnObj.sendSms() - pduObj: ' + JSON.stringify(pduObj));

		returnObj.send(pduObj, function(err, retPduObj) {
			if (typeof callback === 'function') {
				callback(err, retPduObj.params.message_id, retPduObj);
			}
		});
	};

	/**
	 * Send a DLR
	 *
	 * @param obj sms - sms object
	 * @param bol status - defaults to true
	 * @param func callback(err)
	 */
	returnObj.sendDlr = function(sms, status, callback) {
		var shortMessage = 'id:' + sms.smsId + ' sub:001 ',
		    dlrPduObj;

		if (typeof status === 'function') {
			callback = status;
			status   = true;
		}

		if (status === undefined) {
			status = true;
		}

		if (status) {
			shortMessage += 'dlvrd:1 ';
		} else {
			shortMessage += 'dlvrd:0 ';
		}

		shortMessage += 'submit date:' + utils.smppDate(sms.submitTime);
		shortMessage += ' done date:' + utils.smppDate(new Date());

		if (status) {
			shortMessage += ' stat:DELIVRD err:0 text:xxx';
		} else {
			shortMessage += ' stat:UNDELIVERABLE err:1 text:xxx';
		}

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
					'tagValue': 2
				}
			}
		};

		if ( ! status) {
			dlrPduObj.tlvs.message_state.tagValue = 5;
		}

		dlrPduObj.seqNr = 323;

		utils.objToPdu(dlrPduObj, function(err, pdu) {
			if (err) {
				throw err;
			}

			utils.pduToObj(pdu, function(err, newObj) {
				if (err) {
					throw err;
				}

				console.log('newObj:');
				console.log(newObj);
			});
		});

		returnObj.send(dlrPduObj, function(err, retPduObj) {
			console.log('WHATTA WHATTA');
			console.log(retPduObj);

			if (typeof callback === 'function') {
				callback(err, retPduObj.params.message_id, retPduObj);
			}
		});
	};

	// Handle incomming commands.
	// This is intended to be extended
	returnObj.handleCmd = {};

	// Handle incoming deliver_sm
	returnObj.handleCmd.deliver_sm = function(pduObj) {
		var dlrObj;

		// TLV message_state must exists
		if (pduObj.tlvs.message_state === undefined) {
			log.info('larvitsmpp: lib/session.js: session() - returnObj.deliverSm() - TLV message_state is missing. SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		// TLV message_state needs to be valid
		if (defs.constsById.MESSAGE_STATE[pduObj.tlvs.message_state.tagValue] === undefined) {
			log.info('larvitsmpp: lib/session.js: session() - returnObj.deliverSm() - Invalid TLV message_state: "' + pduObj.tlvs.message_state.tagValue + '". SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		// TLV receipted_message_id must exist
		if (pduObj.tlvs.receipted_message_id === undefined) {
			log.info('larvitsmpp: lib/session.js: session() - returnObj.deliverSm() - TLV receipted_message_id is missing. SeqNr: ' + pduObj.seqNr);
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

	// Enquire link
	returnObj.handleCmd.enquire_link = function(pduObj) {
		log.silly('larvitsmpp: lib/session.js: session() - enquireLink() - Enquiring link');
		returnObj.resetEnqLinkTimer();
		returnObj.sendReturn(pduObj);
	};

	// Handle incoming submit_sm
	returnObj.handleCmd.submit_sm = function(pduObj) {
		var smsObj = {};

		smsObj = {
			'from':       pduObj.params.source_addr,
			'to':         pduObj.params.destination_addr,
			'submitTime': new Date(),
			'message':    pduObj.params.short_message,
			'dlr':        Boolean(pduObj.params.registered_delivery)
		};

		function smsReceived(smsData) {
			if (smsData === undefined) {
				smsData = {};
			}

			smsObj.smsId = smsData.smsId;

			returnObj.sendReturn(pduObj, 'ESME_ROK', {'message_id': smsObj.smsId});
		}

		returnObj.emit('sms', smsObj, smsReceived);
	};

	// Handle incoming unbind
	returnObj.handleCmd.unbind = function(pduObj) {
		returnObj.sendReturn(pduObj, 'ESME_ROK', undefined, true);
	};

	// Dummy, should be extended by serverSession or clientSession
	returnObj.login = function() {
		log.info('larvitsmpp: lib/session.js: session() - login() - Dummy login function ran, this might be a mistake');
		returnObj.loggedIn = true;
	};

	// Dummy method - should be used by serverSession or clientSession
	returnObj.resetEnqLinkTimer = function() {
		log.silly('larvitsmpp: lib/session.js: session() - resetEnqLinkTimer() - Resetting the kill timer');
	};

	// Unbind this session
	returnObj.unbind = function() {
		returnObj.send({
			'cmdName': 'unbind'
		}, true);
	};

	// Setup a data queue in case we only get partial data on the socket
	// This way we can concatenate them later on
	returnObj.dataQueue = new Buffer(0);

	// Add a 'data' event handler to this instance of socket
	sock.on('data', function(data) {
		var cmdLength,
		    pdu;

		// Pass the data along to the returnObj
		returnObj.emit('data', data);

		// Reset the enquire link timer
		returnObj.resetEnqLinkTimer();

		log.silly('larvitsmpp: lib/session.js: session() - sock.on(data) - Incoming data: ' + data.toString('hex'));

		// Add this data to the dataQueue for processing
		returnObj.dataQueue = Buffer.concat([returnObj.dataQueue, data]);

		// Process queue
		while (returnObj.dataQueue.length !== 0) {
			// Get this commands length
			cmdLength = parseInt(data.readUInt32BE(0));
			log.silly('larvitsmpp: lib/session.js: session() - sock.on(data) - Processing ' + cmdLength + ' bytes of data');

			// If there is at least enough bytes in the dataQueue to fill this PDU, do it!
			if (cmdLength <= returnObj.dataQueue.length) {
				log.silly('larvitsmpp: lib/session.js: session() - sock.on(data) - Full PDU found in dataQueue, processing ' + cmdLength + ' bytes of queue total ' + returnObj.dataQueue.length + ' bytes');

				// Slice up the dataQueue buffer to this commands length
				pdu = returnObj.dataQueue.slice(0, cmdLength);

				// Slice off the command from the dataQueue
				returnObj.dataQueue = returnObj.dataQueue.slice(cmdLength, returnObj.dataQueue.length);

				returnObj.emit('incomingPdu', pdu);
			}

			if (returnObj.dataQueue.length === 0) {
				log.silly('larvitsmpp: lib/session.js: session() - sock.on(data) - All queue hanlded, breaking while loop.');
				break;
			}

			// If the command length is larger than the queue, we need to wait for more data. Stop processing!
			if (cmdLength > returnObj.dataQueue) {
				log.debug('larvitsmpp: lib/session.js: session() - sock.on(data) - Incomplete PDU found in dataQueue, waiting for more data to continue. Current cmdLength: ' + cmdLength + ' current queue: ' + returnObj.dataQueue.toString('hex'));

				break;
			}
		}
  });

	// Handle incoming Pdu Buffers
	returnObj.on('incomingPdu', function(pdu) {
		utils.pduToObj(pdu, function(err, pduObj) {
			if (err) {
				log.warn('larvitsmpp: lib/session.js: session() - returnObj.on(incomingPdu) - Invalid PDU, closing socket.');

				returnObj.closeSocket();
			} else {
				log.verbose('larvitsmpp: lib/session.js: session() - returnObj.on(incomingPdu) - Incoming PDU parsed. Seqnr: ' + pduObj.seqNr + ' cmd: ' + pduObj.cmdName + ' cmdStatus: ' + pduObj.cmdStatus + ' hex: ' + pdu.toString('hex'));

				if (pduObj.isResponse()) {
					// We do this so we can remove the dynamic event listeners to not have a memory leak
					returnObj.emit('incomingPduObj' + pduObj.seqNr, pduObj);

					// Clean up by removing this listener or else it will lurk along forever
					returnObj.removeAllListeners('incomingPduObj' + pduObj.seqNr);
				} else {
					returnObj.emit('incomingPduObj', pduObj);
				}
			}
		});
	});

	// Add a 'close' event handler to this instance of socket
	sock.on('close', function() {
		returnObj.emit('close');
		if (returnObj.enqLinkTimer) {
			log.debug('larvitsmpp: lib/session.js: session() - sock.on(close) - enqLinkTimer found, clearing.');
			clearTimeout(returnObj.enqLinkTimer);
		}
		log.debug('larvitsmpp: lib/session.js: session() - sock.on(close) - socket closed');
	});

	return returnObj;
}

// Expose some functions
exports = module.exports = session;