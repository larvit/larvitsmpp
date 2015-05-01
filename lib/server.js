'use strict';

var log       = require('winston'),
    merge     = require('utils-merge'),
    net       = require('net'),
    session   = require('./session'),
    smppUtils = require('./utils');

/**
 * Server session function - inherits from session()
 *
 * @param obj sock - socket object
 * @param obj options - as derived from server()
 * @return obj (returnObj)
 */
function serverSession(sock, options) {
	var returnObj = session(sock);

	/**
	 * Try to log a connecting peer in
	 *
	 * @param obj pduObj
	 */
	returnObj.login = function(pduObj) {
		log.debug('larvitsmpp: lib/server.js: serverSession() - login() - Data received and session is not loggedIn');

		// Pause socket so we do not receive any other commands until we have processed the login
		returnObj.sock.pause();

		// Only bind_* is accepted when the client is not logged in
		if (pduObj.cmdName !== 'bind_transceiver' && pduObj.cmdName !== 'bind_receiver' && pduObj.cmdName !== 'bind_transmitter') {
			log.debug('larvitsmpp: lib/server.js: serverSession() - login()) - Session is not loggedIn and no bind_* command is given. Return error "ESME_RINVBNDSTS');

			smppUtils.pduReturn(pduObj, 'ESME_RINVBNDSTS', function(err, retPdu) {
				if (err) {
					returnObj.closeSocket();
					return;
				}

				returnObj.sock.resume();
				returnObj.sockWrite(retPdu);
			});

			return;
		}

		// If there is a checkuserpass(), use it to check system_id and password from the PDU
		if (typeof options.checkuserpass === 'function') {
			options.checkuserpass(pduObj.params.system_id, pduObj.params.password, function(err, res) {
				if (err) {
					returnObj.closeSocket();
					return;
				}

				if ( ! res) {
					log.info('larvitsmpp: lib/server.js: serverSession() - login() - Login failed! Connected host: ' + sock.remoteAddress + ':' + sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');

					returnObj.sock.resume();
					returnObj.sendReturn(pduObj, 'ESME_RBINDFAIL');
					return;
				}

				log.verbose('larvitsmpp: lib/server.js: serverSession() - login() - Login successful! Connected host: ' + sock.remoteAddress + ':' + sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');
				returnObj.loggedIn = true;
				returnObj.sock.resume();
				returnObj.sendReturn(pduObj);
			});

			return;
		}

		// If we arrived here it means we are not logged in and that a bind_* event happened and no checkuserpass() method exists. Lets login!
		returnObj.loggedIn = true;
		returnObj.sock.resume();
		returnObj.sendReturn(pduObj);
	};

	/**
	 * Reset the enquire link timer
	 * If this is not ran within options.timeout milliseconds, this session will self terminate
	 */
	returnObj.resetEnqLinkTimer = function() {
		log.silly('larvitsmpp: lib/server.js: serverSession() - resetEnqLinkTimer() - Resetting the kill timer');
		if (returnObj.enqLinkTimer) {
			clearTimeout(returnObj.enqLinkTimer);
		}

		returnObj.enqLinkTimer = setTimeout(function() {
			log.info('larvitsmpp: lib/server.js: serverSession() - resetEnqLinkTimer() - Closing session due to timeout');
			returnObj.closeSocket();
		}, options.timeout);
	};

	returnObj.resetEnqLinkTimer();

	returnObj.on('incomingPdu', function(pduObj) {
		if (pduObj.cmdName === 'unbind') {
			returnObj.sendReturn(pduObj, 'ESME_ROK', undefined, true);
		} else if (returnObj.loggedIn === false) {
			log.debug('larvitsmpp: lib/server.js: serverSession() - returnObj.handleIncomingPdu() - Not logged in, running login function');
			returnObj.login(pduObj);
		} else if (pduObj.cmdName === 'deliver_sm') {
			returnObj.deliverSm(pduObj);
		} else if (pduObj.cmdName === 'enquire_link') {
			returnObj.enquireLink(pduObj);
		} else if (pduObj.cmdName === 'submit_sm') {
			returnObj.submitSm(pduObj);
		} else {
			// All other commands we do not support
			returnObj.sendReturn(pduObj, 'ESME_RINVCMDID');
		}
	});

	return returnObj;
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
		log.verbose('larvitsmpp: lib/server.js: server() - Incomming connection! From: ' + sock.remoteAddress + ':' + sock.remotePort);

		callback(null, returnObj);
	}).listen(options.port, options.host);

	log.info('larvitsmpp: lib/server.js: server() - Up and running at ' + options.host + ':' + options.port);
}

// Expose some functions
exports = module.exports = server;