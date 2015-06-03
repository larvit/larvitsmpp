'use strict';

var larvitsmpp = require('../larvitsmpp'),
    assert     = require('assert'),
    portfinder = require('portfinder');

// Very advanced auth system
function checkuserpass(username, password, callback) {
	if (username === 'foo' && password === 'bar') {
		callback(null, true);
	} else {
		callback(null, false);
	}
}

describe('Sessions', function() {

	it('should setup a basic server and client and then directly unbinding again', function(done) {
		portfinder.getPort(function(err, freePort) {
			assert( ! err, 'Error should not be negative');

			larvitsmpp.server({
				'port': freePort
			}, function(err, serverSession) {
				assert( ! err, 'Error should not be negative');

				serverSession.on('close', function() {
					// Manually destroy the server socket
					serverSession.sock.destroy();
				});
			});

			larvitsmpp.client({
				'port': freePort
			}, function(err, clientSession) {
				assert( ! err, 'Error should not be negative');

				// Gracefully close connection
				clientSession.unbind();

				done();
			});
		});
	});

	it('should setup a server with auth and client trying to connect with wrong username and password', function(done) {
		portfinder.getPort(function(err, freePort) {
			assert( ! err, 'Error should not be negative');

			larvitsmpp.server({
				'port': freePort,
				'checkuserpass': checkuserpass
			}, function(err, serverSession) {
				assert( ! err, 'Error should not be negative');

				serverSession.on('close', function() {
					// Manually destroy the server socket
					serverSession.sock.destroy();
				});
			});

			larvitsmpp.client({
				'port': freePort
			}, function(err) {
				assert(err, 'Error should be set since login should have failed');

				done();
			});
		});
	});

	it('should setup a server with auth and client trying to connect with correct username and password', function(done) {
		portfinder.getPort(function(err, freePort) {
			assert( ! err, 'Error should not be negative');

			larvitsmpp.server({
				'port': freePort,
				'checkuserpass': checkuserpass
			}, function(err, serverSession) {
				assert( ! err, 'Error should not be negative');

				serverSession.on('close', function() {
					// Manually destroy the server socket
					serverSession.sock.destroy();
				});
			});

			larvitsmpp.client({
				'port': freePort,
				'username': 'foo',
				'password': 'bar'
			}, function(err, clientSession) {
				assert( ! err, 'Error should not be negative');

				// Gracefully close connection
				clientSession.unbind();

				done();
			});
		});
	});

	it('should try sending a simple sms', function(done) {
		portfinder.getPort(function(err, freePort) {
			assert( ! err, 'Error should not be negative');

			larvitsmpp.server({
				'port': freePort
			}, function(err, serverSession) {
				assert( ! err, 'Error should not be negative');

				serverSession.on('sms', function(sms) {
					sms.smsId = 2343;

					assert(sms.from === 'foo', 'SMS from should be "foo"');
					assert(sms.to === '46709771337', 'SMS to should be "46709771337"');
					assert(sms.message === 'hello world', 'SMS message should be "hello world"');
					assert(sms.dlr === false, 'DLR should be boolean false');
					assert(sms.pduObj.cmdId === 4, 'SMS pduObj cmdId should be 4');

					sms.sendResp(function(err, retPdus) {
						assert( ! err, 'Error should not be negative');

						assert(retPdus[0].toString('hex') === '000000158000000400000000000000023233343300', 'The return PDU should be "000000158000000400000000000000023233343300"');
					});
				});

				serverSession.on('close', function() {
					// Manually destroy the server socket
					serverSession.sock.destroy();
				});
			});

			larvitsmpp.client({
				'port': freePort
			}, function(err, clientSession) {
				assert( ! err, 'Error should not be negative');

				clientSession.sendSms({
					'from': 'foo',
					'to': '46709771337',
					'message': 'hello world'
				}, function(err, smsIds, retPduObj) {
					assert( ! err, 'Error should not be negative');

					assert(smsIds instanceof Array, 'smsIds should be an Array');
					assert(smsIds[0] === '2343', 'Given smsId should be "2343"');
					assert(retPduObj.cmdStatus === 'ESME_ROK', 'Command status should be "ESME_ROK"');
					assert(retPduObj.cmdName === 'submit_sm_resp', 'Command name should be "submit_sm_resp"');

					// Gracefully close connection
					clientSession.unbind();

					done();
				});
			});
		});
	});

	/*it('should try sending a long sms', function(done) {

	});*/

});