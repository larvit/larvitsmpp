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
	var parent = session(sock);

	parent.login = function() {
		var loginPdu = {
			'cmdName': 'bind_transceiver',
			'seqNr': parent.ourSeqNr,
			'params': {
				'system_id': options.username,
				'password': options.password
			}
		};

		parent.send(loginPdu, function(err, retPduObj) {
			if (err) {
				parent.emit('loginFailed');
				return;
			}

			if (retPduObj.cmdStatus === 'ESME_ROK') {
				log.info('larvitsmpp: lib/client.js: clientSession() - parent.login() - Successful login!');
				parent.loggedIn = true;
				parent.emit('loggedIn');
			} else {
				log.info('larvitsmpp: lib/client.js: clientSession() - parent.login() - Login failed. Status msg: ' + retPduObj.cmdStatus);
				parent.emit('loginFailed');
			}
		});
	};

	parent.resetEnqLinkTimer = function() {
		log.silly('larvitsmpp: lib/client.js: clientSession() - resetEnqLinkTimer() - Resetting the kill timer');
		if (parent.enqLinkTimer) {
			clearTimeout(parent.enqLinkTimer);
		}

		parent.enqLinkTimer = setTimeout(function() {
			parent.send({
				cmdName: 'enquire_link',
				seqNr: parent.ourSeqNr
			});
		}, options.enqLinkTiming);
	};

	parent.login();
	parent.resetEnqLinkTimer();

	parent.on('incomingPdu', function(pduObj) {
		if (pduObj.cmdName === 'deliver_sm') {
			parent.deliverSm(pduObj);
		} else if (pduObj.cmdName === 'enquire_link') {
			parent.enquireLink();
		} else if (pduObj.cmdName === 'submit_sm') {
			parent.submitSm(pduObj);
		} else if (pduObj.cmdName === 'unbind') {
			parent.sendReturn(pduObj, 'ESME_ROK', true);
		} else {
			// All other commands we do not support
			parent.sendReturn(pduObj, 'ESME_RINVCMDID');
		}
	});

	return parent;
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