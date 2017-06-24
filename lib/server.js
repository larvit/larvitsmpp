'use strict';

var log       = require('winston'),
    merge	    = require('utils-merge'),
    net       = require('net'),
    tls       = require('tls'),
    session   = require('./session'),
    smppUtils = require('./utils');

/**
 * Try to log a connecting peer in
 *
 * @param obj pduObj
 */
function login(pduObj) {
	var that = this;

	log.debug('larvitsmpp: lib/server.js: login() - Data received and session is not loggedIn');

	// Pause socket so we do not receive any other commands until we have processed the login
	this.sock.pause();

	// Only bind_* is accepted when the client is not logged in
	if (pduObj.cmdName !== 'bind_transceiver' && pduObj.cmdName !== 'bind_receiver' && pduObj.cmdName !== 'bind_transmitter') {
		log.debug('larvitsmpp: lib/server.js: login() - Session is not loggedIn and no bind_* command is given. Return error "ESME_RINVBNDSTS');

		smppUtils.pduReturn(pduObj, 'ESME_RINVBNDSTS', function(err, retPdu) {
			if (err) {
				that.closeSocket();
				return;
			}

			that.sock.resume();
			that.sockWrite(retPdu);
		});

		return;
	}

	// If there is a checkuserpass(), use it to check system_id and password from the PDU
	if (typeof this.options.checkuserpass === 'function') {
		this.options.checkuserpass(pduObj.params.system_id, pduObj.params.password, function(err, res, userData) {
			if (err) {
				that.closeSocket();
				return;
			}

			if ( ! res) {
				log.info('larvitsmpp: lib/server.js: serverSession() - login() - Login failed! Connected host: ' + that.sock.remoteAddress + ':' + that.sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');

				that.sock.resume();
				that.sendReturn(pduObj, 'ESME_RBINDFAIL');
				return;
			}

			log.verbose('larvitsmpp: lib/server.js: serverSession() - login() - Login successful! Connected host: ' + that.sock.remoteAddress + ':' + that.sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');
			that.loggedIn = true;

			// Set additional user data to the session
			if (userData !== undefined) {
				that.userData = userData;
			}

			that.sock.resume();
			that.emit('login');
			that.sendReturn(pduObj);
		});

		return;
	}

	// If we arrived here it means we are not logged in and that a bind_* event happened and no checkuserpass() method exists. Lets login!
	this.loggedIn = true;
	this.sock.resume();
	this.emit('login');
	this.sendReturn(pduObj);
}

/**
 * Reset the enquire link timer
 * If this is not ran within options.timeout milliseconds, this session will self terminate
 */
function resetEnqLinkTimer() {
	var that = this;

	log.silly('larvitsmpp: lib/server.js: resetEnqLinkTimer() - Resetting the kill timer');
	if (that.enqLinkTimer) {
		clearTimeout(that.enqLinkTimer);
	}

	that.enqLinkTimer = setTimeout(function() {
		log.info('larvitsmpp: lib/server.js: resetEnqLinkTimer() - Closing session from ' + that.sock.remoteAddress + ':' + that.sock.remotePort + ' due to timeout');
		that.closeSocket();
	}, that.options.timeout);
}

/**
 * Server session function - inherits from session()
 *
 * @param obj sock - socket object
 * @param obj options - as derived from server()
 * @return obj (returnObj)
 */
function serverSession(sock, options) {
	var returnObj = session(sock);

	returnObj.options           = options;
	returnObj.login             = login;
	returnObj.resetEnqLinkTimer = resetEnqLinkTimer;

	returnObj.resetEnqLinkTimer();

	// Handle incoming Pdu Objects
	returnObj.on('incomingPduObj', function(pduObj) {
		// Call the appropriate handleCmd function

		// Unbind is always ok
		if (pduObj.cmdName === 'unbind') {
			returnObj.sendReturn(pduObj, 'ESME_ROK', undefined, true);

			// If client is not logged in, always run the login function
		} else if (returnObj.loggedIn === false) {
			log.debug('larvitsmpp: lib/server.js: serverSession() - returnObj.handleIncomingPdu() - Not logged in, running login function');
			returnObj.login(pduObj);

			// Client is logged in, try to match a handling function
		} else if (typeof returnObj.handleCmd[pduObj.cmdName] === 'function') {
			log.debug('larvitsmpp: lib/server.js: serverSession() - returnObj.on(incomingPduObj) - Running cmd handling function returnObj.handleCmd.' + pduObj.cmdName + '()');

			returnObj.handleCmd[pduObj.cmdName](pduObj);

			// No command handling function is registered, return error "invalid command"
		} else {
			log.info('larvitsmpp: lib/server.js: serverSession() - returnObj.on(incomingPduObj) - No handling function found for command: "' + pduObj.cmdName + '"');

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
	var tlsOrNet;

	if (typeof options === 'function') {
		callback = options;
		options  = {};
	}

	// Set default options
	options = merge({
		'port':    2775,
		'tls':     false,
		'timeout': 40000 // 40 sec
	}, options || {});

	if (options && options.tls && options.tls === true) {
		tlsOrNet = tls;
	} else {
		tlsOrNet = net;
	}

	// Create a server instance, and chain the listen function to it
	// The function passed to net.createServer() becomes the event handler for the 'connection' event
	// The sock object the callback function receives UNIQUE for each connection
	tlsOrNet.createServer(options, function(sock) {
		var returnObj = serverSession(sock, options);

		// We have a connection - a socket object is assigned to the connection automatically
		log.verbose('larvitsmpp: lib/server.js: server() - Incomming connection! From: ' + sock.remoteAddress + ':' + sock.remotePort);

		callback(null, returnObj);
	}).listen(options.port, options.host);

	if (options.host !== undefined) {
		log.info('larvitsmpp: lib/server.js: server() - Up and listening at ' + options.host + ':' + options.port);
	} else {
		log.info('larvitsmpp: lib/server.js: server() - Up and listening at *:' + options.port);
	}
}

// Expose some functions
exports = module.exports = server;
