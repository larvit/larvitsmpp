'use strict';

const	topLogPrefix	= 'larvitsmpp: lib/server.js: ',
	smppUtils	= require(__dirname + '/utils'),
	session	= require(__dirname + '/session'),
	LUtils	= require('larvitutils'),
	lUtils	= new LUtils(),
	merge	= require('utils-merge'),
	net	= require('net'),
	tls	= require('tls');

/**
 * Try to log a connecting peer in
 *
 * @param {object} pduObj
 */
function login(pduObj) {
	const	logPrefix	= topLogPrefix + 'login() - ',
		that	= this;

	that.log.debug(logPrefix + 'Data received and session is not loggedIn');

	// Pause socket so we do not receive any other commands until we have processed the login
	that.sock.pause();

	// Only bind_* is accepted when the client is not logged in
	if (pduObj.cmdName !== 'bind_transceiver' && pduObj.cmdName !== 'bind_receiver' && pduObj.cmdName !== 'bind_transmitter') {
		that.log.debug(logPrefix + 'Session is not loggedIn and no bind_* command is given. Return error "ESME_RINVBNDSTS');

		smppUtils.pduReturn(pduObj, 'ESME_RINVBNDSTS', function (err, retPdu) {
			if (err) return that.closeSocket();

			that.sock.resume();
			that.sockWrite(retPdu);
		});

		return;
	}

	// If there is a checkuserpass(), use it to check system_id and password from the PDU
	if (typeof that.options.checkuserpass === 'function') {
		return that.options.checkuserpass(pduObj.params.system_id, pduObj.params.password, function (err, res, userData) {
			if (err) return that.closeSocket();

			if ( ! res) {
				that.log.info(logPrefix + 'Login failed! Connected host: ' + that.sock.remoteAddress + ':' + that.sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');

				that.sock.resume();
				return that.sendReturn(pduObj, 'ESME_RBINDFAIL');
			}

			that.log.verbose(logPrefix + 'Login successful! Connected host: ' + that.sock.remoteAddress + ':' + that.sock.remotePort + ' system_id: "' + pduObj.params.system_id + '"');
			that.loggedIn	= true;

			// Set additional user data to the session
			if (userData !== undefined) {
				that.userData	= userData;
			}

			that.sock.resume();
			that.emit('login');
			that.sendReturn(pduObj);
		});
	}

	// If we arrived here it means we are not logged in and that a bind_* event happened and no checkuserpass() method exists. Lets login!
	that.loggedIn	= true;
	that.sock.resume();
	that.emit('login');
	that.sendReturn(pduObj);
}

/**
 * Reset the enquire link timer
 * If this is not ran within options.timeout milliseconds, this session will self terminate
 */
function resetEnqLinkTimer() {
	const	logPrefix	= topLogPrefix	+ 'resetEnqLinkTimer() - ',
		that	= this;

	that.log.silly(logPrefix + 'Resetting the kill timer');
	if (that.enqLinkTimer) {
		clearTimeout(that.enqLinkTimer);
	}

	that.enqLinkTimer = setTimeout(function () {
		that.log.info(logPrefix + 'Closing session from ' + that.sock.remoteAddress + ':' + that.sock.remotePort + ' due to timeout');
		that.closeSocket();
	}, that.options.timeout);
}

/**
 * Server session function - inherits from session()
 *
 * @param {object} sock - socket object
 * @param {object} options - as derived from server()
 * @return {object} (returnObj)
 */
function serverSession(sock, options) {
	const	returnObj	= session({'sock': sock, 'log': options.log});

	returnObj.options	= options;
	returnObj.login	= login;
	returnObj.resetEnqLinkTimer	= resetEnqLinkTimer;
	returnObj.log	= options.log;

	returnObj.resetEnqLinkTimer();

	// Handle incoming Pdu Objects
	returnObj.on('incomingPduObj', function (pduObj) {
		const	logPrefix	= topLogPrefix + 'serverSession() - returnObj.handleIncomingPdu() - ';
		// Call the appropriate handleCmd function

		// Unbind is always ok
		if (pduObj.cmdName === 'unbind') {
			returnObj.sendReturn(pduObj, 'ESME_ROK', undefined, true);

			// If client is not logged in, always run the login function
		} else if (returnObj.loggedIn === false) {
			options.log.debug(logPrefix + ' Not logged in, running login function');
			returnObj.login(pduObj);

			// Client is logged in, try to match a handling function
		} else if (typeof returnObj.handleCmd[pduObj.cmdName] === 'function') {
			options.log.debug(logPrefix + 'Running cmd handling function returnObj.handleCmd.' + pduObj.cmdName + '()');

			returnObj.handleCmd[pduObj.cmdName](pduObj);

			// No command handling function is registered, return error "invalid command"
		} else {
			options.log.info(logPrefix + 'No handling function found for command: "' + pduObj.cmdName + '"');

			returnObj.sendReturn(pduObj, 'ESME_RINVCMDID');
		}
	});

	return returnObj;
}

/**
 * Setup a server
 *
 * @param {object} options - host, port, checkuserpass() etc (OPTIONAL), log
 * @param {function} cb(err, session)
 */
function server(options, cb) {
	const	logPrefix	= topLogPrefix + 'server() - ';

	let	tlsOrNet;

	if (typeof options === 'function') {
		cb	= options;
		options	= {};
	}

	// Set default options
	options = merge({
		'port':	2775,
		'tls':	false,
		'timeout':	40000, // 40 sec
		'log':	new lUtils.Log()
	}, options || {});

	if (options && options.tls && options.tls === true) {
		tlsOrNet	= tls;
	} else {
		tlsOrNet	= net;
	}

	// Create a server instance, and chain the listen function to it
	// The function passed to net.createServer() becomes the event handler for the 'connection' event
	// The sock object the cb function receives UNIQUE for each connection
	const serverConn = tlsOrNet.createServer(options, function (sock) {
		const	returnObj	= serverSession(sock, options);
		returnObj.serverConn = serverConn;

		// We have a connection - a socket object is assigned to the connection automatically
		options.log.verbose(logPrefix + 'Incoming connection! From: ' + sock.remoteAddress + ':' + sock.remotePort);

		cb(null, returnObj);
	}).listen(options.port, options.host);

	if (options.host !== undefined) {
		options.log.info(logPrefix + 'Up and listening at ' + options.host + ':' + options.port);
	} else {
		options.log.info(logPrefix + 'Up and listening at *:' + options.port);
	}
}

// Expose some functions
exports = module.exports = server;
