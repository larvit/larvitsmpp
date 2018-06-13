'use strict';

describe('the end', function () {
	it('should close down', function (done) {
		setTimeout(function () {
			process.exit(0);
		}, 1000);
		done();
	});
});
