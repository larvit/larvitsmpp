'use strict';

const test = require('tape');

const larvitsmpp = require(__dirname + '/../index.js');
const portfinder = require('portfinder');
const net = require('net');

// Very advanced auth system
function auth(username, password, cb) {
	if (username === 'foo' && password === 'bar') {
		cb(null, true);
	} else {
		cb(null, false);
	}
}

test('4. Sessions', t => t.end());

test('4.1. Should setup a basic server and client and then directly unbinding again', t => {
	portfinder.getPort((err, freePort) => {
		if (err) throw err;

		larvitsmpp.server({ port: freePort }, (err, serverSession) => {
			if (err) throw err;

			// Manually destroy the server socket
			serverSession.on('close', () => serverSession.sock.destroy());
		});

		larvitsmpp.client({ port: freePort }, (err, clientSession) => {
			if (err) throw err;

			// Gracefully close connection
			clientSession.unbind();

			t.end();
		});
	});
});

// test('should setup a server with auth and client trying to connect with wrong username and password', t => {
// 	portfinder.getPort((err, freePort) => {
// 		if (err) throw err;

// 		larvitsmpp.server({
// 			port: freePort,
// 			'auth': auth
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 			});
// 		});

// 		larvitsmpp.client({
// 			port: freePort
// 		}, function (err) {
// 			assert(err, 'Error should be set since login should have failed');

// 			t.end();
// 		});
// 	});
// });

// test('should setup a server with auth and client trying to connect with correct username and password', t => {
// 	portfinder.getPort((err, freePort) => {
// 		if (err) throw err;

// 		larvitsmpp.server({
// 			port: freePort,
// 			'auth': auth
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 			});
// 		});

// 		larvitsmpp.client({
// 			port: freePort,
// 			'username': 'foo',
// 			'password': 'bar'
// 		}, (err, clientSession) => {
// 			if (err) throw err;

// 			// Gracefully close connection
// 			clientSession.unbind();

// 			t.end();
// 		});
// 	});
// });

// test('should try sending a simple sms', t => {
// 	portfinder.getPort((err, freePort) => {
// 		if (err) throw err;

// 		larvitsmpp.server({
// 			port: freePort
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('sms', function (sms) {
// 				sms.smsId = 2343;

// 				assert.strictEqual(sms.from,	'foo');
// 				assert.strictEqual(sms.to,	'46709771337');
// 				assert.strictEqual(sms.message,	'hello world');
// 				assert.strictEqual(sms.dlr,	false);
// 				assert.strictEqual(sms.pduObjs[0].pduObj.cmdId,	4);

// 				sms.sendResp(function (err, retPdus) {
// 					if (err) throw err;

// 					assert.strictEqual(retPdus[0].toString('hex'),	'000000158000000400000000000000023233343300');
// 				});
// 			});

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 			});
// 		});

// 		larvitsmpp.client({
// 			port: freePort
// 		}, (err, clientSession) => {
// 			if (err) throw err;

// 			clientSession.sendSms({
// 				'from': 'foo',
// 				'to': '46709771337',
// 				'message': 'hello world'
// 			}, function (err, smsIds, retPduObjs) {
// 				if (err) throw err;

// 				assert(smsIds	instanceof Array, 'smsIds should be an Array');
// 				assert(retPduObjs	instanceof Array, 'retPduObjs should be an Array');
// 				assert.strictEqual(smsIds[0],	'2343');
// 				assert.strictEqual(retPduObjs[0].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[0].cmdName,	'submit_sm_resp');

// 				// Gracefully close connection
// 				clientSession.unbind();

// 				t.end();
// 			});
// 		});
// 	});
// });

// test('should try sending a long sms', t => {
// 	portfinder.getPort((err, freePort) => {
// 		if (err) throw err;

// 		larvitsmpp.server({
// 			port: freePort
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('sms', function (sms) {
// 				sms.smsId = 2343;

// 				assert.strictEqual(sms.from,	'foo');
// 				assert.strictEqual(sms.to,	'46709771337');
// 				assert.strictEqual(sms.message,	'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industrys standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised.');
// 				assert.strictEqual(sms.dlr,	false);
// 				assert.strictEqual(sms.pduObjs[0].pduObj.cmdId,	4);

// 				sms.sendResp(function (err, retPdus) {
// 					if (err) throw err;

// 					assert.strictEqual(retPdus[0].toString('hex'),	'00000017800000040000000000000002323334332d3100');
// 					assert.strictEqual(retPdus[1].toString('hex'),	'00000017800000040000000000000003323334332d3200');
// 					assert.strictEqual(retPdus[2].toString('hex'),	'00000017800000040000000000000004323334332d3300');
// 				});
// 			});

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 			});
// 		});

// 		larvitsmpp.client({
// 			port: freePort
// 		}, (err, clientSession) => {
// 			if (err) throw err;

// 			clientSession.sendSms({
// 				'from': 'foo',
// 				'to': '46709771337',
// 				'message': 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industrys standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised.'
// 			}, function (err, smsIds, retPduObjs) {
// 				if (err) throw err;

// 				assert(smsIds instanceof Array, 'smsIds should be an Array');
// 				assert.strictEqual(smsIds[0],	'2343-1');
// 				assert.strictEqual(smsIds[1],	'2343-2');
// 				assert.strictEqual(smsIds[2],	'2343-3');
// 				assert.strictEqual(smsIds[3],	undefined);
// 				assert.strictEqual(retPduObjs[0].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[0].cmdName,	'submit_sm_resp');
// 				assert.strictEqual(retPduObjs[1].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[1].cmdName,	'submit_sm_resp');
// 				assert.strictEqual(retPduObjs[2].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[2].cmdName,	'submit_sm_resp');

// 				// Gracefully close connection
// 				clientSession.unbind();

// 				t.end();
// 			});
// 		});
// 	});
// });

// test('should try sending a weirder long sms', t => {
// 	portfinder.getPort((err, freePort) => {
// 		if (err) throw err;

// 		larvitsmpp.server({
// 			port: freePort
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('sms', function (sms) {
// 				sms.smsId = 2344;

// 				assert.strictEqual(sms.from,	'foo');
// 				assert.strictEqual(sms.to,	'46709771337');
// 				assert.strictEqual(sms.message,	'K sKM8NYUuoVbORtCn€swWsvTZjbtYM1TceGJJouolLk4cOtlk7j dxWMI56Domdx2W!dHKjGBR5UsynmUnbp1ysRDCktBri WW2pxIWHv0P7H OVRZNw 6 DBzAqpnd7ZPslwNyi»x OuiNH0R!WM2DTo8ItysNDNe1eNnpLvahhRgv»TC y lvgFrmv4OiUTOP');
// 				assert.strictEqual(sms.dlr,	false);
// 				assert.strictEqual(sms.pduObjs[0].pduObj.cmdId,	4);

// 				sms.sendResp(function (err, retPdus) {
// 					if (err) throw err;

// 					assert.strictEqual(retPdus[0].toString('hex'), '00000017800000040000000000000002323334342d3100');
// 					assert.strictEqual(retPdus[1].toString('hex'), '00000017800000040000000000000003323334342d3200');
// 					assert.strictEqual(retPdus[2].toString('hex'), '00000017800000040000000000000004323334342d3300');
// 				});
// 			});

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 			});
// 		});

// 		larvitsmpp.client({
// 			port: freePort
// 		}, (err, clientSession) => {
// 			if (err) throw err;

// 			clientSession.sendSms({
// 				'from': 'foo',
// 				'to': '46709771337',
// 				'message': 'K sKM8NYUuoVbORtCn€swWsvTZjbtYM1TceGJJouolLk4cOtlk7j dxWMI56Domdx2W!dHKjGBR5UsynmUnbp1ysRDCktBri WW2pxIWHv0P7H OVRZNw 6 DBzAqpnd7ZPslwNyi»x OuiNH0R!WM2DTo8ItysNDNe1eNnpLvahhRgv»TC y lvgFrmv4OiUTOP'
// 			}, function (err, smsIds, retPduObjs) {
// 				if (err) throw err;

// 				assert(smsIds instanceof Array, 'smsIds should be an Array');
// 				assert.strictEqual(smsIds[0],	'2344-1');
// 				assert.strictEqual(smsIds[1],	'2344-2');
// 				assert.strictEqual(smsIds[2],	'2344-3');
// 				assert.strictEqual(smsIds[3],	undefined);
// 				assert.strictEqual(retPduObjs[0].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[0].cmdName,	'submit_sm_resp');
// 				assert.strictEqual(retPduObjs[1].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[1].cmdName,	'submit_sm_resp');
// 				assert.strictEqual(retPduObjs[2].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[2].cmdName,	'submit_sm_resp');

// 				// Gracefully close connection
// 				clientSession.unbind();

// 				t.end();
// 			});
// 		});
// 	});
// });

// test('should send a long sms and receive dlrs for it', t => {
// 	portfinder.getPort((err, freePort) => {
// 		if (err) throw err;

// 		larvitsmpp.server({
// 			port: freePort
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('sms', function (sms) {
// 				sms.smsId = 2343;

// 				sms.sendResp(function (err) {
// 					if (err) throw err;

// 					assert.strictEqual(sms.dlr, true);

// 					// Send the DLR(s)
// 					sms.sendDlr(true);
// 				});
// 			});

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 			});
// 		});

// 		larvitsmpp.client({
// 			port: freePort
// 		}, (err, clientSession) => {
// 			let	sentSmsId;

// 			if (err) throw err;

// 			clientSession.on('dlr', function (dlr) {
// 				assert.strictEqual(dlr.statusMsg,	'DELIVERED');
// 				assert.strictEqual(dlr.smsId.toString(),	sentSmsId.toString());

// 				// Gracefully close connection
// 				clientSession.unbind();

// 				t.end();
// 			});

// 			clientSession.sendSms({
// 				'from': 'foo',
// 				'to': '46709771337',
// 				'message': 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industrys standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised.',
// 				'dlr': true
// 			}, function (err, smsIds, retPduObjs) {
// 				if (err) throw err;

// 				assert(smsIds instanceof Array, 'smsIds should be an Array');
// 				assert.strictEqual(smsIds[0],	'2343-1');
// 				assert.strictEqual(smsIds[1],	'2343-2');
// 				assert.strictEqual(smsIds[2],	'2343-3');
// 				assert.strictEqual(smsIds[3],	undefined);
// 				assert.strictEqual(retPduObjs[0].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[0].cmdName,	'submit_sm_resp');
// 				assert.strictEqual(retPduObjs[1].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[1].cmdName,	'submit_sm_resp');
// 				assert.strictEqual(retPduObjs[2].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObjs[2].cmdName,	'submit_sm_resp');

// 				// Save the SMS id to match the DLR for
// 				sentSmsId = smsIds[0].spltest('-')[0];
// 			});
// 		});
// 	});
// });

// test('should verify dlr on readme example', t => {
// 	portfinder.getPort((err, freePort) => {
// 		if (err) throw err;

// 		larvitsmpp.server({
// 			port: freePort
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('sms', function (sms) {
// 				sms.smsId = 2343; // Random integer

// 				sms.sendResp(function (err) {
// 					if (err) throw err;

// 					assert.strictEqual(sms.dlr,	true);

// 					// Send the DLR(s)
// 					sms.sendDlr(true);
// 				});
// 			});

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 				t.end();
// 			});
// 		});

// 		larvitsmpp.client({
// 			port: freePort
// 		}, (err, clientSession) => {
// 			if (err) throw err;

// 			clientSession.on('dlr', function (dlr, dlrPduObj) {
// 				assert.strictEqual(dlr.statusMsg,	'DELIVERED');
// 				assert.strictEqual(dlr.statusId,	2);
// 				assert.strictEqual(parseInt(dlr.smsId),	2343);

// 				assert.strictEqual(dlrPduObj.params.short_message.substring(0, 36),	'id:2343 sub:001 dlvrd:1 submit date:');
// 				assert.strictEqual(dlrPduObj.params.short_message.substring(68),	'stat:DELIVRD err:0 text:xxx');
// 				assert.strictEqual(dlrPduObj.cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(dlrPduObj.cmdName,	'deliver_sm');

// 				// Gracefully close connection
// 				clientSession.unbind();
// 			});

// 			clientSession.sendSms({
// 				'from': '46701113311',
// 				'to': '46709771337',
// 				'message': '«baff»',
// 				'dlr': true
// 			}, function (err, smsId, retPduObj) {
// 				if (err) throw err;
// 				assert.strictEqual(parseInt(smsId[0]),	2343);
// 				assert.strictEqual(smsId[1],	undefined);
// 				assert.strictEqual(retPduObj[0].cmdStatus,	'ESME_ROK');
// 				assert.strictEqual(retPduObj[0].cmdName,	'submit_sm_resp');
// 			});
// 		});
// 	});
// });

// test('should test a session fetched from Kannel on long messages with large UDH', t => {
// 	portfinder.getPort((err, freePort) => {
// 		const sockInLog = [], // Log incomming socket messages
// 			sock = new net.Socket();

// 		if (err) throw err;

// 		sock.connect(freePort, 'localhost', () => {
// 			// bind_transceiver - initial call. Subsequent calls should be made on the sock.on('data') thingie
// 			sock.write(new Buffer('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
// 		});

// 		sock.on('data', function (data) {
// 			sockInLog.push(data.toString('hex'));

// 			if (sockInLog.length === 1) {
// 				assert.strictEqual(data.toString('hex'),	'0000001480000009000000000000002f666f6f00');

// 				// Send all 4 parts at the same time
// 				sock.write(new Buffer('000000de00000004000000000000003000050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204014c6f72656d20497073756d2069732073696d706c792064756d6d792074657874206f6620746865207072696e74696e6720616e64207479706573657474696e6720696e6475737472792e204c6f72656d20497073756d20686173206265656e2074686520696e6475737472792773207374616e646172642064756d6d79207465787420657665722073696e6365207468652031353030732c200426000101', 'hex'));
// 				sock.write(new Buffer('000000de00000004000000000000003100050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204027768656e20616e20756e6b6e6f776e207072696e74657220746f6f6b20612067616c6c6579206f66207479706520616e6420736372616d626c656420697420746f206d616b65206120747970652073706563696d656e20626f6f6b2e20497420686173207375727669766564206e6f74206f6e6c7920666976652063656e7475726965732c2062757420616c736f20746865206c65617020690426000101', 'hex'));
// 				sock.write(new Buffer('000000de00000004000000000000003200050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204036e746f20656c656374726f6e6963207479706573657474696e672c2072656d61696e696e6720657373656e7469616c6c7920756e6368616e6765642e2049742077617320706f70756c61726973656420696e207468652031393630732077697468207468652072656c65617365206f66204c657472617365742073686565747320636f6e7461696e696e67204c6f72656d20497073756d20700426000101', 'hex'));
// 				sock.write(new Buffer('000000b200000004000000000000003300050074657374000201313233343500430000003136303630373136333031333030302b000000000078050003020404617373616765732c20616e64206d6f726520726563656e746c792077697468206465736b746f70207075626c697368696e6720736f667477617265206c696b6520416c64757320506167654d616b657220696e636c7564696e672076657273696f6e73206f66204c6f72656d20497073756d', 'hex'));
// 			} else if (sockInLog.length === 2) {
// 				assert.strictEqual(data.toString('hex'),	'000000158000000400000000000000303233343300');
// 			} else if (sockInLog.length === 3) {
// 				// This is actually four different PDUs at the same time, marking the response on all four parts above
// 				assert.strictEqual(data.toString('hex'),	'000000158000000400000000000000313233343300000000158000000400000000000000323233343300000000158000000400000000000000333233343300');
// 				t.end();
// 			} else {
// 				throw new Error('To much data received');
// 			}
// 		});

// 		larvitsmpp.server({
// 			port: freePort
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('sms', function (sms) {
// 				assert.strictEqual(sms.message,	'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum');

// 				sms.smsId = 2343;

// 				sms.sendResp(function (err) {
// 					if (err) throw err;
// 				});
// 			});

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 			});
// 		});
// 	});
// });

// test('should test that a session can recreate SMS with random sequence', t => {
// 	portfinder.getPort((err, freePort) => {
// 		const sockInLog = [], // Log incomming socket messages
// 			sock = new net.Socket();

// 		if (err) throw err;

// 		sock.connect(freePort, 'localhost', () => {
// 			// bind_transceiver - initial call. Subsequent calls should be made on the sock.on('data') thingie
// 			sock.write(new Buffer('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
// 		});

// 		sock.on('data', function (data) {
// 			sockInLog.push(data.toString('hex'));

// 			if (sockInLog.length === 1) {
// 				assert.strictEqual(data.toString('hex'),	'0000001480000009000000000000002f666f6f00');

// 				// Send all 4 parts at the same time but random order
// 				// Message Part 2
// 				sock.write(new Buffer('000000de00000004000000000000003100050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204027768656e20616e20756e6b6e6f776e207072696e74657220746f6f6b20612067616c6c6579206f66207479706520616e6420736372616d626c656420697420746f206d616b65206120747970652073706563696d656e20626f6f6b2e20497420686173207375727669766564206e6f74206f6e6c7920666976652063656e7475726965732c2062757420616c736f20746865206c65617020690426000101', 'hex'));
// 				// Message Part 1
// 				sock.write(new Buffer('000000de00000004000000000000003000050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204014c6f72656d20497073756d2069732073696d706c792064756d6d792074657874206f6620746865207072696e74696e6720616e64207479706573657474696e6720696e6475737472792e204c6f72656d20497073756d20686173206265656e2074686520696e6475737472792773207374616e646172642064756d6d79207465787420657665722073696e6365207468652031353030732c200426000101', 'hex'));
// 				// Message Part 4
// 				sock.write(new Buffer('000000b200000004000000000000003300050074657374000201313233343500430000003136303630373136333031333030302b000000000078050003020404617373616765732c20616e64206d6f726520726563656e746c792077697468206465736b746f70207075626c697368696e6720736f667477617265206c696b6520416c64757320506167654d616b657220696e636c7564696e672076657273696f6e73206f66204c6f72656d20497073756d', 'hex'));
// 				// Message Part 3
// 				sock.write(new Buffer('000000de00000004000000000000003200050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204036e746f20656c656374726f6e6963207479706573657474696e672c2072656d61696e696e6720657373656e7469616c6c7920756e6368616e6765642e2049742077617320706f70756c61726973656420696e207468652031393630732077697468207468652072656c65617365206f66204c657472617365742073686565747320636f6e7461696e696e67204c6f72656d20497073756d20700426000101', 'hex'));
// 			} else if (sockInLog.length === 2) {
// 				assert.strictEqual(data.toString('hex'),	'000000158000000400000000000000303233343300');
// 			} else if (sockInLog.length === 3) {
// 				// This is actually four different PDUs at the same time, marking the response on all four parts above
// 				assert.strictEqual(data.toString('hex'),	'000000158000000400000000000000313233343300000000158000000400000000000000323233343300000000158000000400000000000000333233343300');
// 				t.end();
// 			} else {
// 				throw new Error('To much data received');
// 			}
// 		});

// 		larvitsmpp.server({
// 			port: freePort
// 		}, (err, serverSession) => {
// 			if (err) throw err;

// 			serverSession.on('sms', function (sms) {
// 				assert.strictEqual(sms.message,	'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum');

// 				sms.smsId = 2343;

// 				sms.sendResp(function (err) {
// 					if (err) throw err;
// 				});
// 			});

// 			serverSession.on('close', () => {
// 				// Manually destroy the server socket
// 				serverSession.sock.destroy();
// 			});
// 		});
// 	});
// });
