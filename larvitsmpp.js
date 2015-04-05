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
 * @param func callback(err, str) - str will be in utf8 format
 */
function decodeMsg(buffer, encoding, callback) {
	var err = null,
	    checkEnc;

	for (checkEnc in defs.consts.ENCODING) {
		if (parseInt(encoding) === defs.consts.ENCODING[checkEnc] || encoding === checkEnc) {
			encoding = checkEnc;
		}
	}

	if (defs.encodings[encoding] === undefined) {
		log.info('larvitsmpp: decodeMsg() - Invalid encoding "' + encoding + '" given. Falling back to ASCII (0x01).');
		encoding = 'ASCII';
	}

	callback(err, defs.encodings[encoding].decode(buffer));
}

function encodeMsg(str, callback) {
	var encoding = defs.encodings.detect(str),
	    err      = null,
	    buff;

  buff = defs.encodings[encoding].encode(str);

	callback(err, buff);
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
			retObj.params[param] = command.params[param].type.read(pdu, offset);

			// Short message seems to sometimes be terminated with a NULL and sometimes not. Very ugly and needs special care.
			if (param === 'short_message') {
				paramSize = command.params[param].type.size(pdu, offset);
			} else {
				paramSize = command.params[param].type.size(retObj.params[param]);
			}

			log.silly('larvitsmpp: pduToObj() - Reading param "' + param + '" at offset ' + offset + ' with calculated size: ' + paramSize + ' content in hex: ' + pdu.slice(offset, offset + paramSize).toString('hex'));

			// Increase the offset by the current params length
			offset += paramSize;
		} catch (e) {
			err = new Error('larvitsmpp: pduToObj() - Failed to read param "' + param + '": ' + e.message);
			callback(err);

			return;
		}
	}

	// If the length is greater than the current offset, there must be TLVs - resolve them!
	if (offset < retObj.cmdLength) {
		console.log('TLVs found yo! :D Implement us');
		console.log(pdu.length);
		console.log(retObj.cmdLength);
		console.log(offset);
		console.log(retObj);
		process.exit();

		tlvCmdId = pdu.readUInt16BE(offset);

		console.log('tlvCmdId:');
		console.log(tlvCmdId);
		process.exit();

		offset ++; //erh... not really, do something more nice! :)
	}

	// Decode the short message if it is set
	if (retObj.params.short_message !== undefined) {

		decodeMsg(retObj.params.short_message, retObj.params.data_coding, function(err, decodedMsg) {
			if (err) {
				callback(err);
				return;
			}

			retObj.params.short_message = decodedMsg;

			callback(null, retObj);
		});
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

	// Handle params - All command params should always exists, even if they do not contain data.
	for (param in defs.cmds[obj.cmdName].params) {

		// Get the parameter type, int, string, cstring etc.
		// This is needed so we can calculate length etc
		paramType = defs.cmds[obj.cmdName].params[param].type;

		// All params are mandatory. Set them if they are not set
		if (obj.params === undefined) {
			obj.params = {};
		}

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
 * Session function for the server
 *
 * @param obj sock - socket object
 * @param obj options - as derived from server()
 * @param func callback(err, sessionEmitter)
 */
function session(sock, options, callback) {
	var sessionEmitter = new events.EventEmitter(),
	    loggedIn       = false,
	    ourSeqNr       = 1, // Sequence number used for commands initiated from us
	    enqLinkTimer; // A timer used for keep alive of the session

	log.silly('larvitsmpp: session() - New session started from ' + sock.remoteAddress + ':' + sock.remotePort);

	// Make the socket transparent via the returned emitter
	sessionEmitter.sock = sock;

	/**
	 * Increase our sequence number
	 */
	function incOurSeqNr() {
		ourSeqNr ++;

		// If we pass the maximum, start over at 1
		if (ourSeqNr > 2147483646) {
			ourSeqNr = 1;
		}
	}

	/**
	 * Close the socket
	 * Always use this function to close the socket so we get it on log
	 */
	function closeSocket() {
		log.verbose('larvitsmpp: session() - closeSocket() - Closing socket for ' + sock.remoteAddress + ':' + sock.remotePort);
		if (enqLinkTimer) {
			clearTimeout(enqLinkTimer);
		}
		sock.destroy();
	}

	/**
	 * Send PDU to socket
	 *
	 * @param buf pdu - can also take PDU object
	 * @param bol closeAfterSend - if true will close the socket after sending
	 */
	function send(pdu, closeAfterSend) {
		if ( ! Buffer.isBuffer(pdu)) {
			objToPdu(pdu, function(err, buffer) {
				if (err) {
					log.warn('larvitsmpp: session() - send() - Could not convert PDU to buffer');
					closeSocket();
					return;
				}

				send(buffer);
			});
			return;
		}

		log.verbose('larvitsmpp: session() - send() - sending PDU. SeqNr: ' + pdu.readUInt32BE(12) + ' cmd: ' + defs.cmdsById[pdu.readUInt32BE(4)].command + ' cmdStatus: ' + defs.errorsById[parseInt(pdu.readUInt32BE(8))] + ' hex: ' + pdu.toString('hex'));
		sock.write(pdu);

		if (closeAfterSend) {
			closeSocket();
		}
	}

	/**
	 * Send a return to given PDU
	 *
	 * @param obj or buf pdu
	 * @param str status - see list at defs.errors - defaults to 'ESME_ROK' - no error
	 * @param bol closeAfterSend - if true will close the socket after sending (OPTIONAL)
	 * @param func callback(err)
	 */
	function sendReturn(pdu, status, closeAfterSend, callback) {
		if (typeof closeAfterSend === 'function') {
			callback       = closeAfterSend;
			closeAfterSend = undefined;
		}

		pduReturn(pdu, status, function(err, retPdu) {
			if (err) {
				log.error('larvitsmpp: session() - Could not create return PDU: ' + err.message);
				closeSocket();

				if (typeof callback === 'function') {
					callback(err);
				}

				return;
			}

			send(retPdu, closeAfterSend);

			if (typeof callback === 'function') {
				callback();
			}
		});
	}

	/**
	 * Try to log a connecting peer in
	 *
	 * @param obj pduObj
	 */
	function login(pduObj) {
		log.debug('larvitsmpp: session() - sock.on(data) - Data received and session is not loggedIn');

		// Pause socket so we do not receive any other commands until we have processed the login
		sock.pause();

		// Only bind_* is accepted when the client is not logged in
		if (pduObj.cmdName !== 'bind_transceiver' && pduObj.cmdName !== 'bind_receiver' && pduObj.cmdName !== 'bind_transmitter') {
			log.debug('larvitsmpp: session() - sock.on(data) - Session is not loggedIn and no bind_* command is given. Return error "ESME_RINVBNDSTS');

			pduReturn(pduObj, 'ESME_RINVBNDSTS', function(err, retPdu) {
				if (err) {
					closeSocket();
					return;
				}

				sock.resume();
				send(retPdu);
			});

			return;
		}

		// If there is a checkuserpass(), use it to check system_id and password from the PDU
		if (typeof options.checkuserpass === 'function') {
			options.checkuserpass(pduObj.params.system_id, pduObj.params.password, function(err, res) {
				if (err) {
					closeSocket();
					return;
				}

				if ( ! res) {
					log.info('larvitsmpp: session() - login() - Login failed! Connected host: ' + sock.remoteAddress + ':' + sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');

					sock.resume();
					sendReturn(pduObj, 'ESME_RBINDFAIL');
					return;
				}

				log.verbose('larvitsmpp: session() - login() - Login successful! Connected host: ' + sock.remoteAddress + ':' + sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');
				loggedIn = true;
				sock.resume();
				sendReturn(pduObj);
			});

			return;
		}

		// If we arrived here it means we are not logged in and that a bind_* event happened and no checkuserpass() method exists. Lets login!
		loggedIn = true;
		sock.resume();
		sendReturn(pduObj);
	}

	function handleResponse(pduObj) {
		console.log(pduObj);
		console.log('HANDLE IT motha fukkah!');
	}

	function deliverSm(pduObj) {
		console.log(pduObj);
		sendReturn(pduObj);
	}

	function submitSm(pduObj) {
		sessionEmitter.emit('sms', {
			'from':         pduObj.params.source_addr,
			'to':           pduObj.params.destination_addr,
			'message':      pduObj.params.short_message,
			'dlrRequested': Boolean(pduObj.params.registered_delivery),
			'seqNr':        pduObj.seqNr // Needed for DLR to be returned
		});
		sendReturn(pduObj);
	}

	/**
	 * Reset the enquire link timer
	 * If this is not ran within options.timeout milliseconds, this session will self terminate
	 */
	function resetEnqLinkTimer() {
		log.silly('larvitsmpp: session() - resetEnqLinkTimer() - Resetting the kill timer');
		if (enqLinkTimer) {
			clearTimeout(enqLinkTimer);
		}

		enqLinkTimer = setTimeout(function() {
			log.info('larvitsmpp: session() - resetEnqLinkTimer() - Closing session due to timeout');
			closeSocket();
		}, options.timeout);
	}
	resetEnqLinkTimer();

	function enquireLink(pduObj) {
		log.silly('larvitsmpp: session() - enquireLink() - Enquiring link');
		resetEnqLinkTimer();
		sendReturn(pduObj);
	}

	// Add a 'data' event handler to this instance of socket
	sock.on('data', function(pduBuf) {
		// Pass the data along to the sessionEmitter
		sessionEmitter.emit('data', pduBuf);

		log.silly('larvitsmpp: session() - sock.on(data) - Incoming PDU: ' + pduBuf.toString('hex'));

		pduToObj(pduBuf, function(err, pduObj) {
			if (err) {
				log.warn('larvitsmpp: session() - Invalid PDU. ' + err.message);

				sock.destroy();
			} else {
				log.verbose('larvitsmpp: session() - sock.on(data) - Incoming PDU. Seqnr: ' + pduObj.seqNr + ' cmd: ' + pduObj.cmdName + ' cmdStatus: ' + pduObj.cmdStatus + ' hex: ' + pduBuf.toString('hex'));

				if (loggedIn === false) {
					login(pduObj);
				} else if (pduObj.isResponse()) {
					handleResponse(pduObj);
				} else if (pduObj.cmdName === 'deliver_sm') {
					deliverSm(pduObj);
				} else if (pduObj.cmdName === 'enquire_link') {
					enquireLink(pduObj);
				} else if (pduObj.cmdName === 'submit_sm') {
					submitSm(pduObj);
				} else if (pduObj.cmdName === 'unbind') {
					sendReturn(pduObj, 'ESME_ROK', true);
				} else {
					// All other commands we do not support
					sendReturn(pduObj, 'ESME_RINVCMDID');
				}
			}
		});
  });

	// Add a 'close' event handler to this instance of socket
	sock.on('close', function() {
		sessionEmitter.emit('close');
		log.silly('larvitsmpp: session() - socket closed');
	});

	callback(null, sessionEmitter);
}

/**
 * Setup a server
 *
 * @param obj options - host, port, checkuserpass() etc (OPTIONAL)
 * @param func callback(session)
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
		// We have a connection - a socket object is assigned to the connection automatically
		log.verbose('larvitsmpp: server() - Incomming connection! From: ' + sock.remoteAddress + ':' + sock.remotePort);

		session(sock, options, callback);
	}).listen(options.port, options.host);

	log.info('larvitsmpp: server() - Up and running at ' + options.host + ':' + options.port);
}

/**
 * Setup a client
 *
 * @param obj options - host, port, username, password
 * @param func callback(err, connection)
 */
function client(options, callback) {
	var client = new net.Socket();

	// Set default options
	options = merge({
		'host': 'localhost',
		'port': 2775
	}, options || {});

	client.connect(options.port, options.host, function() {

		console.log('CONNECTED TO: ' + options.host + ':' + options.port);
		// Write a message to the socket as soon as the client is connected, the server will receive it as message from the client
		client.write('I am Chuck Norris!');
	});

	// Add a 'data' event handler for the client socket
	// data is what the server sent to this socket
	client.on('data', function(data) {

		console.log('DATA: ' + data);
		// Close the client socket completely
		client.destroy();

	});

	// Add a 'close' event handler for the client socket
	client.on('close', function() {
		console.log('Connection closed');
	});
}

// Expose some functions
exports.server    = server;
exports.client    = client;
exports.pduToObj  = pduToObj;
exports.objToPdu  = objToPdu;
exports.pduReturn = pduReturn;