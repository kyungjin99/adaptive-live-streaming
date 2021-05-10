const RtmpServer = require('./rtmp-server');
const TransServer = require('./trans-server');
const HttpServer = require('./bin/www');

const rtmpServer = new RtmpServer();
const transServer = new TransServer();

rtmpServer.run();
transServer.run();