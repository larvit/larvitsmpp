"use strict";

const topLogPrefix = "larvitsmpp: lib/client.js: ";
const session = require(__dirname + "/session");
const LUtils = require("larvitutils");
const merge = require("utils-merge");
const net = require("net");
const tls = require("tls");

function login(options) {
	const logPrefix = topLogPrefix + "login() - ";
	const that = this;

	let loginPdu;

	loginPdu = {
		cmdName: "bind_transceiver",
		params: {
			password: that.options.password,
			system_id: that.options.username,
		},
		seqNr: that.ourSeqNr,
	};

	that.send(loginPdu, (err, retPduObj) => {
		if (err) return that.emit("loginFailed");

		if (retPduObj.cmdStatus === "ESME_ROK") {
			options.log.info(logPrefix + "Successful login system_id: \"" + loginPdu.params.system_id + "\"");
			that.loggedIn = true;
			that.emit("loggedIn");
		} else {
			options.log.info(logPrefix + "Login failed system_id: \"" + loginPdu.params.system_id + "\". Status msg: " + retPduObj.cmdStatus);
			that.emit("loginFailed");
		}
	});
}

function resetEnqLinkTimer() {
	const logPrefix = topLogPrefix + "resetEnqLinkTimer() - ";
	const that = this;

	that.log.silly(logPrefix + "Resetting the kill timer");
	if (that.enqLinkTimer) {
		clearTimeout(that.enqLinkTimer);
	}

	that.enqLinkTimer = setTimeout(() => {
		that.send({
			cmdName: "enquire_link",
			seqNr: that.ourSeqNr,
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
	const { log } = options;

	const returnObj = session({ log, sock });
	const logPrefix = topLogPrefix + "clientSession() - ";

	returnObj.options = options;
	returnObj.login = login;
	returnObj.resetEnqLinkTimer = resetEnqLinkTimer;

	returnObj.login({ log });
	returnObj.resetEnqLinkTimer({ log });

	// Handle incoming Pdu Objects
	returnObj.on("incomingPduObj", pduObj => {
		// Call the appropriate handleCmd function

		if (typeof returnObj.handleCmd[pduObj.cmdName] === "function") {
			options.log.debug(logPrefix + "returnObj.on(incomingPduObj) - Running cmd handling function returnObj.handleCmd." + pduObj.cmdName + "()");

			returnObj.handleCmd[pduObj.cmdName](pduObj);
		} else {
			// No command handling function is registered, return error "invalid command"
			options.log.info(logPrefix + "returnObj.on(incomingPduObj) - No handling function found for command: \"" + pduObj.cmdName + "\"");

			returnObj.sendReturn(pduObj, "ESME_RINVCMDID");
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
	const logPrefix = topLogPrefix + "client() - ";

	let sock;

	if (typeof options === "function") {
		cb = options;
		options = {};
	}

	// Set default options
	options = merge({
		enqLinkTiming: 20000, // 20 sec
		host: "localhost",
		log: new (new LUtils()).Log(),
		password: "pass",
		port: 2775,
		tls: false,
		username: "user",
	}, options || {});

	if (options && options.tls && options.tls === true) {
		sock = new tls.Socket();
	} else {
		sock = new net.Socket();
	}

	options.log.debug(logPrefix + "Connecting to " + options.host + ":" + options.port);
	sock.connect(options, () => {
		const session = clientSession(sock, options);

		options.log.info(logPrefix + "Connected to " + sock.remoteAddress + ":" + sock.remotePort);

		session.on("loggedIn", () => {
			cb(null, session);
		});

		session.on("loginFailed", () => {
			const err = new Error("Remote host refused login.");

			options.log.warn(logPrefix + err.message);
			cb(err);
		});
	});
}

// Expose some functions
exports = module.exports = client;
