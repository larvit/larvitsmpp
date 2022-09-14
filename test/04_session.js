'use strict';

const test = require('tape');

const larvitsmpp = require(__dirname + '/../index.js');
const net = require('net');
const LUtils = require('larvitutils');
const lUtils = new LUtils();
const log = new lUtils.Log('error');
const { findFreePort } = require('../test-utils/find-free-port.js');

// Very advanced auth system
function auth(username, password, cb) {
	if (username === 'foo' && password === 'bar') {
		cb(null, true);
	} else {
		cb(null, false);
	}
}

test('4. Sessions', t => t.end());

test('4.1. Should setup a basic server and client and then directly unbinding again', async t => {
	t.plan(1);

	const port = await findFreePort();

	await new Promise(resolve => {
		larvitsmpp.server({ port, log }, (err, serverSession) => {
			if (err) throw err;

			// Manually destroy the server socket
			serverSession.on('close', () => serverSession.serverConn.close());
		});

		larvitsmpp.client({ port, log }, (err, clientSession) => {
			if (err) throw err;

			t.true(true, 'Client is connected.');

			// Gracefully close connection
			clientSession.unbind();

			resolve();
		});
	});
});

test('4.2. Should setup a server with auth and client trying to connect with wrong username and password.', t => {
	findFreePort().then(port => {
		larvitsmpp.server({ port, auth, log }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('close', () => serverSession.serverConn.close());
		});

		larvitsmpp.client({ port, log }, (err, clientSession) => {
			t.notStrictEqual(err, undefined, 'Error should be set since login should have failed.');
			clientSession.unbind();

			t.end();
		});
	});
});

test('4.3. Should setup a server with auth and client trying to connect with correct username and password.', t => {
	findFreePort().then(port => {
		larvitsmpp.server({ log, port, auth }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('close', () => serverSession.serverConn.close());
		});

		larvitsmpp.client({ log, port, username: 'foo', password: 'bar' }, (err, clientSession) => {
			if (err) throw err;

			t.true(true, 'Client is connected.');

			clientSession.unbind();

			t.end();
		});
	});
});

test('4.4. Should try sending a simple sms.', t => {
	findFreePort().then(port => {
		larvitsmpp.server({ port, log }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('sms', sms => {
				sms.smsId = 2343;

				t.strictEqual(sms.from, 'foo', 'from -> foo');
				t.strictEqual(sms.to, '46709771337', 'to -> 46709771337');
				t.strictEqual(sms.message, 'hello world', 'message -> hello world');
				t.strictEqual(sms.dlr, false, 'dlr -> false');
				t.strictEqual(sms.pduObjs[0].pduObj.cmdId, 4, 'pduObjs[0].pduObj.cmdId -> 4');

				sms.sendResp(function (err, retPdus) {
					if (err) throw err;

					t.strictEqual(
						retPdus[0].toString('hex'),
						'000000158000000400000000000000023233343300',
						'Return PDU should be correct.',
					);
				});
			});

			serverSession.on('close', () => serverSession.serverConn.close());
		});

		larvitsmpp.client({ log, port }, (err, clientSession) => {
			if (err) throw err;

			clientSession.sendSms({
				from: 'foo',
				to: '46709771337',
				message: 'hello world'
			}, (err, smsIds, retPduObjs) => {
				if (err) throw err;

				t.true(smsIds instanceof Array, 'smsIds should be an Array');
				t.true(retPduObjs instanceof Array, 'retPduObjs should be an Array');
				t.strictEqual(smsIds[0], '2343', 'smsIds[0] -> 2343');
				t.strictEqual(retPduObjs[0].cmdStatus, 'ESME_ROK', 'retPduObjs[0].cmdStatus -> ESME_ROK');
				t.strictEqual(retPduObjs[0].cmdName, 'submit_sm_resp', 'retPduObjs[0].cmdName -> submit_sm_resp');

				// Gracefully close connection
				clientSession.unbind();

				t.end();
			});
		});
	});
});

test('4.5. Should try sending a long sms.', t => {
	const message = 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industrys standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised.';

	findFreePort().then(port => {
		larvitsmpp.server({ log, port }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('sms', sms => {
				sms.smsId = 2343;

				t.strictEqual(sms.from, 'foo');
				t.strictEqual(sms.to, '46709771337');
				t.strictEqual(sms.message, message);
				t.strictEqual(sms.dlr, false);
				t.strictEqual(sms.pduObjs[0].pduObj.cmdId, 4);

				sms.sendResp(function (err, retPdus) {
					if (err) throw err;

					t.strictEqual(retPdus[0].toString('hex'), '00000017800000040000000000000002323334332d3100');
					t.strictEqual(retPdus[1].toString('hex'), '00000017800000040000000000000003323334332d3200');
					t.strictEqual(retPdus[2].toString('hex'), '00000017800000040000000000000004323334332d3300');
				});
			});

			serverSession.on('close', () => serverSession.serverConn.close());
		});

		larvitsmpp.client({ log, port }, (err, clientSession) => {
			if (err) throw err;

			clientSession.sendSms({
				from: 'foo',
				to: '46709771337',
				message,
			}, (err, smsIds, retPduObjs) => {
				if (err) throw err;

				t.true(smsIds instanceof Array, 'smsIds should be an Array');
				t.strictEqual(smsIds[0], '2343-1');
				t.strictEqual(smsIds[1], '2343-2');
				t.strictEqual(smsIds[2], '2343-3');
				t.strictEqual(smsIds[3], undefined);
				t.strictEqual(retPduObjs[0].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[0].cmdName, 'submit_sm_resp');
				t.strictEqual(retPduObjs[1].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[1].cmdName, 'submit_sm_resp');
				t.strictEqual(retPduObjs[2].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[2].cmdName, 'submit_sm_resp');

				// Gracefully close connection
				clientSession.unbind();

				t.end();
			});
		});
	});
});

test('4.6. Should try sending a weirder long sms.', t => {
	findFreePort().then(port => {
		larvitsmpp.server({ log, port }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('sms', sms => {
				sms.smsId = 2344;

				t.strictEqual(sms.from, 'foo');
				t.strictEqual(sms.to, '46709771337');
				t.strictEqual(sms.message, 'K sKM8NYUuoVbORtCn€swWsvTZjbtYM1TceGJJouolLk4cOtlk7j dxWMI56Domdx2W!dHKjGBR5UsynmUnbp1ysRDCktBri WW2pxIWHv0P7H OVRZNw 6 DBzAqpnd7ZPslwNyi»x OuiNH0R!WM2DTo8ItysNDNe1eNnpLvahhRgv»TC y lvgFrmv4OiUTOP');
				t.strictEqual(sms.dlr, false);
				t.strictEqual(sms.pduObjs[0].pduObj.cmdId, 4);

				sms.sendResp(function (err, retPdus) {
					if (err) throw err;

					t.strictEqual(retPdus[0].toString('hex'), '00000017800000040000000000000002323334342d3100');
					t.strictEqual(retPdus[1].toString('hex'), '00000017800000040000000000000003323334342d3200');
					t.strictEqual(retPdus[2].toString('hex'), '00000017800000040000000000000004323334342d3300');
				});
			});

			serverSession.on('close', () => serverSession.serverConn.close());
		});

		larvitsmpp.client({ log, port }, (err, clientSession) => {
			if (err) throw err;

			clientSession.sendSms({
				from: 'foo',
				to: '46709771337',
				message: 'K sKM8NYUuoVbORtCn€swWsvTZjbtYM1TceGJJouolLk4cOtlk7j dxWMI56Domdx2W!dHKjGBR5UsynmUnbp1ysRDCktBri WW2pxIWHv0P7H OVRZNw 6 DBzAqpnd7ZPslwNyi»x OuiNH0R!WM2DTo8ItysNDNe1eNnpLvahhRgv»TC y lvgFrmv4OiUTOP'
			}, (err, smsIds, retPduObjs) => {
				if (err) throw err;

				t.true(smsIds instanceof Array, 'smsIds should be an Array');
				t.strictEqual(smsIds[0], '2344-1');
				t.strictEqual(smsIds[1], '2344-2');
				t.strictEqual(smsIds[2], '2344-3');
				t.strictEqual(smsIds[3], undefined);
				t.strictEqual(retPduObjs[0].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[0].cmdName, 'submit_sm_resp');
				t.strictEqual(retPduObjs[1].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[1].cmdName, 'submit_sm_resp');
				t.strictEqual(retPduObjs[2].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[2].cmdName, 'submit_sm_resp');

				// Gracefully close connection
				clientSession.unbind();

				t.end();
			});
		});
	});
});

test('4.7. Should send a long sms and receive dlrs for it.', t => {
	findFreePort().then(port => {
		larvitsmpp.server({ log, port }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('sms', sms => {
				sms.smsId = 2343;

				sms.sendResp(err => {
					if (err) throw err;

					t.strictEqual(sms.dlr, true);

					// Send the DLR(s)
					sms.sendDlr(true);
				});
			});

			serverSession.on('close', () => serverSession.serverConn.close());
		});

		larvitsmpp.client({ log, port }, (err, clientSession) => {
			let	sentSmsId;

			if (err) throw err;

			clientSession.on('dlr', function (dlr) {
				t.strictEqual(dlr.statusMsg, 'DELIVERED');
				t.strictEqual(dlr.smsId.toString(), sentSmsId.toString());

				// Gracefully close connection
				clientSession.unbind();

				t.end();
			});

			clientSession.sendSms({
				from: 'foo',
				to: '46709771337',
				message: 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industrys standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised.',
				dlr: true,
			}, (err, smsIds, retPduObjs) => {
				if (err) throw err;

				t.true(smsIds instanceof Array, 'smsIds should be an Array');
				t.strictEqual(smsIds[0], '2343-1');
				t.strictEqual(smsIds[1], '2343-2');
				t.strictEqual(smsIds[2], '2343-3');
				t.strictEqual(smsIds[3], undefined);
				t.strictEqual(retPduObjs[0].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[0].cmdName, 'submit_sm_resp');
				t.strictEqual(retPduObjs[1].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[1].cmdName, 'submit_sm_resp');
				t.strictEqual(retPduObjs[2].cmdStatus, 'ESME_ROK');
				t.strictEqual(retPduObjs[2].cmdName, 'submit_sm_resp');

				// Save the SMS id to match the DLR for
				sentSmsId = smsIds[0].split('-')[0];
			});
		});
	});
});

test('4.8. Should verify dlr on readme example.', t => {
	findFreePort().then(port => {
		larvitsmpp.server({ log, port }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('sms', sms => {
				sms.smsId = 2343; // Random integer

				sms.sendResp(err => {
					if (err) throw err;

					t.strictEqual(sms.dlr, true, 'sms.dlr -> true');

					// Send the DLR(s)
					sms.sendDlr(true);
				});
			});

			serverSession.on('close', () => serverSession.serverConn.close());
		});

		larvitsmpp.client({ log, port }, (err, clientSession) => {
			if (err) throw err;

			clientSession.on('dlr', function (dlr, dlrPduObj) {
				t.strictEqual(dlr.statusMsg, 'DELIVERED', 'dlr.statusMsg -> DELIVERED');
				t.strictEqual(dlr.statusId, 2, 'dlr.statusId -> 2');
				t.strictEqual(parseInt(dlr.smsId), 2343, 'dlr.smsId -> 2343');

				t.strictEqual(dlrPduObj.params.short_message.substring(0, 36), 'id:2343 sub:001 dlvrd:1 submit date:', 'Check dlr msg contents for id etc.');
				t.strictEqual(dlrPduObj.params.short_message.substring(68), 'stat:DELIVRD err:0 text:xxx', 'Check dlr msg stat err and text.');
				t.strictEqual(dlrPduObj.cmdStatus, 'ESME_ROK', 'cmdStatus -> ESME_ROK');
				t.strictEqual(dlrPduObj.cmdName, 'deliver_sm', 'cmdName -> deliver_sm');

				t.end();

				// Gracefully close connection
				clientSession.unbind();
			});

			clientSession.sendSms({
				from: '46701113311',
				to: '46709771337',
				message: '«baff»',
				dlr: true,
			}, function (err, smsId, retPduObj) {
				if (err) throw err;
				t.strictEqual(parseInt(smsId[0]), 2343, 'smsId[0] -> 2343');
				t.strictEqual(smsId[1], undefined, 'smsId[1] -> undefined');
				t.strictEqual(retPduObj[0].cmdStatus, 'ESME_ROK', 'retPduObj[0].cmdStatus -> ESME_ROK');
				t.strictEqual(retPduObj[0].cmdName, 'submit_sm_resp', 'retPduObj[0].cmdName -> submit_sm_resp');
			});
		});
	});
});

test('4.9. Should test a session fetched from Kannel on long messages with large UDH.', t => {
	t.plan(4);

	findFreePort().then(port => {
		console.log("PORT!!!!!!!", port);

		const sockInLog = []; // Log incomming socket messages
		const sock = new net.Socket();

		sock.connect(port, 'localhost', () => {
			// bind_transceiver - initial call. Subsequent calls should be made on the sock.on('data') thingie
			sock.write(Buffer.from('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
		});

		sock.on('data', data => {
			sockInLog.push(data.toString('hex'));

			if (sockInLog.length === 1) {
				t.strictEqual(data.toString('hex'), '0000001480000009000000000000002f666f6f00', '1st data hex should match.');

				// Send all 4 parts at the same time
				sock.write(Buffer.from('000000de00000004000000000000003000050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204014c6f72656d20497073756d2069732073696d706c792064756d6d792074657874206f6620746865207072696e74696e6720616e64207479706573657474696e6720696e6475737472792e204c6f72656d20497073756d20686173206265656e2074686520696e6475737472792773207374616e646172642064756d6d79207465787420657665722073696e6365207468652031353030732c200426000101', 'hex'));
				sock.write(Buffer.from('000000de00000004000000000000003100050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204027768656e20616e20756e6b6e6f776e207072696e74657220746f6f6b20612067616c6c6579206f66207479706520616e6420736372616d626c656420697420746f206d616b65206120747970652073706563696d656e20626f6f6b2e20497420686173207375727669766564206e6f74206f6e6c7920666976652063656e7475726965732c2062757420616c736f20746865206c65617020690426000101', 'hex'));
				sock.write(Buffer.from('000000de00000004000000000000003200050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204036e746f20656c656374726f6e6963207479706573657474696e672c2072656d61696e696e6720657373656e7469616c6c7920756e6368616e6765642e2049742077617320706f70756c61726973656420696e207468652031393630732077697468207468652072656c65617365206f66204c657472617365742073686565747320636f6e7461696e696e67204c6f72656d20497073756d20700426000101', 'hex'));
				sock.write(Buffer.from('000000b200000004000000000000003300050074657374000201313233343500430000003136303630373136333031333030302b000000000078050003020404617373616765732c20616e64206d6f726520726563656e746c792077697468206465736b746f70207075626c697368696e6720736f667477617265206c696b6520416c64757320506167654d616b657220696e636c7564696e672076657273696f6e73206f66204c6f72656d20497073756d', 'hex'));
			} else if (sockInLog.length === 2) {
				t.strictEqual(data.toString('hex'), '000000158000000400000000000000303233343300', '2nd data hex should match.');
			} else if (sockInLog.length === 3) {
				// This is actually four different PDUs at the same time, marking the response on all four parts above
				t.strictEqual(
					data.toString('hex'),
					'000000158000000400000000000000313233343300000000158000000400000000000000323233343300000000158000000400000000000000333233343300',
					'3rd data hex should match.',
				);
				t.end();
				sock.destroy();
			} else {
				throw new Error('To much data received');
			}
		});

		larvitsmpp.server({ log, port }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('sms', sms => {
				t.strictEqual(
					sms.message,
					'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum',
					'Received sms message on server should match.',
				);

				sms.smsId = 2343;

				sms.sendResp(err => {
					if (err) throw err;
				});
			});

			serverSession.on('close', () => serverSession.serverConn.close());
		});
	});
});

test('4.10. Should test that a session can recreate SMS with random sequence.', t => {
	t.plan(4);

	findFreePort().then(port => {
		const sockInLog = []; // Log incomming socket messages
		const sock = new net.Socket();

		sock.connect(port, 'localhost', () => {
			// bind_transceiver - initial call. Subsequent calls should be made on the sock.on('data') thingie
			sock.write(Buffer.from('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
		});

		sock.on('data', data => {
			sockInLog.push(data.toString('hex'));

			if (sockInLog.length === 1) {
				t.strictEqual(data.toString('hex'), '0000001480000009000000000000002f666f6f00');

				// Send all 4 parts at the same time but random order
				// Message Part 2
				sock.write(Buffer.from('000000de00000004000000000000003100050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204027768656e20616e20756e6b6e6f776e207072696e74657220746f6f6b20612067616c6c6579206f66207479706520616e6420736372616d626c656420697420746f206d616b65206120747970652073706563696d656e20626f6f6b2e20497420686173207375727669766564206e6f74206f6e6c7920666976652063656e7475726965732c2062757420616c736f20746865206c65617020690426000101', 'hex'));
				// Message Part 1
				sock.write(Buffer.from('000000de00000004000000000000003000050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204014c6f72656d20497073756d2069732073696d706c792064756d6d792074657874206f6620746865207072696e74696e6720616e64207479706573657474696e6720696e6475737472792e204c6f72656d20497073756d20686173206265656e2074686520696e6475737472792773207374616e646172642064756d6d79207465787420657665722073696e6365207468652031353030732c200426000101', 'hex'));
				// Message Part 4
				sock.write(Buffer.from('000000b200000004000000000000003300050074657374000201313233343500430000003136303630373136333031333030302b000000000078050003020404617373616765732c20616e64206d6f726520726563656e746c792077697468206465736b746f70207075626c697368696e6720736f667477617265206c696b6520416c64757320506167654d616b657220696e636c7564696e672076657273696f6e73206f66204c6f72656d20497073756d', 'hex'));
				// Message Part 3
				sock.write(Buffer.from('000000de00000004000000000000003200050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204036e746f20656c656374726f6e6963207479706573657474696e672c2072656d61696e696e6720657373656e7469616c6c7920756e6368616e6765642e2049742077617320706f70756c61726973656420696e207468652031393630732077697468207468652072656c65617365206f66204c657472617365742073686565747320636f6e7461696e696e67204c6f72656d20497073756d20700426000101', 'hex'));
			} else if (sockInLog.length === 2) {
				t.strictEqual(data.toString('hex'), '000000158000000400000000000000303233343300');
			} else if (sockInLog.length === 3) {
				// This is actually four different PDUs at the same time, marking the response on all four parts above
				t.strictEqual(data.toString('hex'), '000000158000000400000000000000313233343300000000158000000400000000000000323233343300000000158000000400000000000000333233343300');
				t.end();
				sock.destroy();
			} else {
				throw new Error('To much data received');
			}
		});

		larvitsmpp.server({ log, port }, (err, serverSession) => {
			if (err) throw err;

			serverSession.on('sms', sms => {
				t.strictEqual(sms.message, 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum');

				sms.smsId = 2343;

				sms.sendResp(err => {
					if (err) throw err;
				});
			});

			serverSession.on('close', () => serverSession.serverConn.close());
		});
	});
});
