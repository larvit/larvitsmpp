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

### With auth, returning smsId and DLR

Example code below:

    // This should of course be replaced with your preferred auth system
    function checkuserpass(username, password, callback) {
    	if (username === 'foo' && password === 'bar') {
    		callback(null, true);
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
    	serverSession.on('sms', function(sms, callback) {

    		// It is important to run the callback since this is a part of the protocol
    		callback({

    			// Decimal value status code
    			// Default is 0 == no error
    			// See SMPP spec for all available status codes
    			// For example: 11 == 0000000B == ESME_RINVDSTADR == "Invalid destination address".
    			'status': 0,

    			// Set SMS id, this is important if DLR is to be connected with the right SMS but is not mandatory
    			'smsId': 450
    		});

    		// Oh, the sms sender wants a dlr (delivery report), send it!
    		if (sms.dlr === true) {
    			serverSession.sendDlr(sms);

    			// To send a negative delivery report do:
    			//serverSession.sendDlr(sms, false);
    		}
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

#### sms

Incoming SMS