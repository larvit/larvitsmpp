'use strict';

var log       = require('winston'),
    events    = require('events'),
    smppUtils = require('./utils'),
    defs      = require('./defs');

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
			smppUtils.objToPdu(pdu, function(err, buffer) {
				if (err) {
					log.warn('larvitsmpp: lib/session.js: session() - sockWrite() - Could not convert PDU to buffer');
					returnObj.closeSocket();
					return;
				}

				returnObj.sockWrite(buffer);
			});
			return;
		}

		log.verbose('larvitsmpp: lib/session.js: session() - sockWrite() - sending PDU. SeqNr: ' + pdu.readUInt32BE(12) + ' cmd: ' + defs.cmdsById[pdu.readUInt32BE(4)].command + ' cmdStatus: ' + defs.errorsById[parseInt(pdu.readUInt32BE(8))] + ' hex: ' + pdu.toString('hex'));
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
			smppUtils.pduToObj(pdu, function(err, pduObj) {
				if (err) {
					callback(err);
					return;
				}

				returnObj.send(pduObj, closeAfterSend, callback);
			});
			return;
		}

		log.debug('larvitsmpp: lib/session.js: session() - returnObj.send() - Sending PDU to remote. cmdName: ' + pdu.cmdName + ' seqNr: ' + pdu.seqNr);

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
		returnObj.on('incomingPdu' + pduObj.seqNr, function(incPduObj) {

			log.debug('larvitsmpp: lib/session.js: session() - returnObj.send() - returnObj.on(incomingPdu) - cmdName: ' + incPduObj.cmdName + ' seqNr: ' + incPduObj.seqNr + ' cmdStatus: ' + incPduObj.cmdStatus);

			// Clean up by removing this listener or else it will lurk along forever
			returnObj.removeAllListeners('incomingPdu' + pduObj.seqNr);

			// Make sure this is the actual response to the sent PDU
			if (incPduObj.isResponse() && incPduObj.seqNr === pduObj.seqNr) {
				callback(null, incPduObj);

				if (closeAfterSend) {
					returnObj.closeSocket();
				}
			} else {
				err = new Error('larvitsmpp: lib/session.js: session() - returnObj.send() - returnObj.on(incomingPdu) - Event triggered but incoming PDU is not a response or seqNr does not match. isResponse: ' + incPduObj.isResponse().toString() + ' incSeqNr: ' + incPduObj.seqNr + ' expected seqNr: ' + pduObj.seqNr);
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
	 * @param bol closeAfterSend - if true will close the socket after sending (OPTIONAL)
	 * @param func callback(err) (OPTIONAL)
	 */
	returnObj.sendReturn = function(pdu, status, closeAfterSend, callback) {
		if (typeof closeAfterSend === 'function') {
			callback       = closeAfterSend;
			closeAfterSend = undefined;
		}

		smppUtils.pduReturn(pdu, status, function(err, retPdu) {
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

	// Handle incoming submit_sm
	returnObj.submitSm = function(pduObj) {
		var smsObj = {};

		smsObj = {
			'from':         pduObj.params.source_addr,
			'to':           pduObj.params.destination_addr,
			'message':      pduObj.params.short_message,
			'dlrRequested': Boolean(pduObj.params.registered_delivery)
		};

		function smsReceived(smsData) {
			if (smsData === undefined) {
				smsData = {};
			}

			if (smsData.smsId !== undefined) {
				// Todo: Generate random ID
				smsData.smsId = 666;
			}

			smsObj.smsId = smsData.smsId;

			returnObj.sendReturn(pduObj, 'ESME_ROK', {'message_id': smsObj.smsId});
		}

		returnObj.emit('sms', smsObj, smsReceived);
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

	returnObj.enquireLink = function(pduObj) {
		log.silly('larvitsmpp: lib/session.js: session() - enquireLink() - Enquiring link');
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

		log.silly('larvitsmpp: lib/session.js: session() - sock.on(data) - Incoming PDU: ' + pduBuf.toString('hex'));

		smppUtils.pduToObj(pduBuf, function(err, pduObj) {
			if (err) {
				log.warn('larvitsmpp: lib/session.js: session() - Invalid PDU. ' + err.message);

				returnObj.closeSocket();
			} else {
				log.verbose('larvitsmpp: lib/session.js: session() - sock.on(data) - Incoming PDU. Seqnr: ' + pduObj.seqNr + ' cmd: ' + pduObj.cmdName + ' cmdStatus: ' + pduObj.cmdStatus + ' hex: ' + pduBuf.toString('hex'));

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
		log.debug('larvitsmpp: lib/session.js: session() - socket closed');
	});

	return returnObj;
}

// Expose some functions
exports = module.exports = session;