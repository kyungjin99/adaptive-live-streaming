const Handshake = require('./rtmp-handshake');

const HANDSHAKE_UNINIT = 0;
const HANDSHAKE_INIT = 1;
const HANDSHAKE_VERSION_SENT = 2;
const HANDSHAKE_DONE = 3;

const HANDSHAKE_PACKET_SIZE = 1536;
// const HANDSHAKE_TIMESTAMP_SIZE = 4;
// const HANDSHAKE_ZEROS_SIZE = 4;
// const HANDSHAKE_RANDOM_SIZE = 1528;

const MAX_CHUNK_HEADER = 18;

const RTMP_PARSE_INIT = 0;
const RTMP_PARSE_BASIC_HEADER = 1;
const RTMP_PARSE_MESSAGE_HEADER = 2;
const RTMP_PARSE_EXTENDED_TIMESTAMP = 3;
const RTMP_PARSE_PAYLOAD = 4;

const rtmpHeaderSize = [11, 7, 3, 0];

const RTMP_CHUNK_TYPE_0 = 0; // 11-bytes: timestamp(3) + length(3) + stream type(1) + stream id(4)
const RTMP_CHUNK_TYPE_1 = 1; // 7-bytes: delta(3) + length(3) + stream type(1)
const RTMP_CHUNK_TYPE_2 = 2; // 3-bytes: delta(3)
const RTMP_CHUNK_TYPE_3 = 3; // 0-byte

/* Protocol Control Messages */
const RTMP_TYPE_SET_CHUNK_SIZE = 1;
const RTMP_TYPE_ABORT = 2;
const RTMP_TYPE_ACKNOWLEDGEMENT = 3; // bytes read report
const RTMP_TYPE_WINDOW_ACKNOWLEDGEMENT_SIZE = 5; // server bandwidth
const RTMP_TYPE_SET_PEER_BANDWIDTH = 6; // client bandwidth

/* User Control Messages Event (4) */
const RTMP_TYPE_EVENT = 4;

const RTMP_TYPE_AUDIO = 8;
const RTMP_TYPE_VIDEO = 9;

/* Data Message */
const RTMP_TYPE_FLEX_STREAM = 15; // AMF3
const RTMP_TYPE_DATA = 18; // AMF0

/* Command Message */
const RTMP_TYPE_FLEX_MESSAGE = 17; // AMF3
const RTMP_TYPE_INVOKE = 20; // AMF0

/* Aggregate Message */
const RTMP_TYPE_METADATA = 22;

const CHUNK_SIZE = 128;


const RTMP_CHUNK_SIZE = 128;
const RTMP_PING_TIME = 60000;
const RTMP_PING_TIMEOUT = 30000;

const STREAM_BEGIN = 0x00;
const STREAM_EOF = 0x01;

const RtmpPacket = {
  create: (fmt = 0, cid = 0) => {
    return {
      header: {
        fmt: fmt,
        cid: cid,
        timestamp: 0,
        length: 0,
        type: 0,
        stream_id: 0
      },
      clock: 0,
      payload: null,
      capacity: 0,
      bytes: 0
    };
  }
};

class RTMP_SESSION {
  constructor(socket) {
    this.socket = socket;
    this.handshakeState = HANDSHAKE_UNINIT;
    this.handshakeBytes = 0;
    this.handshakePacket = Buffer.alloc(HANDSHAKE_PACKET_SIZE);
  }

  run() {
    this.socket.on('data', this.onSocketData.bind(this));
    this.socket.on('error', this.onSocketError.bind(this));
    this.socket.on('timeout', this.onSocketTimeout.bind(this));
    this.socket.on('close', this.onSocketClose.bind(this));
  }

  onSocketData(data) {
    const { length } = data;
    let readBytes = 0;
    let nextReadBytes = 0;
    console.log(`length = ${length}`);

    while (readBytes < length) {
      switch (this.handshakeState) {
        // c0 처리
        case HANDSHAKE_UNINIT: {
          console.log("handshake uninit start");
          readBytes += 1;
          this.handshakeBytes = 0;
          this.handshakeState = HANDSHAKE_INIT;
          break;
        }

        // c1 처리
        case HANDSHAKE_INIT: {
          console.log("handshake init start");
          nextReadBytes = HANDSHAKE_PACKET_SIZE - this.handshakeBytes;
          nextReadBytes = nextReadBytes <= length ? nextReadBytes : length;
          data.copy(this.handshakePacket, this.handshakeBytes, readBytes, readBytes + nextReadBytes);
          this.handshakeBytes += nextReadBytes;
          readBytes += nextReadBytes;

          if(this.handshakeBytes === HANDSHAKE_PACKET_SIZE) {
            const s0s1s2 = Handshake.generateS0S1S2(this.handshakePacket);
            this.socket.write(s0s1s2);
            this.handshakeState = HANDSHAKE_VERSION_SENT;
            this.handshakeBytes = 0;
          }
          break;
        }

        // c2 처리
        case HANDSHAKE_VERSION_SENT: {
          console.log("handshake version_sent start");
          nextReadBytes = HANDSHAKE_PACKET_SIZE - this.handshakeBytes;
          nextReadBytes = nextReadBytes <= length ? nextReadBytes : length;
          data.copy(this.handshakePacket, this.handshakeBytes, readBytes, readBytes + nextReadBytes);
          this.handshakeBytes += nextReadBytes;
          readBytes += nextReadBytes;

          if(this.handshakeBytes === HANDSHAKE_PACKET_SIZE) {
            this.handshakePacket = null;
            this.handshakeState = HANDSHAKE_DONE;
            this.handshakeBytes = 0;
          }
          break;
        }
        case HANDSHAKE_DONE:
        default: {
          console.log("chunk read start");
          return this.readChunks(data, readBytes, length);
        }
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

  readChunks(data, p, bytes) {
  
  }
}

module.exports = RTMP_SESSION;
