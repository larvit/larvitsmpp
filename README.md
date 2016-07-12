[![Build Status](https://travis-ci.org/larvit/larvitsmpp.svg)](https://travis-ci.org/larvit/larvitsmpp)
[![Dependencies](https://david-dm.org/larvit/larvitsmpp.svg)](https://david-dm.org/larvit/larvitsmpp.svg)
[![Coverage Status](https://coveralls.io/repos/larvit/larvitsmpp/badge.svg)](https://coveralls.io/github/larvit/larvitsmpp)

# Larv IT SMPP

This is a simplified implementation of the SMPP protocol.

## Installation

```bash
npm install larvitsmpp
```

## Client

### Simplest possible

This will setup a client that connects to localhost, port 2775 without username or password and send a message.

```javascript
var larvitsmpp = require('larvitsmpp');

larvitsmpp.client(function(err, clientSession) {
	clientSession.sendSms({
		'from': '46701113311',
		'to': '46709771337',
		'message': 'Hello world'
	});

	// Gracefully close connection
	clientSession.unbind();
});
```

### Some connection parameters and DLR

This will setup a client that connects to given host, port with username and password, send a password and retrieve a DLR.

```javascript
larvitsmpp.client({
	'host': 'smpp.somewhere.com',
	'port': 2775,
	'username': 'foo',
	'password': 'bar'
}, function(err, clientSession) {
	if (err) {
		throw err;
	}

	clientSession.sendSms({
		'from': '46701113311',
		'to': '46709771337',
		'message': '«baff»',
		'dlr': true
	}, function(err, smsId, retPduObj) {
		if (err) {
			throw err;
		}

		console.log('Return PDU object:');
		console.log(retPduObj);
	});

	clientSession.on('dlr', function(dlr, dlrPduObj) {
		console.log('DLR received:');
		console.log(dlr);

		console.log('DLR PDU object:');
		console.log(dlrPduObj);

		// Gracefully close connection
		clientSession.unbind();
	});
});
```

## Server

### Simplest possible

This will setup a password less server on localhost, port 2775 and console.log() incomming commands.

```javascript
var larvitsmpp = require('larvitsmpp');

larvitsmpp.server(function(err, serverSession) {
	if (err) {
		throw err;
	}

	serverSession.on('data', function(data) {
		console.log('command: ' + data.command);
	});
});
```

### With auth, returning smsId and DLR

Example code below:

```javascript
// This should of course be replaced with your preferred auth system
function checkuserpass(username, password, callback) {
	if (username === 'foo' && password === 'bar') {
		// The last parameter is just user meta data that will be attached to the session as "userData" and is optional
		callback(null, true, {'username': 'foo', 'userId': 123});
	} else {
		callback(null, false);
	}
}

larvitsmpp.server({
	'checkuserpass': checkuserpass
}, function(err, serverSession) {
	if (err) {
		throw err;
	}

	// Incoming SMS!
	serverSession.on('sms', function(sms) {
		// It is important to run the sms.resp() since this is a part of the protocol
		sms.sendResp(
			// Status code
			// Default is ESME_ROK == no error
			// See SMPP spec for all available status codes
			// For example: ESME_RINVDSTADR == "Invalid destination address".
			'ESME_ROK'
		);

		// Oh, the sms sender wants a dlr (delivery report), send it!
		if (sms.dlr === true) {
			sms.sendDlr(); // Equalent to sms.sendDlr('DELIVERED');

			// To send a negative delivery report for example do:
			sms.sendDlr('UNDELIVERABLE');
			// Possible values are:
			// SCHEDULED
			// ENROUTE
			// DELIVERED <-- Default
			// EXPIRED
			// DELETED
			// UNDELIVERABLE
			// ACCEPTED
			// UNKNOWN
			// REJECTED
			// SKIPPED
		}
	});
});
```

## Session Events

#### connect

Triggered when the socket is connected to a client. This is server specific.

#### data

Triggered when data is comming in on the socket.

#### close

Triggered when the socket is closed.

#### error

Generic error event.

#### sms

Incoming SMS.

#### incomingPdu

Incoming PDU.

#### incomingPduObj

Incoming PDU Object. Same as incomingPdu, but it have been converted into an object instead of a buffer.

## Session commands

### send

Send a PDU to the remote.
