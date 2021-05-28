const net = require('net');
const RtmpSession = require('./rtmp-session');
const CURRENT_PROGRESS = require('./rtmp-center-ad');

const PORT = 1935;

class RTMP_SERVER {
  constructor() {
    this.server = null;
  }

  run() {
    const server = net.createServer((socket) => {
      socket.on('end', () => {
        console.log('client exit');
      });

      const sess = new RtmpSession(socket);
      sess.run();
    });

    this.server = server;
    server.on('error', (error) => {
      console.log('[RTMP SERVER] error occured');
      throw error;
    });

    server.listen(PORT, () => {
      console.log(`RTMP Server is listening on port ${PORT}`);
    });
  }
}

module.exports = RTMP_SERVER;
