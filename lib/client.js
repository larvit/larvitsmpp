'use strict';

var log     = require('winston'),
    merge   = require('utils-merge'),
    net     = require('net'),
    session = require('./session');

/**
 * Client session function - inherits from session()
 *
 * @param obj sock - socket object
 * @param obj options - as derived from client()
 * @return obj (returnObj)
 */
function clientSession(sock, options) {
	var returnObj = session(sock);

	returnObj.login = function() {
		var loginPdu = {
			'cmdName': 'bind_transceiver',
			'seqNr': returnObj.ourSeqNr,
			'params': {
				'system_id': options.username,
				'password': options.password
			}
		};

		returnObj.send(loginPdu, function(err, retPduObj) {
			if (err) {
				returnObj.emit('loginFailed');
				return;
			}

			if (retPduObj.cmdStatus === 'ESME_ROK') {
				log.info('larvitsmpp: lib/client.js: clientSession() - returnObj.login() - Successful login!');
				returnObj.loggedIn = true;
				returnObj.emit('loggedIn');
			} else {
				log.info('larvitsmpp: lib/client.js: clientSession() - returnObj.login() - Login failed. Status msg: ' + retPduObj.cmdStatus);
				returnObj.emit('loginFailed');
			}
		});
	};

	returnObj.resetEnqLinkTimer = function() {
		log.silly('larvitsmpp: lib/client.js: clientSession() - resetEnqLinkTimer() - Resetting the kill timer');
		if (returnObj.enqLinkTimer) {
			clearTimeout(returnObj.enqLinkTimer);
		}

		returnObj.enqLinkTimer = setTimeout(function() {
			returnObj.send({
				cmdName: 'enquire_link',
				seqNr: returnObj.ourSeqNr
			});
		}, options.enqLinkTiming);
	};

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

		log.info('larvitsmpp: lib/client.js: client() - Connected to ' + sock.remoteAddress + ':' + sock.remotePort);

		session.on('loggedIn', function() {
			callback(null, session);
		});

		session.on('loginFailed', function() {
			var err = new Error('larvitsmpp: lib/client.js: client() - Remote host refused login.');
			log.warn(err.message);
			callback(err);
		});
	});
}

// Expose some functions
exports = module.exports = client;