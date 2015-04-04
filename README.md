# Larv IT SMPP

This is a simplified implementation of the SMPP protocol. It only supports transciever mode and all messages are sent via the "data_sm" command.

## Client

This will setup a client that connects to localhost, port 2775 without username or password and send a message.

    var larvitsmpp = require('larvitsmpp');

    larvitsmpp.client(function(err, clientSession) {
    	clientSession.send({
    		'sender': 46701113311,
    		'receiver': 46709771337,
    		'message': 'Hello world'
    	}, function(err, res) {
    		if (err) {
    			throw err;
    		}

    		if (res) {
    			console.log('Woho! Message sent');
    		} else {
    			console.log('Server did not accept :(');
    		}
    	});

    	clientSession.close();
    });

## Server

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
