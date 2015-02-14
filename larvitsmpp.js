/**
 * SMPP Wrapper
 *
 * Error codes: http://www.activexperts.com/activsms/sms/smpperrorcodes/
 */
'use strict';

var log   = require('winston'),
    merge = require('utils-merge'),
    smpp  = require('smpp');

/**
 * Set up SMPP server
 *
 * The option "checkUserAndPass" should be a function, taking three parameters: username, password and callback(err)
 *
 * @param obj options
 *                   * port - what port to bind to, defaults to 2775
 *                   * checkUserAndPass - to require username and password to bind
 *                     to this server this should be a function, taking three
 *                     parameters: username, password and callback(err)
 *                   * timeout - number of ms before the link should be considered dead. Defaults to 30000 (30 sec)
 *
 */
exports.server = function(options) {
	options = merge({
		'port': 2775,
		'checkUserAndPass': false,
		'timeout': 30000
	}, options);

	smpp.createServer(function(smppSession) {
		var loggedIn = false,
		    killTimer;

		log.debug('larvitsmpp: server() - server session started');

		function resetKillTimer() {
			log.silly('larvitsmpp: server() - Resetting the kill timer');
			if (killTimer) {
				clearTimeout(killTimer);
			}

			killTimer = setTimeout(function() {
				log.warn('larvitsmpp: server() - Closing session due to timeout');
				smppSession.close();
			}, options.timeout);
		}
		resetKillTimer();

		/**
		 * Set logged in to true
		 */
		function login(pdu) {
			loggedIn = true;

			smppSession.send(pdu.response({
				'command_status': smpp.ESME_ROK
			}));

			smppSession.resume();
		}

		/**
		 * General bind function for bind_receiver, bind_transmitter and bind_transceiver
		 *
		 * @param obj pdu
		 */
		function bindGeneral(pdu) {
			if (options.checkUserAndPass instanceof Function) {
				// We pause the smppSession to prevent further incoming pdu events,
				// Untill we authorize the smppSession with some async operation.
				smppSession.pause();
				log.debug('larvitsmpp: server() - Checking username and password');

				options.checkUserAndPass(pdu.system_id, pdu.password, function(err) {
					if (err) {
						log.warn('larvitsmpp: server() - Wrong username or password. Username: "' + pdu.system_id + '"');

						smppSession.send(pdu.response({
							'command_status': smpp.ESME_RBINDFAIL
						}));
						smppSession.close();
						loggedIn = false;
						return;
					}

					log.debug('larvitsmpp: server() - Username and password is ok');
					login(pdu);
					smppSession.resume();
				});
			} else {
				login(pdu);
			}
		}

		smppSession.on('error', function() {
			log.error('larvitsmpp: server() - smppSession error!', arguments);
		});

		smppSession.on('pdu', function(pdu) {
			log.silly('larvitsmpp: server() - Received command "' + pdu.command + '"');

			resetKillTimer();

			if (pdu.command === 'bind_receiver' || pdu.command === 'bind_transmitter' || pdu.command === 'bind_transceiver') {
				bindGeneral(pdu);
			} else if (pdu.command !== 'enquire_link') {
				if (loggedIn) {
					log.error('larvitsmpp: server() - Unkown command!', pdu);

					console.log('PDU!!!!');
					console.log(arguments);
				} else {
					log.warn('larvitsmpp: server() - Not logged in but trying to send non-bind command');

					smppSession.send(pdu.response({
						'command_status': smpp.ESME_RSERTYPUNAUTH
					}));
				}
			}
		});

		smppSession.on('enquire_link', function(pdu) {
			log.silly('larvitsmpp: server() - Enquire_link - client heart beat.');

			smppSession.send(pdu.response({
				'command_status': smpp.ESME_ROK
			}));
		});
	}).listen(options.port);
};