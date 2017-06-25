'use strict';

const	topLogPrefix	= 'larvitsmpp: lib/session.js: ',
	events	= require('events'),
	moment	= require('moment'),
	utils	= require('./utils'),
	async	= require('async'),
	defs	= require('./defs'),
	log	= require('winston');

/**
 * Send a response to an sms
 * This must be called from an sms object context
 *
 * @param {string} status - see list at defs.errors - defaults to 'ESME_ROK' - no error (OPTIONAL)
 * @param {function} cb - cb(err, [retPdu, ...])
 */
function smsResp(status, cb) {
	const	logPrefix	= topLogPrefix + 'smsResp() - ',
		tasks	= [],
		sms	= this;

	let	params;

	if (typeof status === 'function') {
		cb	= status;
		status	= true;
	}

	if (typeof cb !== 'function') {
		cb = function () {};
	}

	if (sms.smsId === undefined) {
		sms.smsId	= '';
	}

	// Accept a generic positive status
	if (status === 'true' || status === true || status === 0) {
		status	= 'ESME_ROK';
	}

	// Accept a generic negative status
	if (status === 'false' || status === false || status === 1) {
		status	= 'ESME_RUNKNOWNERR'; // Set to unknown error in this case
	}

	if (sms.pduObjs === undefined) {
		const	err	= new Error('No pdu objects found to base return PDU upon');
		log.warn(logPrefix + err.message);
		return cb(err);
	}

	// Build async tasks to run the responses in parallel
	for (let i = 0; sms.pduObjs[i] !== undefined; i ++) {
		if (sms.smsId) {
			if (sms.pduObjs[i].pduObj.params.esm_class === 0x40) {
				params	= {'message_id': sms.smsId + '-' + (i + 1)};
			} else {
				params	= {'message_id': sms.smsId};
			}
		} else {
			params	= {};
		}

		tasks[i] = sms.session.sendReturn.bind(
			sms.session,
			sms.pduObjs[i].pduObj,
			status,
			params,
			false
		);
	}

	async.parallel(tasks, cb);
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
	const	logPrefix	= topLogPrefix + 'closeSocket() - ';

	log.verbose(logPrefix + 'Closing socket for ' + this.sock.remoteAddress + ':' + this.sock.remotePort);
	if (this.enqLinkTimer) {
		log.debug(logPrefix + 'enqLinkTimer found, clearing.');
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
	const	logPrefix	= topLogPrefix + 'sockWrite() - ',
		that	= this;

	if ( ! Buffer.isBuffer(pdu)) {
		utils.objToPdu(pdu, function (err, buffer) {
			if (err) {
				log.warn(logPrefix + 'Could not convert PDU to buffer');
				return that.closeSocket();
			}

			that.sockWrite(buffer);
		});
		return;
	}

	try {
		log.verbose(logPrefix + 'sending PDU. SeqNr: ' + pdu.readUInt32BE(12) + ' cmd: ' + defs.cmdsById[pdu.readUInt32BE(4)].command + ' cmdStatus: ' + defs.errorsById[parseInt(pdu.readUInt32BE(8))] + ' hex: ' + pdu.toString('hex'));
	} catch (err) {
		log.error(logPrefix + 'PDU buffer is invalid. Buffer hex: "' + pdu.toString('hex') + '"');
		return;
	}

	that.sock.write(pdu);

	if (closeAfterSend) {
		that.closeSocket();
	}
}

/**
 * Send a PDU to the remote
 *
 * @param {buffer|object} pdu
 * @param {boolean} closeAfterSend - Will close after return is fetched. Defaults to false (OPTIONAL)
 * @param {function} cb - cb(err, retPdu) (OPTIONAL)
 */
function send(pdu, closeAfterSend, cb) {
	const	logPrefix	= topLogPrefix + 'send() - ',
		pduObj	= pdu,
		that	= this;

	// Make sure the pdu is an object
	if (Buffer.isBuffer(pdu)) {
		utils.pduToObj(pdu, function (err, pduObj) {
			if (err) return cb(err);

			that.send(pduObj, closeAfterSend, cb);
		});
		return;
	}

	// Make sure the sequence number is set and is correct
	pduObj.seqNr	= this.ourSeqNr;

	log.debug(logPrefix + 'Sending PDU to remote. pduObj: ' + JSON.stringify(pduObj));

	// If closeAndSend is omitted, put cb in its place
	if (typeof closeAfterSend === 'function') {
		cb	= closeAfterSend;
		closeAfterSend	= undefined;
	}

	// Make sure the callack is a function
	if (typeof cb !== 'function') {
		cb	= function () {};
	}

	// Response PDUs are not allowed with the send() command, they should use the sendReturn()
	if (pduObj.cmdName.substring(pduObj.cmdName - 5) === '_resp') {
		const	err = new Error('Given pduObj is a response, use sendReturn() instead. cmdName: ' + pduObj.cmdName);
		log.verbose(logPrefix + err.message);
		return cb(err);
	}

	// When the return is fetched, call the cb
	that.on('incomingPduObj' + pduObj.seqNr, function (incPduObj) {
		log.debug(logPrefix + 'this.on(incomingPduObj) - cmdName: ' + incPduObj.cmdName + ' seqNr: ' + incPduObj.seqNr + ' cmdStatus: ' + incPduObj.cmdStatus);

		// Make sure this is the actual response to the sent PDU
		if (incPduObj.isResp() && incPduObj.seqNr === pduObj.seqNr) {
			cb(null, incPduObj);

			if (closeAfterSend) {
				that.closeSocket();
			}
		} else {
			const	err = new Error('Event triggered but incoming PDU is not a response or seqNr does not match. isResp: ' + incPduObj.isResp().toString() + ' incSeqNr: ' + incPduObj.seqNr + ' expected seqNr: ' + pduObj.seqNr);
			log.warn(logPrefix + 'this.on(incomingPduObj) - ' + err.message);
			cb(err);
		}
	});

	// Increase our internal sequence number
	that.incOurSeqNr();

	// Write the PDU to socket
	that.sockWrite(pduObj);
}

/**
 * Send a return to given PDU
 *
 * @param {buffer|object} pdu
 * @param {string} status - see list at defs.errors - defaults to 'ESME_ROK' - no error (OPTIONAL)
 * @param {object} [params]
 * @param {boolean} closeAfterSend - if true will close the socket after sending (OPTIONAL)
 * @param {function} [cb(err, retPdu)]
 */
function sendReturn(pdu, status, params, closeAfterSend, cb) {
	const	logPrefix	= topLogPrefix + 'sendReturn() - ',
		that	= this;

	log.silly(logPrefix + 'ran');

	if (typeof params === 'function') {
		cb	= params;
		params	= undefined;
		closeAfterSend	= undefined;
	}

	if (typeof closeAfterSend === 'function') {
		cb	= closeAfterSend;
		closeAfterSend	= undefined;
	}

	if (typeof cb !== 'function') {
		cb	= function () {};
	}

	utils.pduReturn(pdu, status, params, function (err, retPdu) {
		if (err) {
			log.error(logPrefix + 'Could not create return PDU: ' + err.message);
			that.closeSocket();

			return cb(err);
		}

		log.silly(logPrefix + 'Sending return PDU: ' + retPdu.toString('hex'));
		that.sockWrite(retPdu, closeAfterSend);
		cb(null, retPdu);
	});
}

/**
 * Send an SMS
 *
 * @param {object}	smsOptions	{
 *			from	- alphanum or international format
 *			to	- international format
 *			message	- string
 *			dlr	- boolean defaults to false
 *			flash	- boolean defaults to false
 *		}
 * @param {function}	cb(err, smsIds, retPduObjs)
 */
function sendSms(smsOptions, cb) {
	const	logPrefix	= topLogPrefix	+ 'sendSms() - ',
		pduObj	= {};

	pduObj.cmdName	= 'submit_sm';
	pduObj.params  = {
		'source_addr_ton':	1, // Default to international format
		'source_addr':	smsOptions.from,
		'destination_addr':	smsOptions.to,
		'short_message':	smsOptions.message
	};

	// Flash messages overrides default data_coding
	if (smsOptions.flash) {
		log.debug(logPrefix + 'Flash SMS detected, set data_coding to 0x10!');
		pduObj.params.data_coding = 0x10;
	}

	// Request DLRs!
	if (smsOptions.dlr) {
		pduObj.params.registered_delivery = 0x01;
	}

	// Check if we must split this message into multiple
	if (utils.bitCount(smsOptions.message) > 1120) {
		log.debug(logPrefix + 'Message larger than 1120 bits, send it as long message!');

		this.sendLongSms(smsOptions, cb);

		return;
	}

	log.debug(logPrefix + 'pduObj: ' + JSON.stringify(pduObj));

	this.send(pduObj, function (err, retPduObj) {
		if (typeof cb === 'function') {
			cb(err, [retPduObj.params.message_id], [retPduObj]);
		}
	});
}

/**
 * Send a longer SMS than 1120 bits
 *
 * @param {object}	smsOptions	{
 *			from	- alphanum or international format
 *			to	- international format
 *			message	- string
 *			dlr	- boolean defaults to false
 *		}
 * @param {function}	cb - cb(err, smsId, retPduObj)
 */
function sendLongSms(smsOptions, cb) {
	const	retPduObjs	= [],
		logPrefix	= topLogPrefix + 'sendLongSms() - ',
		encoding	= defs.encodings.detect(smsOptions.message), // Set encoding once for all message parts
		smsIds	= [],
		that	= this,
		msgs       = utils.splitMsg(smsOptions.message);

	function sendPart(i) {
		const pduObj = {
			'cmdName':	'submit_sm',
			'params': {
				'source_addr_ton':	1, // Default to international format
				'esm_class':	0x40, // This indicates that there is a UDH in the short_message
				'source_addr':	smsOptions.from,
				'destination_addr':	smsOptions.to,
				'data_coding':	defs.consts.ENCODING[encoding],
				'short_message':	msgs[i],
				'sm_length':	msgs[i].length
			}
		};

		// Request DLRs!
		if (smsOptions.dlr) {
			pduObj.params.registered_delivery = 0x01;
		}

		log.debug(logPrefix + 'pduObj: ' + JSON.stringify(pduObj));

		that.send(pduObj, function (err, retPduObj) {
			smsIds.push(retPduObj.params.message_id);
			retPduObjs.push(retPduObj);

			log.silly(logPrefix + 'Got cb from that.send()');

			if (typeof cb === 'function' && smsIds.length === msgs.length) {
				log.silly(logPrefix + 'All cbs returned, run the parent cb.');
				cb(err, smsIds, retPduObjs);
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
	// Fix:	UDH values are stored in HEX and decoding them make it garbage. First OCTET contains
	//	the size of UDH data header. If UDH data header size is 0x05 then field 4 i.e. CSMS
	//	reference number is of one octet otherwise it consists of 2 octets. Other fields can
	//	be found from below reference.
	//	reference: https://en.wikipedia.org/wiki/Concatenated_SMS

	const	udhHeaderSize	= pduObj.params.short_message[0],	// First octet is the size of UDH Header
		headerSize	= pduObj.params.short_message[2],	// Header size other than first 2 octets
		csmsReference	= pduObj.params.short_message.slice(3, 3 + headerSize - 2),	// CSMS Reference starts from 4th octet and length is header size -2 octets
		partsCount	= pduObj.params.short_message[2 + csmsReference.length + 1],
		longSmsId	= pduObj.params.source_addr + '_' + pduObj.params.destination_addr + '_' + csmsReference,
		partNr	= pduObj.params.short_message[2 + csmsReference.length + 2],
		that	= this;

	if (that.longSmses[longSmsId] === undefined) {
		that.longSmses[longSmsId] = {
			'created':	new Date(),
			'partsCount':	partsCount,
			'udhSize':	udhHeaderSize,	// Saving udh size to remove garbage from message
			'pduObjs': [{
				'partNr':	partNr,	// We save this here to easier sort the array later on
				'pduObj':	pduObj
			}]
		};
	} else {
		that.longSmses[longSmsId].pduObjs.push({
			'partNr':	partNr, // We save this here to easier sort the array later on
			'pduObj':	pduObj
		});
	}

	// Check the long messages tmp storage to see if we should handle them
	that.checkLongSmses();
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
	const	logPrefix	= topLogPrefix	+ 'checkLongSmses() - ',
		smsObj	= {},
		that	= this;

	log.silly(logPrefix + 'Running');

	// Call when complete SMS is received
	function smsReceived() {
		that.emit('sms', smsObj);

		// This needs to be ran if DLRs are sent for these messages
		delete that.longSmses[smsObj.smsGroupId];
	}

	for (const smsGroupId in this.longSmses) {
		const	smsGroup	= this.longSmses[smsGroupId],
			udhSize	= smsGroup.udhSize;

		// All parts are accounted for! Emit sms event and clear from tmp storage
		if (smsGroup.partsCount === smsGroup.pduObjs.length) {
			log.debug(logPrefix + 'All parts accounted for in smsGroupId "' + smsGroupId + '", emitting sms event.');

			// These are needed for references here and there in functions
			smsObj.session	= that;
			smsObj.smsGroupId	= smsGroupId;
			smsObj.pduObjs	= smsGroup.pduObjs;
			smsObj.from	= smsGroup.pduObjs[0].pduObj.params.source_addr;
			smsObj.to	= smsGroup.pduObjs[0].pduObj.params.destination_addr;
			smsObj.submitTime	= new Date();
			smsObj.message	= '';
			smsObj.dlr	= Boolean(smsGroup.pduObjs[0].pduObj.params.registered_delivery);
			smsObj.sendResp	= smsResp;
			smsObj.sendDlr	= utils.smsDlr;

			// Concatenate all the parts messages to one and set references to the session

			// First we need to sort the parts, since they can come in random order
			smsObj.pduObjs.sort(sortLongSmsPdus);

			for (let i = 0; smsObj.pduObjs[i] !== undefined; i ++) {
				const	curPduObj	= smsObj.pduObjs[i].pduObj;

				curPduObj.session	= this;

				smsObj.message	+= utils.decodeMsg(curPduObj.params.short_message, curPduObj.params.data_coding, udhSize + 1);
			}
			smsReceived();
		} else if (moment(new Date()).diff(smsGroup.created, 'hours') > 24) {
			log.info(logPrefix + 'smsGroupId "' + smsGroupId + '" is removed from this.longSmses due to being older than 24 hours.');

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
	const	logPrefix	= topLogPrefix + 'session() - socket address: ' + sock.remoteAddress + ':' + sock.remotePort + ' - ',
		returnObj	= new events.EventEmitter();

	log.silly(logPrefix + 'New session started');

	returnObj.loggedIn	= false;
	returnObj.ourSeqNr	= 1;	// Sequence number used for commands initiated from us
	returnObj.sock	= sock;	// Make the socket transparent via the returned emitter
	returnObj.incOurSeqNr	= incOurSeqNr;
	returnObj.closeSocket	= closeSocket;
	returnObj.sockWrite	= sockWrite;
	returnObj.send	= send;
	returnObj.sendReturn	= sendReturn;
	returnObj.sendSms	= sendSms;
	returnObj.utils	= utils;

	// Temporary storage for long sms parts
	// These should be cleared if they linger to long to avoid memory leaks
	returnObj.longSmses	= {};

	// Temporary storage for DLRs to long SMSes
	// We keep them like this to be able to simulate a single DLR when all parts have gotten DLRs
	returnObj.longSmsDlrs	= {};

	returnObj.sendLongSms	= sendLongSms;
	returnObj.longSms	= longSms;
	returnObj.checkLongSmses	= checkLongSmses;

	// Handle incomming commands.
	// This is intended to be extended
	returnObj.handleCmd	= {};

	// Handle incoming deliver_sm
	returnObj.handleCmd.deliver_sm = function deliver_sm(pduObj) {
		const	thisLogPrefix	= logPrefix + 'deliver_sm() - ',
			dlrObj	= {};

		// TLV message_state must exists
		if (pduObj.tlvs.message_state === undefined) {
			log.info(thisLogPrefix + 'TLV message_state is missing. SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		// TLV message_state needs to be valid
		if (defs.constsById.MESSAGE_STATE[pduObj.tlvs.message_state.tagValue] === undefined) {
			log.info(thisLogPrefix + 'Invalid TLV message_state: "' + pduObj.tlvs.message_state.tagValue + '". SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		// TLV receipted_message_id must exist
		if (pduObj.tlvs.receipted_message_id === undefined) {
			log.info(thisLogPrefix + 'TLV receipted_message_id is missing. SeqNr: ' + pduObj.seqNr);
			returnObj.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		dlrObj.statusMsg	= defs.constsById.MESSAGE_STATE[pduObj.tlvs.message_state.tagValue];
		dlrObj.statusId	= pduObj.tlvs.message_state.tagValue;
		dlrObj.smsId	= pduObj.tlvs.receipted_message_id.tagValue;

		returnObj.emit('dlr', dlrObj, pduObj);
		returnObj.sendReturn(pduObj);
	};

	// Enquire link
	returnObj.handleCmd.enquire_link = function enquire_link(pduObj) {
		const	thisLogPrefix	= logPrefix + 'enquire_link() - ';

		log.silly(thisLogPrefix + 'Enquiring link');
		returnObj.resetEnqLinkTimer();
		returnObj.sendReturn(pduObj);
	};

	// Handle incoming submit_sm
	returnObj.handleCmd.submit_sm = function submit_sm(pduObj) {
		const	thisLogPrefix	= logPrefix + 'submit_sm() - ',
			smsObj	= {};

		log.silly(thisLogPrefix + 'ran');

		// If esm_class is 0x40 it means this is just a part of a larger message
		//if (pduObj.params.esm_class === 0x40) {
		// Fix: esm_class can be combination of bits. We need to extract 0x40 and then compare
		if ((pduObj.params.esm_class & 0x40) === 0x40) {
			log.debug(thisLogPrefix + 'long sms detected, esm_class 0x40.');
			returnObj.longSms(pduObj);
			return; // Long messages should not get handled here at all, so cancel execution here
		}

		// These are needed for references here and there in functions
		smsObj.session	= returnObj;
		smsObj.pduObjs	= [{'pduObj': pduObj}];
		smsObj.from	= pduObj.params.source_addr;
		smsObj.to	= pduObj.params.destination_addr;
		smsObj.submitTime	= new Date();
		smsObj.message	= pduObj.params.short_message;
		smsObj.dlr	= Boolean(pduObj.params.registered_delivery);
		smsObj.sendResp	= smsResp;
		smsObj.sendDlr	= utils.smsDlr;

		if (pduObj.params.data_coding === 0x10) {
			smsObj.flash	= true;
		}

		log.silly(thisLogPrefix + 'Emitting sms object');

		returnObj.emit('sms', smsObj);
	};

	// Handle incoming unbind
	returnObj.handleCmd.unbind = function unbind(pduObj) {
		returnObj.sendReturn(pduObj, 'ESME_ROK', undefined, true);
	};

	// Dummy, should be extended by serverSession or clientSession
	returnObj.login = function login() {
		const	thisLogPrefix	= logPrefix + 'login() - ';

		log.info(thisLogPrefix + 'Dummy login function ran, this might be a mistake');
		returnObj.loggedIn = true;
	};

	// Dummy method - should be used by serverSession or clientSession
	returnObj.resetEnqLinkTimer = function resetEnqLinkTimer() {
		const	thisLogPrefix	= logPrefix + 'resetEnqLinkTimer() - ';
		log.silly(thisLogPrefix + 'Resetting the kill timer');
	};

	// Unbind this session
	returnObj.unbind = function () {
		returnObj.send({
			'cmdName':	'unbind'
		}, true);
	};

	// Setup a data queue in case we only get partial data on the socket
	// This way we can concatenate them later on
	returnObj.dataQueue	= new Buffer(0);

	// Add a 'data' event handler to this instance of socket
	sock.on('data', function (data) {
		const	thisLogPrefix	= logPrefix + 'sock.on(data) - ';

		// Pass the data along to the returnObj
		returnObj.emit('data', data);

		// Reset the enquire link timer
		returnObj.resetEnqLinkTimer();

		log.debug(thisLogPrefix + 'Incoming data: ' + data.toString('hex'));

		// Add this data to the dataQueue for processing
		returnObj.dataQueue	= Buffer.concat([returnObj.dataQueue, data]);

		// Process queue
		while (returnObj.dataQueue.length > 4) {
			const	cmdLength	= parseInt(returnObj.dataQueue.readUInt32BE(0));	// Get this commands length

			let	pdu;

			log.silly(thisLogPrefix + 'Processing ' + cmdLength + ' bytes of data');

			// If there is at least enough bytes in the dataQueue to fill this PDU, do it!
			if (cmdLength <= returnObj.dataQueue.length) {
				log.silly(thisLogPrefix + 'Full PDU found in dataQueue, processing ' + cmdLength + ' bytes of queue total ' + returnObj.dataQueue.length + ' bytes');

				// Slice up the dataQueue buffer to this commands length
				pdu = returnObj.dataQueue.slice(0, cmdLength);

				// Slice off the command from the dataQueue
				returnObj.dataQueue = returnObj.dataQueue.slice(cmdLength, returnObj.dataQueue.length);

				returnObj.emit('incomingPdu', pdu);
			} else {
				log.debug(thisLogPrefix + 'Tried to process ' + cmdLength + ' bytes, but only ' + returnObj.dataQueue.length + ' bytes found. Awaiting more data. Current data in queue: ' + returnObj.dataQueue.toString('hex'));

				break;
			}

			if (returnObj.dataQueue.length === 0) {
				log.silly(thisLogPrefix + 'All queue handled, breaking while loop.');
				break;
			}

			// If the command length is larger than the queue, we need to wait for more data. Stop processing!
			if (cmdLength > returnObj.dataQueue) {
				log.debug(thisLogPrefix + 'Incomplete PDU found in dataQueue, waiting for more data to continue. Current cmdLength: ' + cmdLength + ' current queue: ' + returnObj.dataQueue.toString('hex'));
				break;
			}
		}
	});

	// Handle incoming Pdu Buffers
	returnObj.on('incomingPdu', function (pdu) {
		const	thisLogPrefix	= logPrefix + 'sock.on(incomingPdu) - ';

		utils.pduToObj(pdu, function (err, pduObj) {
			if (err) {
				log.warn(thisLogPrefix + 'Invalid PDU, closing socket.');

				returnObj.closeSocket();
			} else {
				log.verbose(thisLogPrefix + 'Incoming PDU parsed. Seqnr: ' + pduObj.seqNr + ' cmd: ' + pduObj.cmdName + ' cmdStatus: ' + pduObj.cmdStatus + ' hex: ' + pdu.toString('hex'));

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
	sock.on('close', function () {
		const	thisLogPrefix	= logPrefix + 'sock.on(close) - ';

		returnObj.emit('close');
		if (returnObj.enqLinkTimer) {
			log.debug(thisLogPrefix + 'enqLinkTimer found, clearing.');
			clearTimeout(returnObj.enqLinkTimer);
		}
		log.debug(thisLogPrefix + 'socket closed');
	});

	sock.on('error', function () {
		const	thisLogPrefix	= logPrefix + 'sock.on(error) - ';

		log.warn(thisLogPrefix + 'Socket error detected!');
		if (returnObj.enqLinkTimer) {
			log.debug(thisLogPrefix + 'enqLinkTimer found, clearing.');
			clearTimeout(returnObj.enqLinkTimer);
		}
	});

	return returnObj;
}

// Expose some functions
exports = module.exports = session;
