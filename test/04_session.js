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
	this.slow(2);

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
					assert(sms.pduObjs[0].pduObj.cmdId === 4, 'SMS pduObj cmdId should be 4');

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
				}, function(err, smsIds, retPduObjs) {
					assert( ! err, 'Error should not be negative');

					assert(smsIds instanceof Array, 'smsIds should be an Array');
					assert(smsIds[0] === '2343', 'Given smsId should be "2343"');
					assert(retPduObjs instanceof Array, 'retPduObjs should be an Array');
					assert(retPduObjs[0].cmdStatus === 'ESME_ROK', 'Command status should be "ESME_ROK"');
					assert(retPduObjs[0].cmdName === 'submit_sm_resp', 'Command name should be "submit_sm_resp"');

					// Gracefully close connection
					clientSession.unbind();

					done();
				});
			});
		});
	});

	it('should try sending a long sms', function(done) {
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
					assert(sms.message === 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industrys standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised.', 'SMS message should be correct');
					assert(sms.dlr === false, 'DLR should be boolean false');
					assert(sms.pduObjs[0].pduObj.cmdId === 4, 'SMS pduObj cmdId should be 4');

					sms.sendResp(function(err, retPdus) {
						assert( ! err, 'Error should not be negative');

						assert(retPdus[0].toString('hex') === '00000017800000040000000000000002323334332d3100', 'Return PDU 0 is wrong');
						assert(retPdus[1].toString('hex') === '00000017800000040000000000000003323334332d3200', 'Return PDU 1 is wrong');
						assert(retPdus[2].toString('hex') === '00000017800000040000000000000004323334332d3300', 'Return PDU 2 is wrong');
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
					'message': 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industrys standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised.'
				}, function(err, smsIds, retPduObjs) {
					assert( ! err, 'Error should not be negative');

					assert(smsIds instanceof Array, 'smsIds should be an Array');
					assert(smsIds[0] === '2343-1', 'First smsId should be "2343-1"');
					assert(smsIds[1] === '2343-2', 'Second smsId should be "2343-2"');
					assert(smsIds[2] === '2343-3', 'Third smsId should be "2343-3"');
					assert(smsIds[3] === undefined, 'Fourth smsId should be undefined');
					assert(retPduObjs[0].cmdStatus === 'ESME_ROK', 'Command status should be "ESME_ROK"');
					assert(retPduObjs[0].cmdName === 'submit_sm_resp', 'Command name should be "submit_sm_resp"');
					assert(retPduObjs[1].cmdStatus === 'ESME_ROK', 'Command status should be "ESME_ROK"');
					assert(retPduObjs[1].cmdName === 'submit_sm_resp', 'Command name should be "submit_sm_resp"');
					assert(retPduObjs[2].cmdStatus === 'ESME_ROK', 'Command status should be "ESME_ROK"');
					assert(retPduObjs[2].cmdName === 'submit_sm_resp', 'Command name should be "submit_sm_resp"');

					// Gracefully close connection
					clientSession.unbind();

					done();
				});
			});
		});
	});

	it('should send a long sms and receive dlrs for it', function(done) {
		portfinder.getPort(function(err, freePort) {
			assert( ! err, 'Error should not be negative');

			larvitsmpp.server({
				'port': freePort
			}, function(err, serverSession) {
				assert( ! err, 'Error should not be negative');

				serverSession.on('sms', function(sms) {
					sms.smsId = 2343;

					sms.sendResp(function(err) {
						assert( ! err, 'Error should not be negative');

						assert(sms.dlr === true, 'sms.dlr should be true');

						// Send the DLR(s)
						sms.sendDlr(true);
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
				var sentSmsId;

				assert( ! err, 'Error should not be negative');

				clientSession.on('dlr', function(dlr) {
					assert(dlr.statusMsg === 'DELIVERED', 'DLR statusMsg should be "DELIVERED"');
					assert(dlr.smsId.toString() === sentSmsId.toString(), 'SmsId should be "' + sentSmsId.toString() + '"');

					// Gracefully close connection
					clientSession.unbind();

					done();
				});

				clientSession.sendSms({
					'from': 'foo',
					'to': '46709771337',
					'message': 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industrys standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised.',
					'dlr': true
				}, function(err, smsIds, retPduObjs) {
					assert( ! err, 'Error should not be negative');

					assert(smsIds instanceof Array, 'smsIds should be an Array');
					assert(smsIds[0] === '2343-1', 'First smsId should be "2343-1"');
					assert(smsIds[1] === '2343-2', 'Second smsId should be "2343-2"');
					assert(smsIds[2] === '2343-3', 'Third smsId should be "2343-3"');
					assert(smsIds[3] === undefined, 'Fourth smsId should be undefined');
					assert(retPduObjs[0].cmdStatus === 'ESME_ROK', 'Command status should be "ESME_ROK"');
					assert(retPduObjs[0].cmdName === 'submit_sm_resp', 'Command name should be "submit_sm_resp"');
					assert(retPduObjs[1].cmdStatus === 'ESME_ROK', 'Command status should be "ESME_ROK"');
					assert(retPduObjs[1].cmdName === 'submit_sm_resp', 'Command name should be "submit_sm_resp"');
					assert(retPduObjs[2].cmdStatus === 'ESME_ROK', 'Command status should be "ESME_ROK"');
					assert(retPduObjs[2].cmdName === 'submit_sm_resp', 'Command name should be "submit_sm_resp"');

					// Save the SMS id to match the DLR for
					sentSmsId = smsIds[0].split('-')[0];
				});
			});
		});
	});

});