'use strict';

var larvitsmpp = require('../larvitsmpp'),
    assert     = require('assert'),
    portfinder = require('portfinder'),
    log        = require('winston');

// Remove log output to the console
log.remove(log.transports.Console);

// Very advanced auth system
function checkuserpass(username, password, callback) {
	if (username === 'foo' && password === 'bar') {
		callback(null, true);
	} else {
		callback(null, false);
	}
}

describe('PDU convertion', function() {

	describe('No TLVs', function() {
		it('should build a PDU buffer for bind_transceiver_resp with error correctly', function(done) {
			larvitsmpp.objToPdu({
				'cmdName': 'bind_transceiver_resp',
				'cmdStatus': 'ESME_RALYBND',
				'seqNr': 1
			}, function(err, pdu) {
				assert( ! err, 'Error should be negative');

				assert(pdu.readUInt32BE(0)               === 17,         'Command length should be 17, but is: "' + pdu.readUInt32BE(0) + '"');
				assert(pdu.readUInt32BE(4).toString(16)  === '80000009', 'Command ID should be 0x80000009');
				assert(pdu.readUInt32BE(8).toString(16)  === '5',        'Command status should be 0x00000005');
				assert(pdu.readUInt32BE(12).toString(10) === '1',        'Sequence number should be 1');

				done();
			});
		});

		it('should be able to do the above test and put it back to an object', function(done) {
			larvitsmpp.objToPdu({
				'cmdName': 'bind_transceiver_resp',
				'cmdStatus': 'ESME_RALYBND',
				'seqNr': 1
			}, function(err, pdu) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.pduToObj(pdu, function(err, obj) {
					assert( ! err, 'Error should be negative');

					assert(obj.cmdId.toString(16) === '80000009',     'Command ID should be 0x80000009');
					assert(obj.cmdStatus          === 'ESME_RALYBND', 'Command status should be "ESME_RALYBND"');
					assert(obj.seqNr              === 1,              'Sequence number should be 1');

					done();
				});
			});
		});

		it('should parse a PDU to obj correctly', function(done) {
			var pdu = new Buffer('0000002F000000020000000000000001534D50503354455354007365637265743038005355424D4954310000010100', 'hex');

			larvitsmpp.pduToObj(pdu, function(err, obj) {
				assert( ! err, 'Error should be negative');

				assert(obj.cmdId                    === 2,                  'Command ID should be 2');
				assert(obj.cmdStatus                === 'ESME_ROK',         'Command status should be "ESME_ROK"');
				assert(obj.cmdName                  === 'bind_transmitter', 'Command name should be "bind_transmitter"');
				assert(obj.params.system_id         === 'SMPP3TEST',        'system_id should be "SMPP3TEST"');
				assert(obj.params.interface_version === 0,                  'Interface version should be 0');

				done();
			});
		});

		it('should create a return PDU without error', function(done) {
			var pdu = new Buffer('0000002f000000020000000000000001534d50503354455354007365637265743038005355424d4954310000010100', 'hex');

			larvitsmpp.pduReturn(pdu, function(err, retPdu) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.pduToObj(retPdu, function(err, retObj) {
					assert( ! err, 'Error should be negative');

					assert(retObj.cmdId                    === 2147483650,              'Command ID should be 2147483650');
					assert(retObj.cmdStatus                === 'ESME_ROK',              'Command status should be "ESME_ROK"');
					assert(retObj.cmdName                  === 'bind_transmitter_resp', 'Command name should be "bind_transmitter_resp"');
					assert(retObj.params.system_id         === 'SMPP3TEST',             'system_id should be "SMPP3TEST"');

					done();
				});
			});
		});

		it('should read a submit_sm with an ending NULL octet to the short_message', function(done) {
			var pdu = new Buffer('0000003c0000000400000000000000020001003436373031313333313131000101343637303937373133333700000000000000000100047465737400', 'hex');

			larvitsmpp.pduToObj(pdu, function(err, obj) {
				assert( ! err, 'Error should be negative');

				assert(obj.params.short_message === 'test', 'Param short_message should read "test"');
				assert(obj.cmdLength            === 60,     'Command length should be 60, due to the trailing NULL octet');

				done();
			});
		});

		it('should read a submit_sm without an ending NULL octet to the short_message', function(done) {
			var pdu = new Buffer('0000003b00000004000000000000000200010034363730313133333131310001013436373039373731333337000000000000000001000474657374', 'hex');

			larvitsmpp.pduToObj(pdu, function(err, obj) {
				assert( ! err, 'Error should be negative');

				assert(obj.params.short_message === 'test', 'Param short_message should read "test"');
				assert(obj.cmdLength            === 59,     'Command length should be 59');

				done();
			});
		});

		it('should create a very simple submit_sm PDU', function(done) {
			larvitsmpp.objToPdu({
				'cmdName': 'submit_sm',
				'cmdStatus': 'ESME_ROK',
				'seqNr': 12,
				'params': {
					'source_addr': '46701113311',
					'destination_addr': '46709771337',
					'short_message': 'Hello world'
				}
			}, function(err, pdu) {
				assert( ! err, 'Error should be negative');

				assert(pdu.toString('hex') === '0000004200000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000001000b48656c6c6f20776f726c64');

				done();
			});
		});
	});

});

describe('Sessions', function() {

	it('should setup a basic server and client and then directly unbinding again', function(done) {
		portfinder.getPort(function(err, freePort) {
			assert( ! err, 'Error should be negative');

			larvitsmpp.server({
				'port': freePort
			}, function(err, serverSession) {
				assert( ! err, 'Error should be negative');

				serverSession.on('close', function() {
					// Manually destroy the server socket
					serverSession.sock.destroy();
				});
			});

			larvitsmpp.client({
				'port': freePort
			}, function(err, clientSession) {
				assert( ! err, 'Error should be negative');

				// Gracefully close connection
				clientSession.unbind();

				done();
			});
		});
	});

	it('should setup a server with auth and client trying to connect with wrong username and password', function(done) {
		portfinder.getPort(function(err, freePort) {
			assert( ! err, 'Error should be negative');

			larvitsmpp.server({
				'port': freePort,
				'checkuserpass': checkuserpass
			}, function(err, serverSession) {
				assert( ! err, 'Error should be negative');

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
			assert( ! err, 'Error should be negative');

			larvitsmpp.server({
				'port': freePort,
				'checkuserpass': checkuserpass
			}, function(err, serverSession) {
				assert( ! err, 'Error should be negative');

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
				assert( ! err, 'Error should be negative');

				// Gracefully close connection
				clientSession.unbind();

				done();
			});
		});
	});

	/*
	it('should try to send submit_sm while not logged in and get a failure return PDU back', function(done) {

	});

	it('should send a bind_transceiver to a new session and get logged in', function(done) {

	});

	it('should send a bind_transceiver to a new session with a login-method and fail due to wrong username and password', function(done) {

	});

	it('should send a bind_transceiver to a new session with a login-method and succeed with correct username and password', function(done) {

	});*/
});
