# Larv IT SMPP

This is a simplified implementation of the SMPP protocol.

## Client

### Simplest possible

This will setup a client that connects to localhost, port 2775 without username or password and send a message.

    var larvitsmpp = require('larvitsmpp');

    larvitsmpp.client(function(err, clientSession) {
    	clientSession.send({
    		'from': '46701113311',
    		'to': '46709771337',
    		'message': 'Hello world'
    	});

    	// Gracefully close connection
    	clientSession.unbind();
    });

### Some connection parameters and DLR

This will setup a client that connects to given host, port with username and password, send a password and retrieve a DLR.

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

    		console.log('SMS sent, smsId: ' + smsId);
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

## Server

### Simplest possible

This will setup a password less server on localhost, port 2775 and console.log() incomming commands.

    var larvitsmpp = require('larvitsmpp');

    larvitsmpp.server(function(err, serverSession) {
        if (err) {
            throw err;
        }

        serverSession.on('data', function(data) {
            console.log('command: ' + data.command);
        });
    });

### Events

#### connect

Triggered when the socket is connected to a client

#### data

Triggered when data is comming in on the socket

#### close

Triggered when the socket is closed

#### error

Generic error event

## Advanced server

This example and its comments covers a lot of configuration options.

    var larvitsmpp = require('larvitsmpp');

    larvitsmpp.server(function(err, serverSession) {
    	if (err) {
    		throw err;
    	}

    	serverSession.on('data', function(data) {
    		console.log('command: ' + data.command);
    	});
    });
