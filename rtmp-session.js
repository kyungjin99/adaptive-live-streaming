const HANDSHAKE = require('./rtmp-handshake');
const AMF = require('node-amfutils');
const CURRENT_PROGRESS = require('./rtmp_center_ad');
const GENERATOR = require('./rtmp_center_gen');
const AV = require('./rtmp-av');
const { AUDIO_SOUND_RATE, AUDIO_CODEC_NAME, VIDEO_CODEC_NAME } = require('./rtmp-av');

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
const MSID_PROTOCOL_MESSAGE = 0;

const RTMP_CHUNK_TYPE_0 = 0; // 11-bytes: timestamp(3) + length(3) + stream type(1) + stream id(4)
const RTMP_CHUNK_TYPE_1 = 1; // 7-bytes: delta(3) + length(3) + stream type(1)
const RTMP_CHUNK_TYPE_2 = 2; // 3-bytes: delta(3)
const RTMP_CHUNK_TYPE_3 = 3; // 0-byte
const RTMP_CHANNEL_AUDIO = 4;
const RTMP_CHANNEL_VIDEO = 5;
const RTMP_CHANNEL_DATA = 6;
const RTMP_TYPE_AUDIO = 8;
const RTMP_TYPE_VIDEO = 9;
const RTMP_TYPE_FLEX_STREAM = 15; // AMF3
const RTMP_TYPE_DATA = 18; // AMF0

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
    };
  },
};

const cmdStructure = {
  onConnectCmd: () => {
    return {
      cmd,
      transId: 1,
      cmdObj,
      args: null,
    };
  },
  sendConnectCmd: () => {
    return {
      cmd: '_result',
      transId: 1,
      cmdObj,
      info,
    };
  },
  onCallCmd: () => {
    return {
      cmd,
      transId,
      cmdObj,
      args: null,
    };
  },
  sendCallCmd: () => {
    return {
      cmd: '_result',
      transId,
      cmdObj,
      info,
    };
  },
  onCreateStreamCmd: () => {
    return {
      cmd: 'createStream',
      transId,
      cmdObj,
    }
  },
  sendCreateStreamCmd: () => {
    return {
      cmd: '_result',
      transId,
      cmdObj,
      info,
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
    this.startTimestamp = Date.now();

    this.chunkSize = 128; // max bytes of data in a chunk (default 128)

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

    // ?
    this.packetList = new Map();
    this.limitType = LIMIT_TYPE_HARD;
    this.startTimestamp = null;
    this.pingRequestTimestamp = null;

    // net stream
    this.nowStreamId = 0;
    this.nowStreamPath= "";
    this.nowArgs = {};
    this.publishStreamId = 0;
    this.publishStreamPath = "";
    this.publishArgs = {};
    this.status = Buffer.from('0000011', 'binary'); // range 0 ~ 6
    // 0(is Start?, false) 0(is Publishing?, false) 0(is Playing?, false) 0(is Idling?, false) 0(is Pausing?, false)
    // 1(is Receiving Audio?, true) 1(is Receiving Video?, true)

    // TODO: flv에 쓰이는 변수들..? 확인 필요
    this.players = new Set();
    CURRENT_PROGRESS.sessions.set(this.id, this);
  }

  run() {
    this.socket.on('data', this.onSocketData.bind(this));
    this.socket.on('error', this.onSocketError.bind(this));
    this.socket.on('timeout', this.onSocketTimeout.bind(this));
    this.socket.on('close', this.onSocketClose.bind(this));
  }

  stop() {
    // TODO: 종료 시 추가적인 처리가 필요한가?
    this.socket.close();
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
    let dataOffset = readBytes; // current offset of a chunk data received

    while (dataOffset < length) { // until finishing reading chunk

      this.checkAck(data); // TODO: 이 위치에 들어가는게 맞는지 확인 필요

      switch (this.parsingState) {
        case PARSE_INIT: { // to parse a chunk basic header, you need to know how big it is
          this.parsedChunkBuf[0] = data[readBytes + dataOffset]; // read 1 byte from data and write to buf
          this.bytesParsed += 1;
          const bheaderType = this.parsedChunkBuf[0] & 0X3F; // the bottom 6 bits of the first byte
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
              endpoint = 11;
              break;
            case 1:
              endpoint = 7;
              break;
            case 2:
              endpoint = 3;
              break;
            case 3:
              endpoint = 0;
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
            while (this.bytesParsed < endpoint && dataOffset < length) {
              this.parsedChunkBuf[this.bytesParsed] = data[readBytes + dataOffset]; // reading extended timestamp
              this.bytesParsed += 1;
              dataOffset += 1;
            }
            if (this.bytesParsed >= endpoint) {
              this.parsedPacket.header.chunkMessageHeader.timestamp = this.parsedChunkBuf.readUInt32BE(endpoint - 4);
            }
          }
          this.parsingState = PARSE_PAYLOAD; // move on to the next step
          break;
        }
        case PARSE_PAYLOAD: { // parse payload
          const size = length - dataOffset;
          // TODO: check payload size and realloc
          data.copy(this.parsedPacket.payload, this.bytesParsed, dataOffset, dataOffset + size);
          this.bytesParsed += size;
          dataOffset += size;

          const totalPayloadSize = this.bytesParsed - (this.bheaderSize + this.mheaderSize + this.useExtendedTimestamp);
          if (totalPayloadSize >= this.parsedPacket.header.chunkMessageHeader.plen) {
            this.parsingState = PARSE_INIT; // finished reading a chunk. restart the parsing cycle
            dataOffset = 0;

            this.handler();

            // clear parsedPacket
            this.bytesParsed = 0;
            this.parsedPacket = packet.create();
            this.handler();
          }
          break;
        }
        default: break;
      }
    }
  }

  parseChunkBasicHeader() { // fmt, csid
    const { bheaderSize } = this;
    const fmt = this.parsedChunkBuf[0] >> 6;
    this.parsedPacket.header.basicHeader.fmt = fmt; // parse fmt

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
    this.parsedPacket.header.basicHeader.csid = csid;
  }

  parseChunkMessageHeader() {
    const { fmt } = this.parsedPacket.header.basicHeader; // chunk type
    let offset = this.bheaderSize;

    // read timestamp (delta) field except for type3 chunks
    if (fmt < CHUNK_TYPE_3) {
      const timestamp = this.parsedChunkBuf.readUIntBE(offset, 3);
      if (timestamp !== 0XFFFFFF) {
        this.parsedPacket.header.chunkMessageHeader.timestamp = timestamp;
      } else { // uses extended timestamp
        this.parsedPacket.header.chunkMessageHeader.timestamp = 0XFFFFFF;
      }
      offset += 3;
      this.mheaderSize += 3;
    }

    // read message length and message stream id field for type 0, type 1 chunks
    if (fmt < CHUNK_TYPE_2) {
      this.parsedPacket.header.chunkMessageHeader.timestamp = this.parsedChunkBuf.readUIntBE(offset, 3);
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
    } else if (csid >= 64 && csid <= 319) { // chunk basic header 2
      buf = Buffer.alloc(2);
      buf[0] = (fmt << 6) | 0;
      buf[1] = (csid - 64) & 0XFF;
    } else if (csid >= 64 && csid <= 65599) { // chunk basic header 3
      buf = Buffer.alloc(3);
      buf[0] = (fmt << 6) | 1;
      buf[1] = (csid - 64) & 0xFF;
      buf[2] = ((csid - 64) << 8) & 0xFF;
    }
    return buf;
  }

  createChunkMessageHeader(header) {
    const { bheader, mheader } = header;
    const {
      timestamp, mlen, mtid, msid,
    } = mheader;
    let buf;

    const ctype = bheader.fmt; // get chunk type from fmt in chunk basic header
    switch (ctype) {
      case CHUNK_TYPE_0: // timestamp: 3B, message length: 3B, message type: 1B message stream: 4B
        buf = Buffer.alloc(11);
        buf.writeUInt32LE(msid, 7); // message stream id (stored in little endian)
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
      if (timestamp >= 0XFFFFFF) { // extended timestamp
        buf.writeUIntBE(0XFFFFFF, 0, 3);
      } else {
        buf.writeUIntBE(timestamp, 0, 3);
      }
    }

    // add message length and message type id field for type 0, type 1 chunks
    if (ctype < CHUNK_TYPE_2) {
      buf.writeUIntBE(mlen, 3, 3); // message length
      buf.writeUInt8(mtid, 6); // message type id
    }

    return buf;
  }


  createChunks(packet) { // create chunks from a packet and interleave them in a buffer
    // calculate the size of header and payload
    let totalBufSize = 0; // to allocate buffer
    const { header, payload } = packet;
    const bheaderBuf = this.createChunkBasicHeader(header.basicHeader);
    const mheaderBuf = this.createChunkMessageHeader(header.chunkMessageHeader);
    const bheaderSize = bheaderBuf.length; // size of chunk basic header
    const mHeaderSize = mheaderBuf.length; // size of chunk message header
    const useExtendedTimestamp = (header.chunkMessageHeader.timestamp > 0XFFFFFF) ? 4 : 0;
    const extendedTimestampBuf = Buffer.alloc(useExtendedTimestamp);
    const payloadSize = header.chunkMessageHeader.plen; // size of payload in packet
    let bufOffset = 0; // buffer offset
    let payloadOffset = 0; // payload offset

    if (extendedTimestampBuf) {
      extendedTimestampBuf.writeUInt32BE(header.chunkMessageHeader.timestamp);
    }

    // calculate the number of chunks
    const numOfChunks = Math.floor(header.chunkMessageHeader.plen / this.chunkSize);
    totalBufSize = bheaderSize + mHeaderSize + extendedTimestampBuf.length; // first chunk size
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
    if (payloadSize > this.chunkSize) { // write payload
      buf.write(payload, bufOffset, this.chunkSize); // write payload up to max chunk size
      payloadOffset += this.chunkSize;
    } else {
      buf.write(payload, bufOffset, payloadSize); // write the whole payload if possible
    }

    if (numOfChunks > 1) { // create type 3 chunks
      const { csid } = header.basicHeader;
      const t3bheader = this.createChunkBasicHeader(packet.create(3, csid).header);
      for (let i = 1; i <= numOfChunks; i += 1) {
        // write chunk type 3 header (create only basic header)
        t3bheader.copy(buf, bufOffset, 0, t3bheader.length);
        bufOffset += t3bheader.length;
        // write extended timestamp
        if (useExtendedTimestamp) {
          extendedTimestampBuf.copy(buf, bufOffset, 0, useExtendedTimestamp);
          bufOffset += 4;
        }
        // write partial payloads
        if (payloadSize - payloadOffset) { // partial payload size < chunk size
          payload.copy(buf, bufOffset, payloadOffset, payloadSize - 1);
        } else { // partial payload size >= chunk size
          payload.copy(buf, bufOffset, payloadOffset, payloadOffset + this.chunkSize);
        }
        payloadOffset += this.chunkSize;
      }
    }
    return buf;
  }

  handler() {
    const { mtid } = this.parsedPacket.header.chunkMessageHeader.mtid;
    const { payload } = this.parsedPacket;
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
      default: break;
    }
  }

  parseCmdMsg(amfType, payload) {
    const amf = (amfType == COMMAND_MESSAGE_AMF0) ? 0 : 3;
    // decode payload data according to AMF
    const decodedMsg = (amf === 0) ? AMF.decodeAmf0Cmd(payload) : AMF.decodeAmf3Cmd(payload);
    const cmdName = decodedMsg.cmd;
    const transactionId = decodedMsg.transId;
    const cmdObj = decodedMsg.cmdObj; // transactionId랑 commandObject는 무조건 있음. 그래서 따로 빼도 됨

    switch (cmdName) {
      case 'connect':
        this.onConnectCmd.cmd = 'connect';
        this.onConnectCmd.cmdObj = cmdObj;
        this.onConnectCmd.cmdObj.app = cmdObj.app;
        this.onConnectCmd.cmdObj.objectEncoding = (cmdObj.objectEncoding != null) ? cmdObj.objectEncoding : 0;
        this.onConnect();
        break;
      case 'call':
        this.onCallCmd.cmd = 'call';
        this.onCallCmd.transId = decodedMsg.transId;
        this.onCallCmd.cmdObj = cmdObj;
        this.onCallCmd.cmdObj.app = cmdObj.app;
        this.onCallCmd.cmdObj.objectEncoding = (cmdObj.objectEncoding != null) ? cmdObj.objectEncoding : 0;
        // TODO: fill
        this.onCall();
        break;
      case 'createStream':
        this.onCreateStreamCmd.cmd = 'createStream';
        this.onCreateStreamCmd.cmdObj = cmdObj;
        this.onCreateStreamCmd.cmdObj.app = cmdObj.app;
        this.onCreateStreamCmd.cmdObj.objectEncoding = (cmdObj.objectEncoding != null) ? cmdObj.objectEncoding : 0;
        this.onCreateStream();
        break;
      default:
        break;
    }
  }

  onConnect() {
    this.sendWindowACK(4294836224); // TODO: fix (2^32-1)
    this.setPeerBandwidth(4294836224, 2); // TODO: why dynamic limit type?
    this.sendConnect();
  }

  sendConnect() {
    this.sendConnectCmd.cmd = '_result';
    this.sendConnectCmd.transId = 1;
    this.sendConnectCmd.cmdObj = {
      // fmsVer
      // objectEncoding?
    };
    this.sendConnectCmd.info = {
      level: 'status',
      code: 'NetConnection.Connect.Success',
      description: 'Connection succeeded',
    };
    // send message to client
    this.sendCmdMsg('sendConnect');
  }

  sendCmdMsg(cmdName) { // packetise command msg (response) and then chunk it to send to client
    const pkt = packet.create();
    pkt.header.basicHeader.fmt = CHUNK_TYPE_0;
    pkt.header.basicHeader.csid = 3; // TODO: declare const later (channel invoke)
    pkt.header.chunkMessageHeader.mtid = COMMAND_MESSAGE_AMF0; // TODO: why?
    pkt.header.chunkMessageHeader.msid = 0;
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
      default: break;
    }
    pkt.payload = AMF.encodeAmf0Cmd();
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
    this.sendCmdMsg('sendCall');
  }

  onCreateStream() {
    this.sendCreateStream();
  }

  sendCreateStream() {
    this.sendCreateStreamCmd.cmd = '_result';
    this.sendCreateStreamCmd.transId = this.onCreateStreamCmd.transId;
    this.sendCreateStreamCmd.cmdObj = null;
    this.sendCmdMsg('sendCreateStream');
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
        const windowSize = this.parsedPacket.payload.readUInt32BE(0, 4);
        const limitType = this.parsedPacket.payload.readUInt8(4);
        this.setPeerBandwidth(windowSize, limitType);
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

  /*
    PCM 전송 시 사용되는 메서드들
  */
  /* 1. 그동안 읽은 바이트 수 메시지
        디테일 설명 : ACK
        클라이언트/서버는 윈도우크기인 바이트 수를 받은 이후에 ACK 메시지를 보내야 한다.
        윈도우 크기는 보낸이가 ACK를 받지 못한 상태에서 보내는 최대 바이트 수이다.
        이것은 시퀀수 수인데 결국 지금까지 받은 바이트 수를 말한다. (최대 4B=2^32-1까지 표현)
    */
  sendACK(bytes) {
    let buff = Buffer.from("02000000000004030000000000000000", "hex");
    buff.writeUInt32BE(bytes, 12);
    this.socket.write(buff);
  }

  /* 2. 윈도우 크기 메시지
      클라이언트/서버는 상대가 보내는 데이터 사이즈를 제한하하기 위해 메시지를 보낸다.
  */
  rtmpWindowACK(wsize) {
    let buff = Buffer.from("02000000000004050000000000000000", "hex");
    buff.writeUInt32BE(size, 12);
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

  checkAck(data) {
    this.inAck += data.length;

    if(this.inAck >= 0xf0000000) { //왜 비트정렬이 1111 0000 0000 0000 ---인지
        this.inAck = 0;
        this.lastAck = 0;
    }

    // 정상적인 ACK 메시지 = 지금까지 받은 바이트 수를 보낸 경우
    if(this.ackSize > 0 && this.inAck - this.lastAck >= this.ackSize) {
        this.lastAck = this.inAck;
        this.sendACK(this.inAck)
    }
  }



  // USER CONTROL MESSAGES
  ucmHandler(payload) {
    const ucmType = payload.readUInt16BE();
    switch(ucmType) {
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
  streamBegin(csid) {
    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = MSID_PROTOCOL_MESSAGE;
    newPacket.payload = Buffer.from([0, UCM_PING_RESPONSE, (csid >> 24) & 0xff, (csid >> 16) & 0xff, (csid >> 8) & 0xff, csid & 0xff]);
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;

    this.socket.write(this.createChunks(newPacket));
  }

  streamEOF(cid) { // playback할 데이터가 없음을 알려주는 메서드. 필요없을듯?
    return null; // temp
  }

  // 특정 청크 스트림에 데이터가 없음을 클라이언트에게 알리는 메서드
  streamDry(csid) {
    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = MSID_PROTOCOL_MESSAGE;
    newPacket.payload = Buffer.from([0, UCM_STREAM_DRY, (csid >> 24) & 0xff, (csid >> 16) & 0xff, (csid >> 8) & 0xff, csid & 0xff]);

    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;
    this.socket.write(this.createChunks(newPacket));
  }

  // 녹화가 실행되고 있는 cid를 클라이언트에 전송
  streamIsRecorded(csid) {
    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = MSID_PROTOCOL_MESSAGE;
    newPacket.payload = Buffer.from([0, UCM_STREAM_IS_RECORDED, (csid >> 24) & 0xff, (csid >> 16) & 0xff, (csid >> 8) & 0xff, csid & 0xff]);
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;

    this.socket.write(this.createChunks(newPacket));
  }

  pingRequest() {
    const newPacket = packet.create();
    const timestampDelta = Date.now() - this.startTimestamp;
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.csid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = MSID_PROTOCOL_MESSAGE;
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

  //NetStream
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
  publish(msg) {
    if (typeof msg.streamName !== 'string') return;

    //서버의 서브디렉토리(서버 실행파일을 포함하고 있는)에 저장된다.
    this.publishStreamPath = '/' + this.appname + '/' + msg.streamName.split('?')[0];
    this.publishStreamId = this.parsedPacket.header.chunkMessageHeader.msid;
    if (this.status[0] === 0) return;
    //if(this.)
  }

  receiveAudio(msg) {
    this.status[5] = msg.bool;
  }

  receiveVideo(msg) {
    this.status[6] = msg.bool;
  }

  deleteStream(msg) {
    // 0(is Start?, false : 0) 0(is Publishing?, false : 1) 0(is Playing?, false : 2) 0(is Idling?, false : 3) 0(is Pausing?, false : 4)
    // 1(is Receiving Audio?, true : 5) 1(is Receiving Video?, true : 6)
    if (msg.streamId === this.nowStreamId) {
      if (this.status[3]) {
        CURRENT_PROGRESS.idlePlayers.delete(this.id);
        this.status[3] = 0; // set false
      } else { // 스트림 생성자인 경우
        const publisherId = CURRENT_PROGRESS.publishers.get(this.nowStreamPath);
        if (publisherId !== null) {
          CURRENT_PROGRESS.sessions.get(publisherId).players.delete(this.id);
        }
        this.status[2] = 0; // playing stop, set false
      }

      if (this.status[0]) {
        this.sendStatus(); // "NetStream.Play.Stop" 상태메시지 보내기 - 흠 스펙에서는 안보낸다구 하던뎅
      }
      this.nowStreamId = 0;
      this.nowStreamPath = '';
    }

    if (msg.streamId === this.publishStreamId) {
      if (this.status[1]) {
        if (this.status[0]) {
          this.sendStatus(); // "NetStream.Unpublish.Success" 상태메시지 보내기
        }

        for(let participantId of this.players) {
          const session = CURRENT_PROGRESS.sessions.get(participantId);

          if (session instanceof RTMPSession) {
            session.sendStatus(); // "NetStream.Play.UnpublishNotify" 상태메시지
            session.flush();
          } else session.stop();
        }

        // RTMPSession 클래스 타입이 아닌 세션 정리한 후
        for(let realParticipantId of this.players) {
          const realSession = CURRENT_PROGRESS.sessions.get(realParticipantId);
          CURRENT_PROGRESS.idlePlayers.add(realParticipantId);
          realSession.status[2] = 0; // not playing
          realSession.status[3] = 1; // true idling
        }

        CURRENT_PROGRESS.publishers.delete(this.nowStreamPath);
        if (this.gopCacheQueue) this.gopCacheQueue.clear();
        if (this.flvGopCacheQueue) this.flvGopCacheQueue.clear();

        this.players.clear();
        this.status[1] = 0; // not publishing
      }

      this.nowStreamId = 0;
      this.nowStreamPath = '';
    }
  }



  /* about audio, video */
  audioHandler() {
    let payload = this.parsePacket.payload.slice(0, this.parsePacket.payload.length); // (!)header.length
    let soundFormat = (payload[0] >> 4) & 0x0f;
    let soundRate = (payload[0] >> 2) & 0x03;
    let soundSize = (payload[0] >> 1) & 0x1;
    let soundType = (payload[0]) & 0x01;

    // (!)check if first audio received
    if (this.soundFormat === 0) {
      this.audioCodecName = AudioCodecName[soundFormat];
      this.audioSampleRate = AudioSoundRate[soundRate];
      soundType += 1;
      this.audioChannels = soundType; // necessary?
    }

    if (soundFormat === 4) { // Nellymoser 16k-Hz mono
      this.audioSampleRate = 16000;
    } else if (soundFormat === 5) { // Nellymoser 8k-Hz mono
      this.audioSampleRate = 8000;
    } else if (soundFormat === 11) { // Speex
      this.audioSampleRate = 16000;
    } else if (soundFormat === 14) { // MP3 8-kHz
      this.audioSampleRate = 8000;
    }

    // if not AAC, print info

    // AACPacketType
    // 0 : AACSequenceHeader, 1 : AAC raw
    // if AACPacketType == 0, AudioSpecificConfig
    // else if AACPacketType == 1, Raw AAC fream data
    if (soundFormat === 10 & payload[1] == 0) {
      this.aacSequenceHeader = Buffer.alloc(payload.length);
      payload.copy(this.aacSequenceHeader);
      let aacInfo = AV.readAacHeader(this.aacSequenceHeader);
      this.audioProfileName = aacInfo.profileName;
      this.audioSampleRate = aacInfo.sampleFrequency;
      this.audioChannels = aacInfo.channelNumber;

      // if AAC, print info

    }

    // repackaging
    let packet = RtmpPacket.create();
    packet.header.fmt = RTMP_CHUNK_TYPE_0;
    packet.header.cid = RTMP_CHANNEL_AUDIO;
    packet.header.type = RTMP_TYPE_AUDIO;
    packet.payload = payload; // payload of received parsePacket
    packet.payload.length = packet.payload.length; // (!)header.length
    packet.header.timestamp = this.parsePacket.clock;

    let rtmpChunks = this.rtmpChunksCreate(packet);

    // (!)player session buffer cork()

  }


  videoHandler() {
    let payload = this.parserPacket.payload.slice(0, this.parserPacket.payload.length); // (!)header.length
    let frameType = (payload[0] >> 4) & 0x0f;
    let codecId = payload[0] & 0x0f;

    // AVC(H.264)
    // (!) codecID === 12, HEVC(H.265)
    if (codecId === 7) {
      this.avcSequenceHeader = Buffer.alloc(payload.length);
      payload.copy(this.avcSequenceHeader);
      let info = AV.rCeadAVSHeader(this.avcSequenceHeader);
      this.videoWidth = info.width;
      this.videoHeight = info.height;
      this.videoProfileName = info.profileName;
      this.videoLevel = info.level;

    }

    // if this is first arrival
    if (this.videoCodec == 0) {
      this.videoCodec = codec_id;
      this.videoCodecName = VIDEO_CODEC_NAME[codec_id];

      //print vidoe info
    }

    //repackaging
    let packet = RtmpPacket.create();
    packet.header.fmt = RTMP_CHUNK_TYPE_0;
    packet.header.cid = RTMP_CHANNEL_VIDEO;
    packet.header.type = RTMP_TYPE_VIDEO;
    packet.payload = payload;
    packet.header.length = packet.payload.length;
    packet.header.timestamp = this.parserPacket.clock;
    let rtmpChunks = this.rtmpChunksCreate(packet);
    let flvTag = NodeFlvSession.createFlvTag(packet);

    // (!)session? address?
  }

  dataHandler() {
    let offset = this.parserPacket.header.type === RTMP_TYPE_FLEX_STREAM ? 1 : 0;
    let payload = this.parserPacket.payload.slice(offset, this.parserPacket.header.length);
    let dataMessage = AMF.decodeAmf0Data(payload);
    switch (dataMessage.cmd) {
      case "@setDataFrame":
        if (dataMessage.dataObj) {
          this.audioSamplerate = dataMessage.dataObj.audiosamplerate;
          this.audioChannels = dataMessage.dataObj.stereo ? 2 : 1;
          this.videoWidth = dataMessage.dataObj.width;
          this.videoHeight = dataMessage.dataObj.height;
          this.videoFps = dataMessage.dataObj.framerate;
        }

        let opt = {
          cmd: "onMetaData",
          dataObj: dataMessage.dataObj
        };
        this.metaData = AMF.encodeAmf0Data(opt);

        let packet = RtmpPacket.create();
        packet.header.fmt = RTMP_CHUNK_TYPE_0;
        packet.header.cid = RTMP_CHANNEL_DATA;
        packet.header.type = RTMP_TYPE_DATA;
        packet.payload = this.metaData;
        packet.header.length = packet.payload.length;
        let rtmpChunks = this.rtmpChunksCreate(packet);
    }
  }
}

module.exports = RTMP_SESSION;
