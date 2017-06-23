'use strict';

var log    = require('winston'),
    events = require('events'),
    moment = require('moment'),
    utils  = require('./utils'),
    defs   = require('./defs'),
    async  = require('async');

/*
 * Send a response to an sms
 * This must be called from an sms object context
 *
 * @param str status - see list at defs.errors - defaults to 'ESME_ROK' - no error (OPTIONAL)
 * @param func callback(err, [retPdu, ...])
 */
function smsResp(status, callback) {
	var sms   = this,
	    tasks = [],
	    params,
	    err,
	    i;

	if (typeof status === 'function') {
		callback = status;
		status   = true;
	}

	if (typeof callback !== 'function') {
		callback = function() {};
	}

	if (sms.smsId === undefined) {
		sms.smsId = '';
	}

	// Accept a generic positive status
	if (status === 'true' || status === true || status === 0) {
		status = 'ESME_ROK';
	}

	// Accept a generic negative status
	if (status === 'false' || status === false || status === 1) {
		status = 'ESME_RUNKNOWNERR'; // Set to unknown error in this case
	}

	if (sms.pduObjs === undefined) {
		err = new Error('No pdu objects found to base return PDU upon');
		log.warn('larvitsmpp: lib/session.js: smsResp() - ' + err.message);
		callback(err);
		return;
	}

	// Build async tasks to run the responses in parallel
	i = 0;
	while (sms.pduObjs[i] !== undefined) {
		if (sms.smsId) {
			if (sms.pduObjs[i].pduObj.params.esm_class === 0x40) {
				params = {'message_id': sms.smsId + '-' + (i + 1)};
			} else {
				params = {'message_id': sms.smsId};
			}
		} else {
			params = {};
		}

		tasks[i] = sms.session.sendReturn.bind(
			sms.session,
			sms.pduObjs[i].pduObj,
			status,
			params,
			false
		);

		i ++;
	}

	async.parallel(tasks, callback);
}

function incOurSeqNr() {
	this.ourSeqNr = this.ourSeqNr + 1;

	// If we pass the maximum, start over at 1
	if (this.ourSeqNr > 2147483646) {
		this.ourSeqNr = 1;
	}
}

/**
 * Close the socket
 * Always use this function to close the socket so we get it on log
 */
function closeSocket() {
	log.verbose('larvitsmpp: lib/session.js: closeSocket() - Closing socket for ' + this.sock.remoteAddress + ':' + this.sock.remotePort);
	if (this.enqLinkTimer) {
		log.debug('larvitsmpp: lib/session.js: closeSocket() - enqLinkTimer found, clearing.');
		clearTimeout(this.enqLinkTimer);
	}
	this.sock.destroy();
}

/**
 * Write PDU to socket
 *
 * @param {buffer|object} pdu - can also take PDU object
 * @param {boolean} closeAfterSend - if true will close the socket after sending
 */
function sockWrite(pdu, closeAfterSend) {
	var that = this;

	if ( ! Buffer.isBuffer(pdu)) {
		utils.objToPdu(pdu, function(err, buffer) {
			if (err) {
				log.warn('larvitsmpp: lib/session.js: sockWrite() - Could not convert PDU to buffer');
				that.closeSocket();
				return;
			}

			that.sockWrite(buffer);
		});
		return;
	}

	try {
		log.verbose('larvitsmpp: lib/session.js: sockWrite() - sending PDU. SeqNr: ' + pdu.readUInt32BE(12) + ' cmd: ' + defs.cmdsById[pdu.readUInt32BE(4)].command + ' cmdStatus: ' + defs.errorsById[parseInt(pdu.readUInt32BE(8))] + ' hex: ' + pdu.toString('hex'));
	} catch (e) {
		log.error('larvitsmpp: lib/session.js: sockWrite() - PDU buffer is invalid. Buffer hex: "' + pdu.toString('hex') + '"');
		return;
	}

	this.sock.write(pdu);

	if (closeAfterSend) {
		this.closeSocket();
	}
}

/**
 * Send a PDU to the remote
 *
 * @param {buffer|object} pdu
 * @param {boolean} closeAfterSend - Will close after return is fetched. Defaults to false (OPTIONAL)
 * @param {function} callback(err, retPdu) (OPTIONAL)
 */
function send(pdu, closeAfterSend, callback) {
	var pduObj = pdu,
	    err    = null,
	    that   = this;

	// Make sure the pdu is an object
	if (Buffer.isBuffer(pdu)) {
		utils.pduToObj(pdu, function(err, pduObj) {
			if (err) {
				callback(err);
				return;
			}

			that.send(pduObj, closeAfterSend, callback);
		});
		return;
	}

	// Make sure the sequence number is set and is correct
	pduObj.seqNr = this.ourSeqNr;

	log.debug('larvitsmpp: lib/session.js: send() - Sending PDU to remote. pduObj: ' + JSON.stringify(pduObj));

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
		err = new Error('Given pduObj is a response, use sendReturn() instead. cmdName: ' + pduObj.cmdName);
		callback(err);
		return;
	}

	// When the return is fetched, call the callback
	this.on('incomingPduObj' + pduObj.seqNr, function(incPduObj) {

		log.debug('larvitsmpp: lib/session.js: send() - this.on(incomingPduObj) - cmdName: ' + incPduObj.cmdName + ' seqNr: ' + incPduObj.seqNr + ' cmdStatus: ' + incPduObj.cmdStatus);

		// Make sure this is the actual response to the sent PDU
		if (incPduObj.isResp() && incPduObj.seqNr === pduObj.seqNr) {
			callback(null, incPduObj);

			if (closeAfterSend) {
				that.closeSocket();
			}
		} else {
			err = new Error('Event triggered but incoming PDU is not a response or seqNr does not match. isResp: ' + incPduObj.isResp().toString() + ' incSeqNr: ' + incPduObj.seqNr + ' expected seqNr: ' + pduObj.seqNr);
			log.warn('larvitsmpp: lib/session.js: send() - this.on(incomingPduObj) - ' + err.message);
			callback(err);
		}
	});

	// Increase our internal sequence number
	this.incOurSeqNr();

	// Write the PDU to socket
	this.sockWrite(pduObj);
}

/**
 * Send a return to given PDU
 *
 * @param {buffer|object} pdu
 * @param {string} status - see list at defs.errors - defaults to 'ESME_ROK' - no error (OPTIONAL)
 * @param {object} [params]
 * @param {boolean} closeAfterSend - if true will close the socket after sending (OPTIONAL)
 * @param {function} [callback(err, retPdu)]
 */
function sendReturn(pdu, status, params, closeAfterSend, callback) {
	var that = this;

	log.silly('larvitsmpp: lib/session.js: sendReturn() - ran');

	if (typeof params === 'function') {
		callback       = params;
		params         = undefined;
		closeAfterSend = undefined;
	}

	if (typeof closeAfterSend === 'function') {
		callback       = closeAfterSend;
		closeAfterSend = undefined;
	}

	if (typeof callback !== 'function') {
		callback = function() {};
	}



	utils.pduReturn(pdu, status, params, function(err, retPdu) {
		if (err) {
			log.error('larvitsmpp: lib/session.js: sendReturn() - Could not create return PDU: ' + err.message);
			that.closeSocket();

			callback(err);
			return;
		}

		log.silly('larvitsmpp: lib/session.js: sendReturn() - Sending return PDU: ' + retPdu.toString('hex'));
		that.sockWrite(retPdu, closeAfterSend);
		callback(null, retPdu);
	});
}

/**
 * Send an SMS
 *
 * @param {object} smsOptions
 *                       from - alphanum or international format
 *                       to - international format
 *                       message - string
 *                       dlr - boolean defaults to false
 *                       flash - boolean defaults to false
 * @param {function} callback(err, smsIds, retPduObjs)
 */
function sendSms(smsOptions, callback) {
	var pduObj = {};

	pduObj.cmdName = 'submit_sm';
	pduObj.params  = {
		'source_addr_ton':  1, // Default to international format
		'source_addr':      smsOptions.from,
		'destination_addr': smsOptions.to,
		'short_message':    smsOptions.message
	};

	// Flash messages overrides default data_coding
	if (smsOptions.flash) {
		log.debug('larvitsmpp: lib/session.js: sendSms() - Flash SMS detected, set data_coding to 0x10!');
		pduObj.params.data_coding = 0x10;
	}

	// Request DLRs!
	if (smsOptions.dlr) {
		pduObj.params.registered_delivery = 0x01;
	}

	// Check if we must split this message into multiple
	if (utils.bitCount(smsOptions.message) > 1120) {
		log.debug('larvitsmpp: lib/session.js: sendSms() - Message larger than 1120 bits, send it as long message!');

		this.sendLongSms(smsOptions, callback);

		return;
	}

	log.debug('larvitsmpp: lib/session.js: sendSms() - pduObj: ' + JSON.stringify(pduObj));

	this.send(pduObj, function(err, retPduObj) {
		if (typeof callback === 'function') {
			callback(err, [retPduObj.params.message_id], [retPduObj]);
		}
	});
}

/**
 * Send a longer SMS than 1120 bits
 *
 * @param {object} smsOptions
 *                       from - alphanum or international format
 *                       to - international format
 *                       message - string
 *                       dlr - boolean defaults to false
 * @param {function} callback(err, smsId, retPduObj)
 */
function sendLongSms(smsOptions, callback) {
	var that       = this,
	    smsIds     = [],
	    retPduObjs = [],
	    msgs       = utils.splitMsg(smsOptions.message),
	    encoding   = defs.encodings.detect(smsOptions.message); // Set encoding once for all message parts

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

		log.debug('larvitsmpp: lib/session.js: sendLongSms() - pduObj: ' + JSON.stringify(pduObj));

		that.send(pduObj, function(err, retPduObj) {
			smsIds.push(retPduObj.params.message_id);
			retPduObjs.push(retPduObj);

			log.silly('larvitsmpp: lib/session.js: sendLongSms() - Got callback from that.send()');

			if (typeof callback === 'function' && smsIds.length === msgs.length) {
				log.silly('larvitsmpp: lib/session.js: sendLongSms() - All callbacks returned, run the parent callback.');
				callback(err, smsIds, retPduObjs);
			}
		});

		if (msgs[i + 1] !== undefined) {
			sendPart(i + 1);
		}
	}

	sendPart(0);
}

// Store long smses in the temporary storage
function longSms(pduObj) {
	// Fix: UDH values are stored in HEX and decoding them make it garbage. First OCTET contains
	//      the size of UDH data header. If UDH data header size is 0x05 then field 4 i.e. CSMS
	//      reference number is of one octet otherwise it consists of 2 octets. Other fields can
	//      be found from below reference.
	//      reference: https://en.wikipedia.org/wiki/Concatenated_SMS
	var udhHeaderSize = pduObj.params.short_message[0], // First octet is the size of UDH Header
	    headerSize    = pduObj.params.short_message[2], // Header size other than first 2 octets
	    csmsReference = pduObj.params.short_message.slice(3, 3 + headerSize - 2), // CSMS Reference starts from
	                                                                              // 4th octet and length is
	                                                                              // header size -2 octets
	    partsCount    = pduObj.params.short_message[2 + csmsReference.length + 1],
	    partNr        = pduObj.params.short_message[2 + csmsReference.length + 2],
	    longSmsId     = pduObj.params.source_addr + '_' + pduObj.params.destination_addr + '_' + csmsReference;

	if (this.longSmses[longSmsId] === undefined) {
		this.longSmses[longSmsId] = {
			'created': new Date(),
			'partsCount': partsCount,
			'udhSize': udhHeaderSize, // Saving udh size to remove garbage from message
			'pduObjs': [{
				'partNr': partNr, // We save this here to easier sort the array later on
				'pduObj': pduObj
			}]
		};
	} else {
		this.longSmses[longSmsId].pduObjs.push({
			'partNr': partNr, // We save this here to easier sort the array later on
			'pduObj': pduObj
		});
	}

	// Check the long messages tmp storage to see if we should handle them
	this.checkLongSmses();
}

// Sort function to sort group parts
function sortLongSmsPdus(a, b) {
	if (a.partNr < b.partNr) {
		return - 1;
	}

	if (a.partNr > b.partNr) {
		return 1;
	}

	return 0;
}

// Walk through the long sms storage to investigate if we can send complete messages along
// or should remove old ones
function checkLongSmses() {
	var that = this,
	    smsGroupId,
	    smsGroup,
	    udhSize, // UDH Size from longSms() function
	    smsObj,
	    i,
	    curPduObj;

	log.silly('larvitsmpp: lib/session.js: checkLongSmses() - Running');

	// Call when complete SMS is received
	function smsReceived() {
		that.emit('sms', smsObj);

		// This needs to be ran if DLRs are sent for these messages
		delete that.longSmses[smsObj.smsGroupId];
	}

	for (smsGroupId in this.longSmses) {
		smsGroup = this.longSmses[smsGroupId];
		udhSize = smsGroup.udhSize;
		// All parts are accounted for! Emit sms event and clear from tmp storage
		if (smsGroup.partsCount === smsGroup.pduObjs.length) {
			log.debug('larvitsmpp: lib/session.js: checkLongSmses() - All parts accounted for in smsGroupId "' + smsGroupId + '", emitting sms event.');

			smsObj = {
				// These are needed for references here and there in functions
				'session':    that,
				'smsGroupId': smsGroupId,
				'pduObjs':    smsGroup.pduObjs,
				'from':       smsGroup.pduObjs[0].pduObj.params.source_addr,
				'to':         smsGroup.pduObjs[0].pduObj.params.destination_addr,
				'submitTime': new Date(),
				'message':    '',
				'dlr':        Boolean(smsGroup.pduObjs[0].pduObj.params.registered_delivery),
				'sendResp':   smsResp,
				'sendDlr':    utils.smsDlr
			};

			// Concatenate all the parts messages to one and set references to the session

			// First we need to sort the parts, since they can come in random order
			smsObj.pduObjs.sort(sortLongSmsPdus);

			i = 0;
			while (smsObj.pduObjs[i] !== undefined) {
				curPduObj         = smsObj.pduObjs[i].pduObj;
				curPduObj.session = this;

				smsObj.message += utils.decodeMsg(curPduObj.params.short_message, curPduObj.params.data_coding, udhSize + 1);

				i ++;
			}
			smsReceived();
		} else if (moment(new Date()).diff(smsGroup.created, 'hours') > 24) {
			log.info('larvitsmpp: lib/session.js: checkLongSmses() - smsGroupId "' + smsGroupId + '" is removed from this.longSmses due to being older than 24 hours.');

			delete this.longSmses[smsGroupId];
		}
	}
}

/**
 * Generic session function
 *
 * @param {object} sock - socket object
 * @return {object} (returnObj)
 */
function session(sock) {
	var returnObj = new events.EventEmitter();

	log.silly('larvitsmpp: lib/session.js: session() - New session started from ' + sock.remoteAddress + ':' + sock.remotePort);

	returnObj.loggedIn = false;

	// Sequence number used for commands initiated from us
	returnObj.ourSeqNr = 1;

	// Make the socket transparent via the returned emitter
	returnObj.sock = sock;

	returnObj.incOurSeqNr = incOurSeqNr;
	returnObj.closeSocket = closeSocket;
	returnObj.sockWrite   = sockWrite;
	returnObj.send        = send;
	returnObj.sendReturn  = sendReturn;
	returnObj.sendSms     = sendSms;
	returnObj.utils       = utils;

	// Temporary storage for long sms parts
	// These should be cleared if they linger to long to avoid memory leaks
	returnObj.longSmses = {};

	// Temporary storage for DLRs to long SMSes
	// We keep them like this to be able to simulate a single DLR when all parts have gotten DLRs
	returnObj.longSmsDlrs = {};

	returnObj.sendLongSms    = sendLongSms;
	returnObj.longSms        = longSms;
	returnObj.checkLongSmses = checkLongSmses;

	// Handle incomming commands.
	// This is intended to be extended
	returnObj.handleCmd = {};

	// Handle incoming deliver_sm
	returnObj.handleCmd.deliver_sm = function(pduObj) {
		var dlrObj;

		// TLV message_state must exists
		if (pduObj.tlvs.message_state === undefined) {
			log.info('larvitsmpp: lib/session.js: session() - returnObj.handleCmd.deliver_sm() - TLV message_state is missing. SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		// TLV message_state needs to be valid
		if (defs.constsById.MESSAGE_STATE[pduObj.tlvs.message_state.tagValue] === undefined) {
			log.info('larvitsmpp: lib/session.js: session() - returnObj.handleCmd.deliver_sm() - Invalid TLV message_state: "' + pduObj.tlvs.message_state.tagValue + '". SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		// TLV receipted_message_id must exist
		if (pduObj.tlvs.receipted_message_id === undefined) {
			log.info('larvitsmpp: lib/session.js: session() - returnObj.handleCmd.deliver_sm() - TLV receipted_message_id is missing. SeqNr: ' + pduObj.seqNr);
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

		log.silly('larvitsmpp: lib/session.js: session() - returnObj.handleCmd.submit_sm() - ran');

		// If esm_class is 0x40 it means this is just a part of a larger message
		//if (pduObj.params.esm_class === 0x40) {
		// Fix: esm_class can be combination of bits. We need to extract 0x40 and then compare
		if ((pduObj.params.esm_class & 0x40) === 0x40) {
			log.debug('larvitsmpp: lib/session.js: session() - returnObj.handleCmd.submit_sm() - long sms detected, esm_class 0x40.');
			returnObj.longSms(pduObj);
			return; // Long messages should not get handled here at all, so cancel execution here
		}

		smsObj = {

			// These are needed for references here and there in functions
			'session':    returnObj,
			'pduObjs':    [{'pduObj': pduObj}],
			'from':       pduObj.params.source_addr,
			'to':         pduObj.params.destination_addr,
			'submitTime': new Date(),
			'message':    pduObj.params.short_message,
			'dlr':        Boolean(pduObj.params.registered_delivery),
			'sendResp':   smsResp,
			'sendDlr':    utils.smsDlr
		};

		if (pduObj.params.data_coding === 0x10) {
			smsObj.flash = true;
		}

		log.silly('larvitsmpp: lib/session.js: session() - returnObj.handleCmd.submit_sm() - Emitting sms object');

		returnObj.emit('sms', smsObj);
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

		log.debug('larvitsmpp: lib/session.js: session() - sock.on(data) - Incoming data: ' + data.toString('hex'));

		// Add this data to the dataQueue for processing
		returnObj.dataQueue = Buffer.concat([returnObj.dataQueue, data]);

		// Process queue
		while (returnObj.dataQueue.length > 4) {
			// Get this commands length
			cmdLength = parseInt(returnObj.dataQueue.readUInt32BE(0));
			log.silly('larvitsmpp: lib/session.js: session() - sock.on(data) - Processing ' + cmdLength + ' bytes of data');

			// If there is at least enough bytes in the dataQueue to fill this PDU, do it!
			if (cmdLength <= returnObj.dataQueue.length) {
				log.silly('larvitsmpp: lib/session.js: session() - sock.on(data) - Full PDU found in dataQueue, processing ' + cmdLength + ' bytes of queue total ' + returnObj.dataQueue.length + ' bytes');

				// Slice up the dataQueue buffer to this commands length
				pdu = returnObj.dataQueue.slice(0, cmdLength);

				// Slice off the command from the dataQueue
				returnObj.dataQueue = returnObj.dataQueue.slice(cmdLength, returnObj.dataQueue.length);

				returnObj.emit('incomingPdu', pdu);
			} else {
				log.debug('larvitsmpp: lib/session.js: session() - sock.on(data) - Tried to process ' + cmdLength + ' bytes, but only ' + returnObj.dataQueue.length + ' bytes found. Awaiting more data. Current data in queue: ' + returnObj.dataQueue.toString('hex'));

				break;
			}

			if (returnObj.dataQueue.length === 0) {
				log.silly('larvitsmpp: lib/session.js: session() - sock.on(data) - All queue handled, breaking while loop.');
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

				if (pduObj.isResp()) {
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

	sock.on('error', function() {
		log.warn('larvitsmpp: lib/session.js: session() - sock.on(error) - Socket error detected!');
		if (returnObj.enqLinkTimer) {
			log.debug('larvitsmpp: lib/session.js: session() - sock.on(error) - enqLinkTimer found, clearing.');
			clearTimeout(returnObj.enqLinkTimer);
		}
	});

	return returnObj;
}

// Expose some functions
exports = module.exports = session;
