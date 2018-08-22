'use strict';

const	topLogPrefix	= 'larvitsmpp: lib/client.js: ',
	session	= require(__dirname + '/session'),
	LUtils	= require('larvitutils'),
	merge	= require('utils-merge'),
	net	= require('net'),
	tls	= require('tls');

function login(options) {
	const	logPrefix	= topLogPrefix + 'login() - ',
		that	= this;

	let	loginPdu;

	loginPdu = {
		'cmdName':	'bind_transceiver',
		'seqNr':	that.ourSeqNr,
		'params': {
			'system_id':	that.options.username,
			'password':	that.options.password
		}
	};

	that.send(loginPdu, function (err, retPduObj) {
		if (err) return that.emit('loginFailed');

		if (retPduObj.cmdStatus === 'ESME_ROK') {
			options.log.info(logPrefix + 'Successful login system_id: "' + loginPdu.params.system_id + '"');
			that.loggedIn = true;
			that.emit('loggedIn');
		} else {
			options.log.info(logPrefix + 'Login failed system_id: "' + loginPdu.params.system_id + '". Status msg: ' + retPduObj.cmdStatus);
			that.emit('loginFailed');
		}
	});
}

function resetEnqLinkTimer() {
	const	logPrefix	= topLogPrefix + 'resetEnqLinkTimer() - ',
		that	= this;

	that.log.silly(logPrefix + 'Resetting the kill timer');
	if (that.enqLinkTimer) {
		clearTimeout(that.enqLinkTimer);
	}

	that.enqLinkTimer = setTimeout(function () {
		that.send({
			cmdName:	'enquire_link',
			seqNr:	that.ourSeqNr
		});
	}, that.options.enqLinkTiming);
}

/**
 * Client session function - inherits from session()
 *
 * @param {object} sock - socket object
 * @param {object} options - as derived from client()
 * @return {object} (returnObj)
 */
function clientSession(sock, options) {
	const	returnObj	= session({'sock': sock, 'log': options.log}),
		logPrefix	= topLogPrefix + 'clientSession() - ';

	returnObj.options	= options;
	returnObj.login	= login;
	returnObj.resetEnqLinkTimer	= resetEnqLinkTimer;

	returnObj.login({'log': options.log});
	returnObj.resetEnqLinkTimer({'log': options.log});

	// Handle incoming Pdu Objects
	returnObj.on('incomingPduObj', function (pduObj) {
		// Call the appropriate handleCmd function

		if (typeof returnObj.handleCmd[pduObj.cmdName] === 'function') {
			options.log.debug(logPrefix + 'returnObj.on(incomingPduObj) - Running cmd handling function returnObj.handleCmd.' + pduObj.cmdName + '()');

			returnObj.handleCmd[pduObj.cmdName](pduObj);
		} else {
			// No command handling function is registered, return error "invalid command"
			options.log.info(logPrefix + 'returnObj.on(incomingPduObj) - No handling function found for command: "' + pduObj.cmdName + '"');

			returnObj.sendReturn(pduObj, 'ESME_RINVCMDID');
		}
	});

	return returnObj;
}

/**
 * Setup a client.
 *
 * @param {object} options - host, port, username, password, tls, enqLinkTiming, log
 * @param {function} cb(err, session)
 */
function client(options, cb) {
	const	logPrefix	= topLogPrefix + 'client() - ';

	let	sock;

	if (typeof options === 'function') {
		cb	= options;
		options	= {};
	}

	// Set default options
	options = merge({
		'host':	'localhost',
		'port':	2775,
		'username':	'user',
		'password':	'pass',
		'tls':	false,
		'enqLinkTiming':	20000, // 20 sec
		'log': new (new LUtils()).Log()
	}, options || {});

	if (options && options.tls && options.tls === true) {
		sock	= new tls.Socket();
	} else {
		sock	= new net.Socket();
	}

	options.log.debug(logPrefix + 'Connecting to ' + options.host + ':' + options.port);
	sock.connect(options, function () {
		const	session	= clientSession(sock, options);

		options.log.info(logPrefix + 'Connected to ' + sock.remoteAddress + ':' + sock.remotePort);

		session.on('loggedIn', function () {
			cb(null, session);
		});

		session.on('loginFailed', function () {
			const	err	= new Error('Remote host refused login.');
			options.log.warn(logPrefix + err.message);
			cb(err);
		});
	});
}

// Expose some functions
exports = module.exports = client;
