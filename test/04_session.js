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