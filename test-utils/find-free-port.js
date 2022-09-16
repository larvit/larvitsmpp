"use strict";

// import net from 'net';

const net = require("net");

// export async function findFreePort() {
async function findFreePort() {
	return new Promise(resolve => {
		const srv = net.createServer();

		srv.listen(0, () => {
			const port = srv.address().port;

			srv.close(() => resolve(port));
		});
	});
}

exports.findFreePort = findFreePort;
