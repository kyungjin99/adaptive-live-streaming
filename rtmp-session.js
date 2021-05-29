const QueryString = require('querystring');
const AMF = require('./rtmp-amf');
// const AMF = require('node-amfutils');
const HANDSHAKE = require('./rtmp-handshake');
const CURRENT_PROGRESS = require('./rtmp-center-ad');
const GENERATOR = require('./rtmp-center-gen');
const AV = require('./rtmp-av');
const { AUDIO_SOUND_RATE, AUDIO_CODEC_NAME, VIDEO_CODEC_NAME } = require('./rtmp-av');

/* 기타 */
const TIMEOUT = 10000;

/* handshake */
const HANDSHAKE_UNINIT = 0;
const HANDSHAKE_INIT = 1;
const HANDSHAKE_ACK_SENT = 2;
const HANDSHAKE_DONE = 3;
const HANDSHAKE_PACKET_SIZE = 1536;

/* chunk parsing state */
const PARSE_INIT = 0;
const PARSE_BHEADER = 1;
const PARSE_MHEADER = 2;
const PARSE_EXTENDED_TIMESTAMP = 3;
const PARSE_PAYLOAD = 4;

/* chunk types */
const CHUNK_TYPE_0 = 0; // timestamp: 3B, message length: 3B, message type: 1B, message stream id: 4B
const CHUNK_TYPE_1 = 1; // timestamp: 3B, message length: 3B, message type: 1B
const CHUNK_TYPE_2 = 2; // timestamp: 3B
const CHUNK_TYPE_3 = 3; // 0B

/* message header - type ids */
const SET_CHUNK_SIZE = 1;
const ABORT_MESSAGE = 2;
const ACKNOWLEDGEMENT = 3;
const USER_CONTROL_MESSAGE = 4;
const WINDOW_ACKNOWLEDGEMENT = 5;
const SET_PEER_BANDWIDTH = 6;

const COMMAND_MESSAGE_AMF0 = 20;
const COMMAND_MESSAGE_AMF3 = 17;
const DATA_MESSAGE_AMF0 = 18;
const DATA_MESSAGE_AMF3 = 15;
const SHARED_OBJECT_MESSAGE_AMF0 = 19;
const SHARED_OBJECT_MESSAGE_AMF3 = 16;
const AUDIO_MESSAGE = 8;
const VIDEO_MESSAGE = 9;
const AGGREGATE_MESSAGE = 22;

/* user control message - event types */
const UCM_STREAM_BEGIN = 0;
const UCM_STREAM_EOF = 1;
const UCM_STREAM_DRY = 2;
const UCM_SET_BUFFER_LENGTH = 3;
const UCM_STREAM_IS_RECORDED = 4;
const UCM_PING_REQUEST = 5;
const UCM_PING_RESPONSE = 6;

/* peer bandwidth limit types */
const LIMIT_TYPE_HARD = 0;
const LIMIT_TYPE_SOFT = 1;
const LIMIT_TYPE_DYNAMIC = 2;

/* reserved chunk stream id */
const CSID_PROTOCOL_MESSAGE = 2;

/* reserved message stream id */
const RTMP_CHANNEL_PROTOCOL = 2;
const RTMP_CHANNEL_INVOKE = 3;
const RTMP_CHANNEL_AUDIO = 4;
const RTMP_CHANNEL_VIDEO = 5;
const RTMP_CHANNEL_DATA = 6;

const packet = {
  create: (fmt = 0, csid = 0) => {
    return {
      header: {
        basicHeader: {
          fmt, /* format (chunk type) */
          csid, /* chunk stream id */
        },
        chunkMessageHeader: {
          timestamp: 0, /* timestamp */
          plen: 0, /* payload length in bytes */
          mtid: 0, /* message type id */
          msid: 0, /* message stream id (little endian) */
        },
      },
      payload: null,
      bytes: 0,
      timestamp: 0,
    };
  },
};

const cmdStructure = {
  onConnectCmd: () => {
    return {
      cmd: null,
      transId: 1,
      cmdObj: null,
      args: null,
    };
  },
  sendConnectCmd: () => {
    return {
      cmd: '_result',
      transId: 1,
      cmdObj: null,
      info: null,
    };
  },
  onCallCmd: () => {
    return {
      cmd: null,
      transId: null,
      cmdObj: null,
      args: null,
    };
  },
  sendCallCmd: () => {
    return {
      cmd: '_result',
      transId: null,
      cmdObj: null,
      info: null,
    };
  },
  onCreateStreamCmd: () => {
    return {
      cmd: 'createStream',
      transId: null,
      cmdObj: null,
    };
  },
  sendCreateStreamCmd: () => {
    return {
      cmd: '_result',
      transId: null,
      cmdObj: null,
      info: null,
    };
  },
  onPublishCmd: () => {
    return {
      cmd: 'publish',
      transId: null,
      cmdObj: null,
      name: null,
      type: null,
    };
  },
  sendPublishCmd: () => {
    return {
      cmd: 'onStatus',
      transId: 0,
      cmdObj: null,
      info: {
        level: null,
        code: null,
        description: null,
      },
    };
  },
  onPlayCmd: () => {
    return {
      cmd: 'play',
      transId: null,
      cmdObj: null,
      name: null,
      type: null,
    };
  },
  sendPlayCmd: () => {
    return {
      cmd: 'onStatus',
      transId: 0,
      cmdObj: null,
      info: {
        leve: null,
        code: null,
        description: null,
      },
    };
  },
  sendSampleAccessCmd: () => {
    return {
      cmd: '|RtmpSampleAccess',
      bool1: false,
      bool2: false,
    };
  },
};

class RTMP_SESSION {
  constructor(socket) {
    this.socket = socket;
    this.id = GENERATOR.genSessionID();
    this.handshakeState = HANDSHAKE_UNINIT;
    this.handshakeBytes = 0;
    this.handshakePacket = Buffer.alloc(HANDSHAKE_PACKET_SIZE);

    this.chunkSize = 128; // max bytes of data in a chunk (default 128)
    this.outChunkSize = 60000;

    // ACK를 위한 변수
    this.ackSize = 0;
    this.inAck = 0;
    this.lastAck = 0;

    // NetStream 위한 변수
    this.appname = ''; // TODO: 필요없을거같은데..? 확인 필요

    // this.gopCacheQueue = null;
    // this.flvGopCacheQueue = null;

    // for parsing chunk
    this.parsingState = 0;
    this.bytesParsed = 0;
    this.parsedChunkBuf = Buffer.alloc(18); // stores parsed chunk. assign a header size of 18 (MAX)
    this.bheaderSize = 0; // chunk basic header size (in bytes)
    this.mheaderSize = 0; // chunk message header size (in bytes)
    this.useExtendedTimestamp = 0;
    this.parsedPacket = packet.create(); // this will multiplex a message

    // net connection commands
    this.command = cmdStructure;
    this.onConnectCmd = this.command.onConnectCmd();
    this.sendConnectCmd = this.command.sendConnectCmd();
    this.onCallCmd = this.command.onCallCmd();
    this.sendCallCmd = this.command.sendCallCmd();
    this.onCreateStreamCmd = this.command.onCreateStreamCmd();
    this.sendCreateStreamCmd = this.command.sendCreateStreamCmd();

    // net stream commands
    this.onPublishCmd = this.command.onPublishCmd();
    this.sendPublishCmd = this.command.sendPublishCmd();
    this.onPlayCmd = this.command.onPlayCmd();
    this.sendPlayCmd = this.command.sendPlayCmd();
    this.sendSampleAccessCmd = this.command.sendSampleAccessCmd();

    // ?
    this.packetList = new Map();
    this.limitType = LIMIT_TYPE_HARD;
    this.startTimestamp = null;
    this.pingRequestTimestamp = null;
    this.streams = 0;

    // net stream
    // this.nowStreamId = 0;
    // this.nowStreamPath = '';
    // this.nowArgs = {};
    this.publishStreamId = 0;
    this.publishStreamPath = '';
    this.publishArgs = {};
    this.playStreamId = 0;
    this.playStreamPath = '';
    this.playArgs = {};
    // this.status = Buffer.from('0000011', 'binary'); // range 0 ~ 6
    this.status = Buffer.from('00000000000101', 'hex'); // range 0 ~ 6
    // 0(is Start?, false) 0(is Publishing?, false) 0(is Playing?, false) 0(is Idling?, false) 0(is Pausing?, false)
    // 1(is Receiving Audio?, true) 1(is Receiving Video?, true)

    // TODO: flv에 쓰이는 변수들..? 확인 필요
    this.players = new Set();
    CURRENT_PROGRESS.sessions.set(this.id, this);

    // about video, audio
    this.metaData = null;

    this.audioCodec = 0;
    this.audioSamplerate = null;
    this.audioChannels = null;
    this.audioCodecName = null;
    this.aacSequenceHeader = null;
    this.audioProfileName = null;
    this.videoWidth = null;
    this.videoHeight = null;
    this.videoFps = null;
    this.videoCodec = 0;
    this.videoCodecName = null;
    this.videoProfileName = null;
    this.videoLevel = null;
    this.avcSequenceHeader = null;

    this.piledAVDataNum = 0;
  }

  run() {
    this.socket.on('data', this.onSocketData.bind(this));
    this.socket.on('error', this.onSocketError.bind(this));
    this.socket.on('timeout', this.onSocketTimeout.bind(this));
    this.socket.on('close', this.onSocketClose.bind(this));
    this.socket.setTimeout(TIMEOUT);
    this.status[0] = 1;
    console.log(`[RTMP SESSION] Session created. id = ${this.id}`);
  }

  stop() {
    if (this.playStreamId > 0) {
      console.log('Delete Stream called before stop playing and delete socket');
      this.onDeleteStream({ streamId: this.playStreamId });
    }

    if (this.publishStreamId > 0) {
      console.log('Delete Stream called before stop publishing and delete socket');
      this.onDeleteStream({ streamId: this.publishStreamId });
    }

    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
    }

    console.log(`[Socket Close] id=${this.id}`);
    CURRENT_PROGRESS.sessions.delete(this.id);
    this.socket.uncork();
    this.socket.destroy();
  }

  onSocketData(data) {
    const { length } = data;
    let readBytes = 0;
    let nextReadBytes = 0;

    while (readBytes < length) {
      switch (this.handshakeState) {
        // c0 처리
        case HANDSHAKE_UNINIT: {
          readBytes += 1;
          this.handshakeBytes = 0;
          this.handshakeState = HANDSHAKE_INIT;
          break;
        }
        case HANDSHAKE_INIT: { // c1 처리
          nextReadBytes = HANDSHAKE_PACKET_SIZE - this.handshakeBytes;
          nextReadBytes = nextReadBytes <= length ? nextReadBytes : length;
          data.copy(this.handshakePacket, this.handshakeBytes, readBytes, readBytes + nextReadBytes);
          this.handshakeBytes += nextReadBytes;
          readBytes += nextReadBytes;

          if (this.handshakeBytes === HANDSHAKE_PACKET_SIZE) {
            const s0s1s2 = HANDSHAKE.generateS0S1S2(this.handshakePacket);
            this.socket.write(s0s1s2);
            this.handshakeState = HANDSHAKE_ACK_SENT;
            this.handshakeBytes = 0;
          }
          break;
        }
        case HANDSHAKE_ACK_SENT: { // c2 처리
          nextReadBytes = HANDSHAKE_PACKET_SIZE - this.handshakeBytes;
          nextReadBytes = nextReadBytes <= length ? nextReadBytes : length;
          data.copy(this.handshakePacket, this.handshakeBytes, readBytes, readBytes + nextReadBytes);
          this.handshakeBytes += nextReadBytes;
          readBytes += nextReadBytes;

          if (this.handshakeBytes === HANDSHAKE_PACKET_SIZE) {
            this.handshakePacket = null;
            this.handshakeState = HANDSHAKE_DONE;
            this.handshakeBytes = 0;
          }
          break;
        }
        case HANDSHAKE_DONE: // handshake 완료
        default: {
          return this.readChunks(data, readBytes, length);
        }
      }
    }
  }

  onSocketError(error) {
    console.error('[ERROR] arbitrary error occured');
    console.log(error);
    console.log(`id = ${this.id}`);
    this.stop();
  }

  onSocketTimeout() {
    console.error('[ERROR] timeout');
    this.stop();
  }

  onSocketClose() {
    this.stop();
  }

  readChunks(data, readBytes, length) {
    let dataOffset = 0; // current offset of a chunk data received
    length -= readBytes;

    let extendedTimestamp;

    while (dataOffset < length) { // until finishing reading chunk
      switch (this.parsingState) {
        case PARSE_INIT: { // to parse a chunk basic header, you need to know how big it is
          this.parsedChunkBuf[0] = data[readBytes + dataOffset]; // read 1 byte from data and write to buf
          this.bytesParsed += 1;
          dataOffset += 1;
          const bheaderType = this.parsedChunkBuf[0] & 0x3F; // the bottom 6 bits of the first byte
          switch (bheaderType) {
            case 0: // chunk basic header 2
              this.bheaderSize = 2;
              break;
            case 1: // chunk basic header 3
              this.bheaderSize = 3;
              break;
            default: // chunk basic header 1
              this.bheaderSize = 1;
              break;
          }
          this.parsingState = PARSE_BHEADER; // move on to the next step
          break;
        }
        case PARSE_BHEADER: { // parse chunk basic header
          while (this.bytesParsed < this.bheaderSize && dataOffset < length) { // reading bheader
            this.parsedChunkBuf[this.bytesParsed] = data[readBytes + dataOffset];
            this.bytesParsed += 1;
            dataOffset += 1;
          }
          if (this.bytesParsed >= this.bheaderSize) { // finished reading bheader: start parsing it
            this.parseChunkBasicHeader(); // extract fmt and csid
            this.parsingState = PARSE_MHEADER; // move on to the next step
          }
          break;
        }
        case PARSE_MHEADER: { // parse chunk message header
          const { fmt } = this.parsedPacket.header.basicHeader; // chunk type
          let endpoint = this.bheaderSize;
          switch (fmt) {
            case 0:
              endpoint += 11;
              break;
            case 1:
              endpoint += 7;
              break;
            case 2:
              endpoint += 3;
              break;
            case 3:
              endpoint += 0;
              break;
            default: break;
          }
          while (this.bytesParsed < endpoint && dataOffset < length) {
            this.parsedChunkBuf[this.bytesParsed] = data[readBytes + dataOffset]; // reading mheader
            this.bytesParsed += 1;
            dataOffset += 1;
          }
          if (this.bytesParsed >= endpoint) {
            this.parseChunkMessageHeader(); // extract timestamp, mlen, mtid, msid
            this.parsingState = PARSE_EXTENDED_TIMESTAMP; // move on to the next step
          }
          break;
        }
        case PARSE_EXTENDED_TIMESTAMP: { // parse extended timestamp
          let endpoint = this.bheaderSize + this.mheaderSize;
          // check if uses extended timestamp
          if (this.parsedPacket.header.chunkMessageHeader.timestamp === 0xFFFFFF) { // read from chunk
            this.useExtendedTimestamp = 4;
            endpoint += 4;
          }
          while (this.bytesParsed < endpoint && dataOffset < length) {
            this.parsedChunkBuf[this.bytesParsed] = data[readBytes + dataOffset]; // reading extended timestamp
            this.bytesParsed += 1;
            dataOffset += 1;
          }
          if (this.bytesParsed >= endpoint) {
            if (this.parsedPacket.header.chunkMessageHeader.timestamp === 0xFFFFFF) {
              extendedTimestamp = this.parsedChunkBuf.readUInt32BE(endpoint - 4);
            } else {
              extendedTimestamp = this.parsedPacket.header.chunkMessageHeader.timestamp;
            }

            if (this.parsedPacket.bytes === 0) {
              if (this.parsedPacket.header.fmt === CHUNK_TYPE_0) {
                this.parsedPacket.timestamp = extendedTimestamp;
              } else {
                this.parsedPacket.timestamp += extendedTimestamp;
              }
            }
          }
          // payload parsing 준비
          if (!this.parsedPacket.payload) {
            this.parsedPacket.payload = Buffer.alloc(this.chunkSize);

            if (this.parsedPacket.payload.length < this.parsedPacket.header.chunkMessageHeader.plen) {
              this.parsedPacket.payload = Buffer.alloc(this.parsedPacket.header.chunkMessageHeader.plen + 1024);
            }
          }

          this.parsingState = PARSE_PAYLOAD; // move on to the next step
          break;
        }
        case PARSE_PAYLOAD: { // parse payload
          let size = Math.min(this.chunkSize - (this.parsedPacket.bytes % this.chunkSize), this.parsedPacket.header.chunkMessageHeader.plen - this.parsedPacket.bytes);
          size = Math.min(size, length - dataOffset);
          // TODO: check payload size and realloc
          data.copy(this.parsedPacket.payload, this.parsedPacket.bytes, readBytes + dataOffset, readBytes + dataOffset + size);

          this.parsedPacket.bytes += size;
          this.bytesParsed += size;
          dataOffset += size;

          // const totalPayloadSize = this.bytesParsed - (this.bheaderSize + this.mheaderSize + this.useExtendedTimestamp);
          if (this.parsedPacket.bytes >= this.parsedPacket.header.chunkMessageHeader.plen) {
            this.parsingState = PARSE_INIT; // finished reading a chunk. restart the parsing cycle
            // dataOffset = 0;

            // clear parsedPacket
            this.bytesParsed = 0;
            this.parsedPacket.bytes = 0;
            this.useExtendedTimestamp = 0;
            this.handler();
          } else if (this.parsedPacket.bytes % this.chunkSize === 0) {
            this.parsingState = PARSE_INIT;
          }
          break;
        }
        default: break;
      }
    }
    this.checkACK(data); // TODO: 이 위치에 들어가는게 맞는지 확인 필요
  }

  parseChunkBasicHeader() { // fmt, csid
    const { bheaderSize } = this;
    const fmt = this.parsedChunkBuf[0] >> 6;
    let csid = 0;
    switch (bheaderSize) { // parse csid
      case 1: { // chunk basic header 1
        csid = this.parsedChunkBuf[0] & 0X3F;
        break;
      }
      case 2: { // chunk basic header 2
        csid = this.parsedChunkBuf.readUInt8(1) + 64;
        break;
      }
      case 3: { // chunk basic header 3
        csid = this.parsedChunkBuf.readUInt16BE(1) + 64;
        break;
      }
      default: break;
    }

    this.parsedPacket = this.packetList.get(csid);

    // packetList에서 현재 수신한 csid를 찾지 못했을 경우
    if (!this.parsedPacket) {
      this.parsedPacket = packet.create(fmt, csid);
      this.packetList.set(csid, this.parsedPacket);
    }

    this.parsedPacket.header.basicHeader.fmt = fmt; // parse fmt
    this.parsedPacket.header.basicHeader.csid = csid;
  }

  parseChunkMessageHeader() {
    const { fmt } = this.parsedPacket.header.basicHeader; // chunk type
    let offset = this.bheaderSize;
    this.mheaderSize = 0;

    // read timestamp (delta) field except for type3 chunks
    if (fmt < CHUNK_TYPE_3) {
      const timestamp = this.parsedChunkBuf.readUIntBE(offset, 3);
      if (timestamp !== 0xFFFFFF) {
        this.parsedPacket.header.chunkMessageHeader.timestamp = timestamp;
      } else { // uses extended timestamp
        this.parsedPacket.header.chunkMessageHeader.timestamp = 0xFFFFFF;
      }
      offset += 3;
      this.mheaderSize += 3;
    }

    // read message length and message stream id field for type 0, type 1 chunks
    if (fmt < CHUNK_TYPE_2) {
      this.parsedPacket.header.chunkMessageHeader.plen = this.parsedChunkBuf.readUIntBE(offset, 3);
      offset += 3;
      this.parsedPacket.header.chunkMessageHeader.mtid = this.parsedChunkBuf.readUInt8(offset);
      offset += 1;
      this.mheaderSize += 4;
    }

    // read message stream id for type 0 chunk
    if (fmt === CHUNK_TYPE_0) {
      this.parsedPacket.header.chunkMessageHeader.msid = this.parsedChunkBuf.readUInt32LE(offset);
      offset += 4;
      this.mheaderSize += 4;
    }
  }

  createChunkBasicHeader(bheader) {
    const { fmt, csid } = bheader;
    let buf; // buffer

    if (csid >= 2 && csid <= 63) { // chunk basic header 1
      buf = Buffer.alloc(1);
      buf[0] = (fmt << 6) | csid;
    } else if (csid >= 319) { // chunk basic header 2
      buf = Buffer.alloc(3);
      buf[0] = (fmt << 6) | 1;
      buf[1] = (csid - 64) & 0xFF;
      buf[2] = ((csid - 64) >> 8) & 0xFF;
    } else if (csid >= 64 && csid <= 319) { // chunk basic header 3
      buf = Buffer.alloc(2);
      buf[0] = (fmt << 6) | 0;
      buf[1] = (csid - 64) & 0XFF;
    }
    return buf;
  }

  createChunkMessageHeader(header) {
    const { basicHeader: bheader, chunkMessageHeader: mheader } = header;
    const {
      timestamp, plen, mtid, msid,
    } = mheader;
    let buf;

    const ctype = bheader.fmt; // get chunk type from fmt in chunk basic header
    switch (ctype) {
      case CHUNK_TYPE_0: // timestamp: 3B, message length: 3B, message type: 1B message stream: 4B
        buf = Buffer.alloc(11);
        break;
      case CHUNK_TYPE_1: // timestamp: 3B, message length: 3B, message type: 1B
        buf = Buffer.alloc(7);
        break;
      case CHUNK_TYPE_2: // timestamp: 3B
        buf = Buffer.alloc(3);
        break;
      case CHUNK_TYPE_3: // 0B
        buf = Buffer.alloc(0);
        break;
      default:
        break;
    }

    // add timestamp field except for type3 chunks
    if (ctype < CHUNK_TYPE_3) {
      if (timestamp >= 0xFFFFFF) { // extended timestamp
        buf.writeUIntBE(0xFFFFFF, 0, 3);
      } else {
        buf.writeUIntBE(timestamp, 0, 3);
      }
    }

    // add message length and message type id field for type 0, type 1 chunks
    if (ctype < CHUNK_TYPE_2) {
      buf.writeUIntBE(plen, 3, 3); // message length
      buf.writeUInt8(mtid, 6); // message type id
    }

    // add message stream id field for type 0
    if (ctype < CHUNK_TYPE_1) {
      buf.writeUInt32LE(msid, 7); // message stream id (stored in little endian)
    }

    return buf;
  }

  createChunks(pkt) { // create chunks from a packet and interleave them in a buffer
    // calculate the size of header and payload
    let totalBufSize = 0; // to allocate buffer
    const { header, payload } = pkt;
    const bheaderBuf = this.createChunkBasicHeader(header.basicHeader);
    const mheaderBuf = this.createChunkMessageHeader(header);
    const bheaderSize = bheaderBuf.length; // size of chunk basic header
    const mHeaderSize = mheaderBuf.length; // size of chunk message header
    const useExtendedTimestamp = (header.chunkMessageHeader.timestamp >= 0xFFFFFF) ? 4 : 0;
    const extendedTimestampBuf = Buffer.alloc(useExtendedTimestamp);
    const payloadSize = header.chunkMessageHeader.plen; // size of payload in packet
    let bufOffset = 0; // buffer offset
    let payloadOffset = 0; // payload offset

    if (useExtendedTimestamp !== 0) {
      extendedTimestampBuf.writeUInt32BE(header.chunkMessageHeader.timestamp);
    }

    // calculate the number of chunks
    const numOfChunks = Math.ceil(header.chunkMessageHeader.plen / this.outChunkSize);
    totalBufSize = bheaderSize + mHeaderSize + useExtendedTimestamp; // first chunk size
    if (numOfChunks > 1) { // remainder chunks (all are type 3)
      totalBufSize += (bheaderSize + useExtendedTimestamp) * (numOfChunks - 1);
    }
    totalBufSize += payloadSize; // add the size of payload

    const buf = Buffer.alloc(totalBufSize); // allocate buffer

    // write chunks to buffer
    bheaderBuf.copy(buf, 0, 0, bheaderSize); // write basic header of the first chunk
    bufOffset += bheaderSize;
    mheaderBuf.copy(buf, bufOffset, 0, mHeaderSize); // write message header of the first chunk
    bufOffset += mHeaderSize;
    if (useExtendedTimestamp) { // write extended timestamp if needs one
      extendedTimestampBuf.copy(buf, bufOffset, 0, extendedTimestampBuf.length);
      bufOffset += extendedTimestampBuf.length;
    }
    if (payloadSize >= this.outChunkSize) { // write payload
      payload.copy(buf, bufOffset, 0, this.outChunkSize);
      // buf.write(payload, bufOffset, this.chunkSize); // write payload up to max chunk size
      payloadOffset += this.outChunkSize;
      bufOffset += this.outChunkSize;
    } else {
      // buf.write(payload, bufOffset, payloadSize); // write the whole payload if possible
      payload.copy(buf, bufOffset, 0, payloadSize);
    }

    if (numOfChunks > 1) { // create type 3 chunks
      const { csid } = header.basicHeader;
      const t3bheader = this.createChunkBasicHeader(packet.create(CHUNK_TYPE_3, csid).header.basicHeader);
      for (let i = 1; i < numOfChunks; i += 1) {
        // write chunk type 3 header (create only basic header)
        t3bheader.copy(buf, bufOffset, 0, t3bheader.length);
        bufOffset += t3bheader.length;
        // write extended timestamp
        if (useExtendedTimestamp) {
          extendedTimestampBuf.copy(buf, bufOffset, 0, useExtendedTimestamp);
          bufOffset += 4;
        }
        // write partial payloads
        if (payloadSize - payloadOffset >= this.outChunkSize) { // partial payload size >= chunk size
          payload.copy(buf, bufOffset, payloadOffset, payloadOffset + this.outChunkSize);
        } else if (payloadSize - payloadOffset > 0) { // partial payload size < chunk size
          payload.copy(buf, bufOffset, payloadOffset, payloadSize);
        }
        payloadOffset += this.outChunkSize;
        bufOffset += this.outChunkSize;
      }
    }
    return buf;
  }

  handler() {
    const { mtid } = this.parsedPacket.header.chunkMessageHeader;
    let { payload } = this.parsedPacket;
    payload = payload.slice(0, this.parsedPacket.header.chunkMessageHeader.plen);
    switch (mtid) {
      // protocol control message
      case SET_CHUNK_SIZE:
      case ABORT_MESSAGE:
      case ACKNOWLEDGEMENT:
      case WINDOW_ACKNOWLEDGEMENT:
      case SET_PEER_BANDWIDTH:
        this.pcmHandler(mtid, payload);
        break;

      // user control message
      case USER_CONTROL_MESSAGE:
        this.ucmHandler(payload);
        break;

      // rtmp command messages
      case COMMAND_MESSAGE_AMF0:
      case COMMAND_MESSAGE_AMF3:
      case DATA_MESSAGE_AMF0:
      case DATA_MESSAGE_AMF3:
      case SHARED_OBJECT_MESSAGE_AMF0:
      case SHARED_OBJECT_MESSAGE_AMF3:
      case AUDIO_MESSAGE:
      case VIDEO_MESSAGE:
      case AGGREGATE_MESSAGE:
        this.rcmHandler(mtid, payload);
        break;
      default: break;
    }
    return null;
  }

  rcmHandler(mtid, payload) {
    switch (mtid) {
      case COMMAND_MESSAGE_AMF0:
      case COMMAND_MESSAGE_AMF3:
        this.parseCmdMsg(mtid, payload);
        break;
      case DATA_MESSAGE_AMF0:
      case DATA_MESSAGE_AMF3:
        this.dataHandler(mtid, payload);
        break;
      case AUDIO_MESSAGE:
        this.audioHandler(payload);
        break;
      case VIDEO_MESSAGE:
        this.videoHandler(payload);
        break;
      default: break;
    }
  }

  parseCmdMsg(amfType, payload) {
    console.log(`payload size = ${payload.length}`);
    console.log(payload);
    const amf = (amfType === COMMAND_MESSAGE_AMF0) ? 0 : 3;
    const offset = (amf === 0) ? 0 : 1;
    payload = payload.slice(offset, this.parsedPacket.header.chunkMessageHeader.plen);
    // decode payload data according to AMF
    const decodedMsg = (amf === 0) ? AMF.decodeAmf0Cmd(payload) : AMF.decodeAmf3Cmd(payload);
    const cmdName = decodedMsg.cmd;
    console.log(decodedMsg);

    switch (cmdName) {
      case 'connect':
        this.onConnectCmd = decodedMsg;
        this.onConnect();
        break;
      case 'call':
        this.onCallCmd = decodedMsg;
        // TODO: fill
        this.onCall();
        break;
      case 'createStream':
        this.onCreateStreamCmd = decodedMsg;
        this.onCreateStream();
        break;
      case 'publish':
        this.onPublishCmd = decodedMsg;
        this.onPublish();
        break;
      case 'play':
        this.onPlayCmd = decodedMsg;
        this.onPlay();
        break;
      case 'getStreamLength':
        break;
      case 'receiveAudio':
        this.receiveAudio(decodedMsg.bool);
        break;
      case 'receiveVideo':
        this.receiveVideo(decodedMsg.bool);
        break;
      case 'deleteStream':
        this.onDeleteStream(decodedMsg);
        break;
      case 'closeStream':
        this.onCloseStream(decodedMsg);
        break;
      default:
        break;
    }
  }

  onConnect() {
    // this.sendWindowACK(4294967293); // TODO: fix (2^32-1)
    // this.setPeerBandwidth(4294967293, 2); // TODO: why dynamic limit type?
    this.appname = this.onConnectCmd.cmdObj.app;
    this.startTimestamp = Date.now();
    this.sendWindowACK(5000000); // TODO: fix (2^32-1)
    this.sendBandWidth(5000000, LIMIT_TYPE_DYNAMIC);
    this.sendChunkSize(this.outChunkSize);
    this.pingInterval = setInterval(() => {
      this.sendPingRequest();
    }, TIMEOUT);
    this.sendConnect();
  }

  sendConnect() {
    this.sendConnectCmd.cmd = '_result';
    this.sendConnectCmd.transId = this.onConnectCmd.transId;
    this.sendConnectCmd.cmdObj = {
      // fmsVer
      // objectEncoding?
      fmsVer: 'FMS/3,0,1,123',
      capabilities: 31,
    };
    this.sendConnectCmd.info = {
      level: 'status',
      code: 'NetConnection.Connect.Success',
      description: 'Connection succeeded',
      objectEncoding: this.onConnectCmd.cmdObj.objectEncoding ? this.onConnectCmd.cmdObj.objectEncoding : 0,
    };
    // send message to client
    this.sendCmdMsg(0, 'sendConnect');
  }

  sendCmdMsg(msid, cmdName) { // packetise command msg (response) and then chunk it to send to client
    const pkt = packet.create();
    pkt.header.basicHeader.fmt = CHUNK_TYPE_0;
    pkt.header.basicHeader.csid = RTMP_CHANNEL_INVOKE; // TODO: declare const later (channel invoke)
    pkt.header.chunkMessageHeader.mtid = COMMAND_MESSAGE_AMF0; // TODO: why?
    pkt.header.chunkMessageHeader.msid = msid;
    switch (cmdName) {
      case 'sendConnect':
        pkt.payload = AMF.encodeAmf0Cmd(this.sendConnectCmd);
        break;
      case 'sendCall':
        pkt.payload = AMF.encodeAmf0Cmd(this.sendCallCmd);
        break;
      case 'sendCreateStream':
        pkt.payload = AMF.encodeAmf0Cmd(this.sendCreateStreamCmd);
        break;
      case 'sendPublish':
        pkt.payload = AMF.encodeAmf0Cmd(this.sendPublishCmd);
        break;
      case 'sendPlay':
        pkt.payload = AMF.encodeAmf0Cmd(this.sendPlayCmd);
        break;
      default: break;
    }
    // pkt.payload = AMF.encodeAmf0Cmd();
    pkt.header.chunkMessageHeader.plen = pkt.payload.length;
    const chunks = this.createChunks(pkt);
    this.socket.write(chunks);
  }

  onCall() { // runs RPC at the receiving end
    // TODO: fill
    this.sendCall();
  }

  sendCall() {
    // TODO: fill
    this.sendCallCmd.cmd = '_result';
    this.sendCallCmd.transId = this.onCallCmd.transId;
    this.sendCallCmd.cmdObj = null;
    this.sendCmdMsg(0, 'sendCall');
  }

  onCreateStream() {
    ++this.streams;
    this.sendCreateStream();
  }

  sendCreateStream() {
    this.sendCreateStreamCmd.cmd = '_result';
    this.sendCreateStreamCmd.transId = this.onCreateStreamCmd.transId;
    this.sendCreateStreamCmd.cmdObj = null;
    this.sendCreateStreamCmd.info = this.streams;
    this.sendCmdMsg(0, 'sendCreateStream');
  }

  pcmHandler(mtid, payload) {
    switch (mtid) {
      case SET_CHUNK_SIZE: {
        this.setChunkSize(payload);
        break;
      }
      case ABORT_MESSAGE: {
        this.abortMessage(payload);
        break;
      }
      case ACKNOWLEDGEMENT: {
        // this.receiveACK(payload);
        break;
      }
      case WINDOW_ACKNOWLEDGEMENT: {
        this.setWindowACKSize(payload);
        break;
      }
      case SET_PEER_BANDWIDTH: {
        // extract windowSize(4B) and limitType(1B) from payload
        const windowSize = payload.readUInt32BE(0, 4);
        const limitType = payload.readUInt8(4);
        // this.setPeerBandwidth(windowSize, limitType);
        break;
      }
      default:
        break;
    }
    return null;
  }

  // PCM 수신 시 사용되는 메서드들
  setChunkSize(payload) {
    const chunkSize = payload.readUInt32BE();
    this.chunkSize = chunkSize;
  }

  abortMessage(payload) {
    const csid = payload.readUInt32BE();
    this.packetList.delete(csid);
  }

  setWindowACKSize(payload) {
    const ackSize = payload.readUInt32BE();
    this.ackSize = ackSize;
  }

  setPeerBandwidth(windowSize, limitType) {
    switch (limitType) {
      case LIMIT_TYPE_HARD: {
        this.ackSize = windowSize;
        this.limitType = limitType;
        break;
      }
      case LIMIT_TYPE_SOFT: {
        if (this.ackSize > windowSize) {
          this.ackSize = windowSize;
          this.limitType = limitType;
        }
        break;
      }
      case LIMIT_TYPE_DYNAMIC: {
        if (this.limitType === LIMIT_TYPE_HARD) {
          this.ackSize = windowSize;
          this.limitType = limitType;
        }
        break;
      }
      default: break;
    }
  }

  // PCM 전송 시 사용되는 메서드들
  /* 1. 그동안 읽은 바이트 수 메시지
        디테일 설명 : ACK
        클라이언트/서버는 윈도우크기인 바이트 수를 받은 이후에 ACK 메시지를 보내야 한다.
        윈도우 크기는 보낸이가 ACK를 받지 못한 상태에서 보내는 최대 바이트 수이다.
        이것은 시퀀수 수인데 결국 지금까지 받은 바이트 수를 말한다. (최대 4B=2^32-1까지 표현)
   */

  sendChunkSize(size) {
    const buff = Buffer.from('02000000000004010000000000000000', 'hex');
    buff.writeUInt32BE(size, 12);
    this.socket.write(buff);
  }

  sendACK(bytes) {
    const buff = Buffer.from('02000000000004030000000000000000', 'hex');
    buff.writeUInt32BE(bytes, 12);
    this.socket.write(buff);
  }

  /* 2. 윈도우 크기 메시지
      클라이언트/서버는 상대가 보내는 데이터 사이즈를 제한하하기 위해 메시지를 보낸다.
  */
  sendWindowACK(wsize) {
    const buff = Buffer.from('02000000000004050000000000000000', 'hex');
    buff.writeUInt32BE(wsize, 12);
    this.socket.write(buff);
  }

  /* 3. 대역폭 조절 메시지
  대역폭제한 메시지를 받은 상대는 메시지 정보에 맞춰 대역폭을 줄인다.
  또한 윈도우 창크기를 조절했다는 ACK 사이즈 메시지(4B) + Limit type(1B)를 보내줘야한다.
  (윈도우 창크기가 대역폭 조절 사이즈와 다른경우)
  */
  sendBandWidth(limit, type) {
    const buff = Buffer.from('0200000000000506000000000000000000', 'hex');
    buff.writeUInt32BE(limit, 12);
    buff[16] = type;
    this.socket.write(buff);
  }

  checkACK(data) {
    this.inAck += data.length;

    if (this.inAck >= 0xf0000000) { // 왜 비트정렬이 1111 0000 0000 0000 ---인지
      this.inAck = 0;
      this.lastAck = 0;
    }

    // 정상적인 ACK 메시지 = 지금까지 받은 바이트 수를 보낸 경우
    if (this.ackSize > 0 && this.inAck - this.lastAck >= this.ackSize) {
      this.lastAck = this.inAck;
      this.sendACK(this.inAck);
    }
  }

  // USER CONTROL MESSAGES
  ucmHandler(payload) {
    const ucmType = payload.readUInt16BE();
    switch (ucmType) {
      case UCM_SET_BUFFER_LENGTH: {
        this.setBufferLength(payload);
        break;
      }
      case UCM_PING_RESPONSE: {
        this.pingResponse(payload);
        break;
      }
      default: break;
    }
  }

  // 서버가 클라이언트로 전송하는 UCM 메서드
  streamBegin(msid) {
    this.sendStreamStatus(UCM_STREAM_BEGIN, msid);
  }

  streamEOF(msid) {
    this.sendStreamStatus(UCM_STREAM_EOF, msid);
  }

  // 녹화가 실행되고 있는 cid를 클라이언트에 전송
  streamIsRecorded(msid) {
    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = RTMP_CHANNEL_PROTOCOL;
    newPacket.payload = Buffer.from([0, UCM_STREAM_IS_RECORDED, (msid >> 24) & 0xff, (msid >> 16) & 0xff, (msid >> 8) & 0xff, msid & 0xff]);
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;

    this.socket.write(this.createChunks(newPacket));
  }

  sendPingRequest() {
    const newPacket = packet.create();
    const timestampDelta = Date.now() - this.startTimestamp;
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = RTMP_CHANNEL_PROTOCOL;
    newPacket.payload = Buffer.from([0, UCM_PING_REQUEST, (timestampDelta >> 24) & 0xff, (timestampDelta >> 16) & 0xff, (timestampDelta >> 8) & 0xff, timestampDelta & 0xff]);
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;

    this.socket.write(this.createChunks(newPacket));
  }

  // 클라이언트로부터 수신한 UCM 처리 메서드
  setBufferLength(payload) {
    // 정확히 뭘 세팅하는건지 이해가 안됨.
  }

  pingResponse(payload) {
    const timestamp = payload.readUInt32BE();
    if (this.pingRequestTimestamp !== timestamp) this.stop();
    else this.pingRequestTimestamp = null;
  }

  sendStreamStatus(st, id) {
    let buf = Buffer.from('020000000000060400000000000000000000', 'hex');
    buf.writeUInt16BE(st, 12);
    buf.writeUInt32BE(id, 14);
    this.socket.write(buf);
  }

  // // 특정 청크 스트림에 데이터가 없음을 클라이언트에게 알리는 메서드
  // streamDry(csid) {
  //   const newPacket = packet.create();
  //   newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
  //   newPacket.header.basicHeader.csid = CSID_PROTOCOL_MESSAGE;
  //   newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
  //   newPacket.header.chunkMessageHeader.msid = MSID_PROTOCOL_MESSAGE;
  //   newPacket.payload = Buffer.from([0, UCM_STREAM_DRY, (csid >> 24) & 0xff, (csid >> 16) & 0xff, (csid >> 8) & 0xff, csid & 0xff]);

  //   newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
  //   this.socket.write(this.createChunks(newPacket));
  // }

  // NetStream
  /*
  명령어를 사용하는 때 : 클라이언트가 스트림을 새로 만들고자 할 때
  이름을 통해, 어떤 클라이언트든 해당 스트림에서 재생하고 오디오-비디오-데이터메시지를 받을 수 있다.
  구조 : Command Name(publish-String) + Transaction ID(0) + Command Object(null)
  + Publishing Name(string)
  + Publishing Type(String) :
  live(파일에 데이터를 기록하지 않고(recording) 라이브 데이터가 시작될 때)
  record(스트림이 생성되고 데이터가 새로운 파일로 써질 떄. 이 파일은 서버의 서브디렉토리(서버 실행파일을 포함하고 있는)에 저장된다.
  혹시나 파일이 이미 존재하는 경우에는, 덮어씌운다.)
  append(스트림이 생성되고 데이터가 파일에 덧붙여질 떄. 붙여질 파일이 존재하지 않으면 새로 생성한다)
  *서버는 publish 시작을 마킹하기 위해 onStatus 명령어로 응답한다.
*/
  onPublish() {
    // if (typeof msg.streamName !== 'string') return;
    if (typeof this.onPublishCmd.streamName !== 'string') return;

    // 서버의 서브디렉토리(서버 실행파일을 포함하고 있는)에 저장된다.
    this.publishStreamPath = `/${this.appname}`;
    this.publishStreamId = this.parsedPacket.header.chunkMessageHeader.msid;
    this.publishArgs = QueryString.parse(this.onPublishCmd.streamName.split('?')[1]);
    if (this.status[0] === 0) return;

    // 요청받은 publishStreamPath를 다른 송출자가 사용중인 경우
    if (CURRENT_PROGRESS.publishers.has(this.publishStreamPath)) {
      this.sendPublish('stream already publishing');
    } else if (this.status[1]) { // 현재 세션이 이미 publishing 중인 경우
      this.sendPublish('connection already publishing');
    } else {
      this.status[1] = 1; // isPublishing = true
      CURRENT_PROGRESS.publishers.set(this.publishStreamPath, this.id);
      this.sendPublish(`${this.publishStreamPath} now publishing`);

      for (const idlePlayerId of CURRENT_PROGRESS.idlePlayers) {
        const idlePlayerSession = CURRENT_PROGRESS.sessions.get(idlePlayerId);
        if (idlePlayerSession && idlePlayerSession.playStreamPath === this.publishStreamPath) {
          idlePlayerSession.startPlay();
          CURRENT_PROGRESS.idlePlayers.delete(idlePlayerId);
        }
      }

      // trans-server에 스트림 transmuxing 시작하라는 이벤트 전송
      CURRENT_PROGRESS.events.emit('postPublish', this.id, this.publishStreamPath, this.publishArgs);
    }
  }

  sendPublish(description) {
    this.sendPublishCmd.cmd = 'onStatus';
    this.sendPublishCmd.transId = 0;
    this.sendPublishCmd.cmdObj = null;
    switch (description) {
      case 'stream already publishing':
        this.sendPublishCmd.info.level = 'error';
        this.sendPublishCmd.info.code = 'NetStream.Publish.BadName';
        break;
      case 'connection already publishing':
        this.sendPublishCmd.info.level = 'error';
        this.sendPublishCmd.info.code = 'NetStream.Publish.BadConnection';
        break;
      case `${this.publishStreamPath} now publishing`:
        this.sendPublishCmd.info.level = 'status';
        this.sendPublishCmd.info.code = 'NetStream.Publish.Start';
        break;
      case `${this.publishStreamPath} now unpublished`:
        this.sendPublishCmd.info.level = 'status';
        this.sendPublishCmd.info.code = 'NetStream.Unpublish.Success';
        break;
      default: break;
    }
    this.sendPublishCmd.info.description = description;
    this.sendCmdMsg(this.publishStreamId, 'sendPublish');
  }

  onPlay() {
    if (typeof this.onPlayCmd.streamName !== 'string') {
      return;
    }

    // 이 스트림이 starting 상태가 아닌 경우
    if (!this.status[0]) {
      return;
    }

    this.playStreamPath = `/${this.appname}`;
    this.playStreamId = this.parsedPacket.header.chunkMessageHeader.msid;
    this.playArgs = QueryString.parse(this.onPlayCmd.streamName.split('?')[1]);

    console.log(`[on play] playstreampath = ${this.playStreamPath}`);
    console.log(`[on play] playstreamid = ${this.playStreamId}`);
    console.log(`[on play] playstreamargs = ${this.playStreamArgs}`);

    // 이 스트림이 play중인 경우 (play 요청이 중복된 경우)
    if (this.status[2]) {
      console.log(`[RTMP SESSION] id=${this.id}. Connection already playing`);
      this.sendPlay('Connection already playing');
    } else {
      this.sendPlay(`${this.playStreamPath} now playing`);
    }

    if (CURRENT_PROGRESS.publishers.has(this.playStreamPath)) {
      this.startPlay();
    } else {
      // TODO: 아직 방송하지 않은 스트림 경로로 play요청이 들어온 경우
      this.status[3] = 1;
      CURRENT_PROGRESS.idlePlayers.add(this.id);
    }
  }

  startPlay() {
    const publisherSessionId = CURRENT_PROGRESS.publishers.get(this.playStreamPath);
    const publisherSession = CURRENT_PROGRESS.sessions.get(publisherSessionId);
    publisherSession.players.add(this.id);
    console.log(`[startPlay] Add ${this.id} to publisher ${publisherSessionId}`);
    console.log(`[startPlay] ${publisherSessionId} 's players list`);
    console.log(publisherSession.players);

    // metadata를 이 세션에 참여중인 시청자에게 전송
    if (publisherSession.metaData !== null) {
      const newPacket = packet.create();
      newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
      newPacket.header.basicHeader.csid = RTMP_CHANNEL_DATA;
      newPacket.payload = publisherSession.metaData;
      newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
      newPacket.header.chunkMessageHeader.msid = this.playStreamId;
      newPacket.header.chunkMessageHeader.mtid = DATA_MESSAGE_AMF0;
      // console.log('[startPlay] metadata');
      // console.log(newPacket);
      const chunks = this.createChunks(newPacket);
      this.socket.write(chunks);
      console.log('[startPlay] send metaData!');
      // console.log(chunks);
    }

    if (publisherSession.audioCodec === 10) {
      if (!publisherSession.aacSequenceHeader) {
        console.log('acc sequence header is null');
      }
      const newPacket = packet.create();
      newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
      newPacket.header.basicHeader.csid = RTMP_CHANNEL_AUDIO;
      newPacket.payload = publisherSession.aacSequenceHeader;
      newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
      newPacket.header.chunkMessageHeader.msid = this.playStreamId;
      newPacket.header.chunkMessageHeader.mtid = AUDIO_MESSAGE;
      const chunks = this.createChunks(newPacket);
      console.log(`[startPlay] Send audio header to ${this.id}`);
      this.socket.write(chunks);
    }

    if (publisherSession.videoCodec === 7 || publisherSession.videoCodec === 12) {
      if (!publisherSession.avcSequenceHeader) {
        console.log('avc sequence header is null');
      }
      const newPacket = packet.create();
      newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
      newPacket.header.basicHeader.csid = RTMP_CHANNEL_VIDEO;
      newPacket.payload = publisherSession.avcSequenceHeader;
      newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
      newPacket.header.chunkMessageHeader.msid = this.playStreamId;
      newPacket.header.chunkMessageHeader.mtid = VIDEO_MESSAGE;
      const chunks = this.createChunks(newPacket);
      console.log(`[startPlay] Send video header to ${this.id}`);
      this.socket.write(chunks);
    }

    this.status[2] = 1; // isPlaying = true
    this.status[3] = 0; // isIdling = false
  }

  sendPlay(description) {
    this.sendPlayCmd.cmd = 'onStatus';
    this.sendPlayCmd.transId = 0;
    this.sendPlayCmd.cmdObj = null;
    switch (description) {
      case 'Connection already playing':
        this.sendPlayCmd.info.level = 'error';
        this.sendPlayCmd.info.code = 'Netstream.Play.BadConnection';
        this.sendPlayCmd.info.description = description;
        this.sendCmdMsg(this.playStreamId, 'sendPlay');
        break;
      case `${this.playStreamPath} now playing`:
        this.sendPlayCmd.info.level = 'status';

        // send streambegin command message
        this.streamBegin(this.playStreamId);

        // send play-reset command message
        this.sendPlayCmd.info.code = 'Netstream.Play.Reset';
        this.sendPlayCmd.info.description = 'Playing and resetting stream';
        this.sendCmdMsg(this.playStreamId, 'sendPlay');

        // send play-start command message
        this.sendPlayCmd.info.code = 'Netstream.Play.Start';
        this.sendPlayCmd.info.description = 'Started playing stream';
        this.sendCmdMsg(this.playStreamId, 'sendPlay');
        // send cmdmsg last line

        // this.sendSampleAccess(this.playStreamId);
        this.sendSampleAccess(this.playStreamId);
        break;
      case `${this.playStreamPath} now stopped`:
        this.sendPlayCmd.level = 'status';
        this.sendPlayCmd.code = 'NetStream.Play.Stop';
        this.sendPlayCmd.description = description;
        this.sendCmdMsg(this.playStreamId, 'sendPlay');
        break;
      case 'Streamer unpublished stream':
        this.sendPlayCmd.level = 'status';
        this.sendPlayCmd.code = 'NetStream.Play.UnpublishNotify';
        this.sendPlayCmd.description = description;
        this.sendCmdMsg(this.playStreamId, 'sendPlay');
        break;
      default: break;
    }
  }

  sendSampleAccess(msid) {
    let newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = RTMP_CHANNEL_DATA;
    newPacket.header.chunkMessageHeader.mtid = DATA_MESSAGE_AMF0;
    newPacket.payload = AMF.encodeAmf0Data(this.sendSampleAccessCmd);
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
    newPacket.header.chunkMessageHeader.msid = msid;
    const chunks = this.createChunks(newPacket);
    this.socket.write(chunks);
  }

  receiveAudio(bool) {
    console.log(`[RECEIVE AUDIO] ${this.id} audio set changed`);
    console.log(`[RECEIVE AUDIO] bool = ${bool}`);
    this.status[5] = bool;
  }

  receiveVideo(bool) {
    console.log(`[RECEIVE VIDEO] ${this.id} video set changed`);
    console.log(`[RECEIVE VIDEO] bool = ${bool}`);
    this.status[6] = bool;
  }

  onCloseStream() {
    //red5-publisher
    let closeStream = { streamId: this.parserPacket.header.chunkMessageHeader.msid };
    this.onDeleteStream(closeStream);
  }

  onDeleteStream(msg) {
    // 0(is Start?, false : 0) 0(is Publishing?, false : 1) 0(is Playing?, false : 2) 0(is Idling?, false : 3) 0(is Pausing?, false : 4)
    // 1(is Receiving Audio?, true : 5) 1(is Receiving Video?, true : 6)
    if (msg.streamId === this.playStreamId) {
      if (this.status[3]) {
        CURRENT_PROGRESS.idlePlayers.delete(this.id);
        this.status[3] = 0; // set false
      } else { // 스트림 생성자인 경우
        const publisherId = CURRENT_PROGRESS.publishers.get(this.playStreamPath);
        if (publisherId) {
          CURRENT_PROGRESS.sessions.get(publisherId).players.delete(this.id);
        }
        this.status[2] = 0; // playing stop, set false
      }

      if (this.status[0]) {
        this.sendPlay(`${this.playStreamId} now stopped`); // "NetStream.Play.Stop" 상태메시지 보내기 - 흠 스펙에서는 안보낸다구 하던뎅
      }
      this.playStreamId = 0;
      this.playStreamPath = '';
    }

    if (msg.streamId === this.publishStreamId) {
      if (this.status[1]) {
        if (this.status[0]) {
          this.sendPublish(`${this.publishStreamId} now unpublished`); // "NetStream.Unpublish.Success" 상태메시지 보내기
        }

        for (const playerId of this.players) {
          const playerSession = CURRENT_PROGRESS.sessions.get(playerId);
          playerSession.sendPlay('Streamer unpublished stream'); // "NetStream.Play.UnpublishNotify" 상태메시지

          // CURRENT_PROGRESS.idlePlayers.add(playerId);
          // playerSession.status[2] = 0; // not playing
          // playerSession.status[3] = 1; // true idling

          playerSession.streamEOF(playerSession.playStreamId);
          playerSession.stop();

          // session.flush();
        }

        CURRENT_PROGRESS.publishers.delete(this.publishStreamPath);

        this.players.clear();
        this.status[1] = 0; // not publishing
      }

      this.publishStreamId = 0;
      this.publishStreamPath = '';
    }
  }

  /* about audio, video */
  audioHandler(payload) {
    // payload = payload.slice(0, payload.length); // (!)header.length
    // payload = payload.slice(0, this.parsedPacket.header.chunkMessageHeader.plen);
    const soundFormat = (payload[0] >> 4) & 0x0f;
    const soundRate = (payload[0] >> 2) & 0x03;
    const soundSize = (payload[0] >> 1) & 0x01;
    let soundType = (payload[0]) & 0x01;

    // (!)check if first audio received
    if (this.audioCodec === 0) {
      this.audioCodec = soundFormat;
      this.audioCodecName = AUDIO_CODEC_NAME[soundFormat];
      this.audioSampleRate = AUDIO_SOUND_RATE[soundRate];
      soundType += 1;
      this.audioChannels = soundType; // necessary?

      if (soundFormat === 4) { // Nellymoser 16k-Hz mono
        this.audioSampleRate = 16000;
      } else if (soundFormat === 5) { // Nellymoser 8k-Hz mono
        this.audioSampleRate = 8000;
      } else if (soundFormat === 11) { // Speex
        this.audioSampleRate = 16000;
      } else if (soundFormat === 14) { // MP3 8-kHz
        this.audioSampleRate = 8000;
      }

      console.log(`[audio handler] audioCodec = ${this.audioCodec}, audioCodecName = ${this.audioCodecName}, audioSampleRate = ${this.audioSampleRate}, audioChannels = ${this.audioChannels}`);
    }

    // if not AAC, print info

    // AACPacketType
    // 0 : AACSequenceHeader, 1 : AAC raw
    // if AACPacketType == 0, AudioSpecificConfig
    // else if AACPacketType == 1, Raw AAC fream data
    if (soundFormat === 10 && payload[1] === 0) {
      this.aacSequenceHeader = Buffer.alloc(payload.length);
      payload.copy(this.aacSequenceHeader);
      const aacInfo = AV.readAACSpecificConfig(this.aacSequenceHeader);
      this.audioProfileName = AV.getAACProfileName(aacInfo);
      this.audioSampleRate = aacInfo.sample_rate;
      this.audioChannels = aacInfo.channels;
      // if AAC, print info
    }

    // // repackaging
    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = RTMP_CHANNEL_AUDIO;
    newPacket.header.chunkMessageHeader.mtid = AUDIO_MESSAGE;
    newPacket.payload = payload; // payload of received parsePacket
    // packet.payload.length = packet.payload.length; // (!)header.length // TODO: no-self-assign eslint 오류. 수정 요망
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
    newPacket.header.chunkMessageHeader.timestamp = this.parsedPacket.timestamp;
    const chunks = this.createChunks(newPacket);

    for (const playerId of this.players) {
      const playerSession = CURRENT_PROGRESS.sessions.get(playerId);

      if (playerSession.piledAVDataNum === 0) {
        playerSession.socket.cork();
      }

      // 시청자가 isStarting, isPlaying, !isPausing 만족 시
      if (playerSession.status[0] && playerSession.status[2] && !playerSession.status[4] && playerSession.status[5]) {
        chunks.writeUInt32LE(playerSession.playStreamId, 8); // 시청자마다 플레이중인 스트림 아이디가 다름.
        playerSession.socket.write(chunks);
      }

      ++playerSession.piledAVDataNum;

      if (playerSession.piledAVDataNum === 10) {
        process.nextTick(() => playerSession.socket.uncork());
        playerSession.piledAVDataNum = 0;
      }
    }

    // (!)player session buffer cork()
  }

  videoHandler(payload) {
    // payload = payload.slice(0, payload.length); // (!)header.length
    // payload = payload.slice(0, this.parsedPacket.header.chunkMessageHeader.plen);
    const frameType = (payload[0] >> 4) & 0x0f;
    const codecId = payload[0] & 0x0f;

    // AVC(H.264)
    // (!) codecID === 12, HEVC(H.265)
    if (codecId === 7 || codecId === 12) {
      if (frameType === 1 && payload[1] === 0) {
        this.avcSequenceHeader = Buffer.alloc(payload.length);
        payload.copy(this.avcSequenceHeader);
        const avcInfo = AV.readAVCSpecificConfig(this.avcSequenceHeader);
        console.log('avcSequenceHeader');
        console.log(this.avcSequenceHeader);
        this.videoWidth = avcInfo.width;
        this.videoHeight = avcInfo.height;
        this.videoProfileName = AV.getAVCProfileName(avcInfo);
        this.videoLevel = avcInfo.level;
      }
    }

    // if this is first arrival
    if (this.videoCodec === 0) {
      this.videoCodec = codecId;
      this.videoCodecName = VIDEO_CODEC_NAME[codecId];
      // print vidoe info
    }

    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = RTMP_CHANNEL_VIDEO;
    newPacket.header.chunkMessageHeader.mtid = VIDEO_MESSAGE;
    newPacket.payload = payload; // payload of received parsePacket
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
    newPacket.header.chunkMessageHeader.timestamp = this.parsedPacket.timestamp;
    const chunks = this.createChunks(newPacket);

    for (const playerId of this.players) {
      const playerSession = CURRENT_PROGRESS.sessions.get(playerId);

      if (playerSession.piledAVDataNum === 0) {
        playerSession.socket.cork();
      }

      // 시청자가 isStarting, isPlaying, !isPausing 만족 시
      if (playerSession.status[0] && playerSession.status[2] && !playerSession.status[4] && playerSession.status[6]) {
        chunks.writeUInt32LE(playerSession.playStreamId, 8); // 시청자마다 플레이중인 스트림 아이디가 다름.
        playerSession.socket.write(chunks);
      }

      ++playerSession.piledAVDataNum;

      if (playerSession.piledAVDataNum === 10) {
        process.nextTick(() => playerSession.socket.uncork());
        playerSession.piledAVDataNum = 0;
      }
    }

    // (!)session? address?
  }

  dataHandler(mtid, payload) {
    const offset = mtid === DATA_MESSAGE_AMF3 ? 1 : 0;
    payload = payload.slice(offset, this.parsedPacket.header.chunkMessageHeader.plen);
    const dataMessage = AMF.decodeAmf0Data(payload);
    console.log('dataMessage');
    console.log(dataMessage);
    switch (dataMessage.cmd) {
      case '@setDataFrame': {
        if (dataMessage.dataObj) {
          this.audioSamplerate = dataMessage.dataObj.audiosamplerate;
          this.audioChannels = dataMessage.dataObj.stereo ? 2 : 1;
          this.videoWidth = dataMessage.dataObj.width;
          this.videoHeight = dataMessage.dataObj.height;
          this.videoFps = dataMessage.dataObj.framerate;
        }

        const opt = {
          cmd: 'onMetaData',
          dataObj: dataMessage.dataObj,
        };
        this.metaData = AMF.encodeAmf0Data(opt);
        console.log(this.metaData);

        const newPacket = packet.create();
        newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
        newPacket.header.basicHeader.csid = RTMP_CHANNEL_DATA;
        newPacket.header.chunkMessageHeader.mtid = DATA_MESSAGE_AMF0;
        newPacket.payload = this.metaData;
        newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
        newPacket.header.chunkMessageHeader.timestamp = this.parsedPacket.timestamp;
        console.log('[data handler] new packet');
        console.log(newPacket);
        const chunks = this.createChunks(newPacket);

        for (const playerId of this.players) {
          const playerSession = CURRENT_PROGRESS.sessions.get(playerId);

          // 시청자가 isStarting, isPlaying, !isPausing 만족 시
          if (playerSession.status[0] && playerSession.status[2] && !playerSession.status[4]) {
            console.log(`[setDataFrame] sending metadata to viewer ${playerId}`);
            console.log(chunks);
            chunks.writeUInt32LE(playerSession.playStreamId, 8); // 시청자마다 플레이중인 스트림 아이디가 다름.
            playerSession.socket.write(chunks);
          }
        }

        break;
      }
      default: break;
    }
  }
}

module.exports = RTMP_SESSION;
