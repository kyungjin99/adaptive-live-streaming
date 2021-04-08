const Handshake = require('./rtmp-handshake');

const HANDSHAKE_UNINIT = 0;
const HANDSHAKE_INIT = 1;
const HANDSHAKE_VERSION_SENT = 2;
const HANDSHAKE_DONE = 3;

const HANDSHAKE_PACKET_SIZE = 1536;
// const HANDSHAKE_TIMESTAMP_SIZE = 4;
// const HANDSHAKE_ZEROS_SIZE = 4;
// const HANDSHAKE_RANDOM_SIZE = 1528;

class RTMP_SESSION {
  constructor(socket) {
    this.socket = socket;
    this.handshakeState = HANDSHAKE_UNINIT;
    this.handshakePacket = Buffer.alloc(HANDSHAKE_PACKET_SIZE);
  }

  run() {
    this.socket.on('data', this.onSocketData);
    this.socket.on('error', this.onSocketError);
    this.socket.on('timeout', this.onSocketTimeout);
    this.socket.on('close', this.onSocketClose);
  }

  onSocketData(data) {
    const { length } = data.length;
    let readBytes = 0;

    while (readBytes < length) {
      switch (this.handshakeState) {
        // c0 처리
        case HANDSHAKE_UNINIT: {
          console.log('c0 received');
          readBytes += 1;
          this.handshakeState = HANDSHAKE_INIT;
          break;
        }

        // c1 처리
        case HANDSHAKE_INIT: {
          console.log('c1 received');
          data.copy(this.handshakePacket);
          readBytes += HANDSHAKE_PACKET_SIZE;
          const s0s1s2 = Handshake.generateS0S1S2(this.handshakePacket);
          this.socket.write(s0s1s2);
          this.handshakeState = HANDSHAKE_VERSION_SENT;
          break;
        }

        // c2 처리
        case HANDSHAKE_VERSION_SENT: {
          console.log('c2 received');
          this.handshakePacket = null;
          this.handshakeState = HANDSHAKE_DONE;
          break;
        }
        case HANDSHAKE_DONE:
        default:
          this.readChunks(data, length);
      }
    }
  }

  onSocketError(error) {
    console.error(error);
  }

  onSocketTimeout() {
    console.error('');
    this.socket.close();
  }

  onSocketClose() {
    this.socket.close();
  }

  readChunks(data, length) {
    console.log('data');
    console.log(data);
    console.log('length');
    console.log(length);
  }
}

module.exports = RTMP_SESSION;
