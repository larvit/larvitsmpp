var larvitsmpp  = require('./larvitsmpp');
var request     =  require('request');
var urlencode   = require('urlencode');
var mysql       = require('mysql');
var moment      = require('moment');
var connection = mysql.createConnection({
        host     : 'host_IP',
        user     : '-',
        password : '-',
        database : '-'
});

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
var redis = require("redis"),
        client = redis.createClient('6379','host-IP');
var status_mnp = 0;
var balance = 0;
var number = 0;
var currentTime = moment().format('YYYY-MM-DD HH:mm:ss');
var log = require('bunyan').createLogger({
        name: 'ITS SMPP',
        streams: [{
                path: "/var/log/kannel/access_premium.log",
        }]
})
    defs        = require('./lib/defs');


function checkuserpass(username, password, callback) {
         if (username === 'directufone' && password === '6790') {
                callback(null, true, {'username': 'directufone', 'userId': 0});
         } else if (username === 'ufoneprom' && password === '6789') {
                callback(null, true, {'username': 'ufoneprom', 'userId': 1});
        }
        else {
                callback(null, false);
        }
};
larvitsmpp.server({     'port': 2770,
        'checkuserpass': checkuserpass
}, function(err, serverSession) {
        if (err) {
                throw err;
        }

        // Incoming SMS!
        serverSession.on('sms', function(sms) {
                //              console.log(sms.session._events.myObject.incomingPdu);
       // ADD THESE DEBUG LINES AT THE TOP ↓
        console.log('sms object keys:', Object.keys(sms));
        console.log('smsId:', sms.smsId);
        console.log('smsId:test');
        console.log('sequence_number:', sms.pduObj && sms.pduObj.cmdStatus);
        console.log('full pduObj:', JSON.stringify(sms.pduObj, null, 2));

                    //console.log('pduObjs:', JSON.stringify(sms.pduObjs, null, 2));
                    //console.log('session keys:', Object.keys(sms.session));

        // DEBUG LINES END ↑
                var mnp_check = sms.to.substr(sms.to.length - 10);
                mnp_check =0+mnp_check;
                console.log(mnp_check);
                client.get(mnp_check, function(err, reply) {
                                status_mnp = reply;
                                console.log(status_mnp);
                        });

                sms.sendResp(
                        'ESME_ROK'
                );


                        console.log("THIS IS ELSE LOOP");
                        number = sms.to;
                var txt= urlencode(sms.message);
                if(this.userData.userId == 0) {
//                      url ='http://localhost/kannel/sendzong.php?to='+sms.to+'&from='+sms.from+'&message='+txt'&charset='+sms.charset'&sms.coding='+sms.encoding;
                        url = 'http://host-IP/script_http.php?to=' + sms.to + '&from=' + sms.from + '&message=' + txt ;
                } else if (this.userData.userId == 1){
                                                //url = 'https://bsms.ufone.com/bsms_v8_api/sendapi-07.jsp?id=03315515021&message='+txt+'&shortcode='+sms.from+'&lang=English&mobilenum='+sms.to+'&password=March%402023&operator=Ufone&messagetype=nontransactional';
                        url = 'http://host-IP/script_http_2.php?to=' + sms.to + '&from=' + sms.from + '&message=' + txt ;
                }
                var accessLog = {
                        timeStamp: currentTime,
                        to: sms.to,
                        from: sms.from,
                        message: txt,
                        submitTime: sms.submitTime,
                        //smsCount: sms.pduObjs.length,
                        apiUrl: url,
                        charset: this.dta_charset,      // Character set
                        encoding: this.data_coding
                };

                request(url, {timeout: 60000} ,function (error, response, body) {
                        console.log('body:', body);
                        if (!error && response.statusCode == 200) {
                                accessLog.apiResponse = body;
                                        if (sms.dlr === true) {
                                           if (body && body.indexOf('Successful') !== -1) {
                                                   console.log('DELIVRD');
                                                 sms.sendDlr('DELIVRD');
                                                } else {
                                                         sms.sendDlr('UNDELIV');
                                                        console.log('UNDELIV');
                                                }
                                         }
                        } else {
                                accessLog.apiResponse = error;
                        }
                        log.info(accessLog);
                });


                // Oh, the sms sender wants a dlr (delivery report), send it!
                //if (sms.dlr === true) {
                //      sms.sendDlr('ACCEPTED'); // Equalent to sms.sendDlr('DELIVERED');

                        // To send a negative delivery report for example do:
                        // sms.sendDlr('UNDELIVERABLE');
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
                //}
        });
});
