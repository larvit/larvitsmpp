'use strict';

var log     = require('winston'),
    merge   = require('utils-merge'),
    net     = require('net'),
    tls     = require('tls'),
    session = require('./session');

function login() {
	var that = this,
	    loginPdu;

	loginPdu = {
		'cmdName': 'bind_transceiver',
		'seqNr':   this.ourSeqNr,
		'params': {
			'system_id': this.options.username,
			'password':  this.options.password
		}
	};

	this.send(loginPdu, function(err, retPduObj) {
		if (err) {
			that.emit('loginFailed');
			return;
		}

		if (retPduObj.cmdStatus === 'ESME_ROK') {
			log.info('larvitsmpp: lib/client.js: login() - Successful login system_id: "' + loginPdu.params.system_id + '"');
			that.loggedIn = true;
			that.emit('loggedIn');
		} else {
			log.info('larvitsmpp: lib/client.js: login() - Login failed system_id: "' + loginPdu.params.system_id + '". Status msg: ' + retPduObj.cmdStatus);
			that.emit('loginFailed');
		}
	});
}

function resetEnqLinkTimer() {
	var that = this;

	log.silly('larvitsmpp: lib/client.js: resetEnqLinkTimer() - Resetting the kill timer');
	if (this.enqLinkTimer) {
		clearTimeout(this.enqLinkTimer);
	}

	this.enqLinkTimer = setTimeout(function() {
		that.send({
			cmdName: 'enquire_link',
			seqNr: that.ourSeqNr
		});
	}, this.options.enqLinkTiming);
}

/**
 * Client session function - inherits from session()
 *
 * @param obj sock - socket object
 * @param obj options - as derived from client()
 * @return obj (returnObj)
 */
function clientSession(sock, options) {
	var returnObj = session(sock);

	returnObj.options           = options;
	returnObj.login             = login;
	returnObj.resetEnqLinkTimer = resetEnqLinkTimer;

	returnObj.login();
	returnObj.resetEnqLinkTimer();

	// Handle incoming Pdu Objects
	returnObj.on('incomingPduObj', function(pduObj) {
		// Call the appropriate handleCmd function

		if (typeof returnObj.handleCmd[pduObj.cmdName] === 'function') {
			log.debug('larvitsmpp: lib/client.js: clientSession() - returnObj.on(incomingPduObj) - Running cmd handling function returnObj.handleCmd.' + pduObj.cmdName + '()');

			returnObj.handleCmd[pduObj.cmdName](pduObj);
		} else {
			// No command handling function is registered, return error "invalid command"
			log.info('larvitsmpp: lib/client.js: clientSession() - returnObj.on(incomingPduObj) - No handling function found for command: "' + pduObj.cmdName + '"');

			returnObj.sendReturn(pduObj, 'ESME_RINVCMDID');
		}
	});

	return returnObj;
}

/**
 * Setup a client
 *
 * @param obj options - host, port, username, password
 * @param func callback(err, session)
 */
function client(options, callback) {
	var sock;

	if (typeof options === 'function') {
		callback = options;
		options  = {};
	}

	// Set default options
	options = merge({
		'host':          'localhost',
		'port':          2775,
		'username':      'user',
		'password':      'pass',
		'tls':      	 false,
		'enqLinkTiming': 20000 // 20 sec
	}, options || {});

	if (options && options.tls && options.tls === true) {
		sock = new tls.Socket();
	} else {
		sock = new net.Socket();
	}

	log.debug('larvitsmpp: lib/client.js: client() - Connecting to ' + options.host + ':' + options.port);
	sock.connect(options, function() {
		var session = clientSession(sock, options);

		log.info('larvitsmpp: lib/client.js: client() - Connected to ' + sock.remoteAddress + ':' + sock.remotePort);

		session.on('loggedIn', function() {
			callback(null, session);
		});

		session.on('loginFailed', function() {
			var err = new Error('Remote host refused login.');
			log.warn('larvitsmpp: lib/client.js: client() - ' + err.message);
			callback(err);
		});
	});
}

// Expose some functions
exports = module.exports = client;
