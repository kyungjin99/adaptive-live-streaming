const Handshake = require('./rtmp-handshake');
const AMF = require('node-amfutils');

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

/* rtmp command message */
const COMMAND_MESSAGE_AMF0 = 20;
const COMMAND_MESSAGE_AMF3 = 17;
const DATA_MESSAGE_AMF0 = 18;
const DATA_MESSAGE_AMF3 = 15;
const SHARED_OBJECT_MESSAGE_AMF0 = 19;
const SHARED_OBJECT_MESSAGE_AMF3 = 16;
const AUDIO_MESSAGE = 8;
const VIDEO_MESSAGE = 9;
const AGGREGATE_MESSAGE = 22;

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
  respondConnectCmd: () => {
    return {
      cmd: "_result",
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
  respondCallCmd: () => {
    return {
      cmd: "_result",
      transId,
      cmdObj,
      info,
    };
  },
  onCreateStreamCmd: () => {
    return {
      cmd: "createStream",
      transId,
      cmdObj,
    }
  },
  respondCreateStreamCmd: () => {
    return {
      cmd: "_result",
      transId,
      cmdObj,
      info,
    };
  },
};

class RTMP_SESSION {
  constructor() {
    this.chunkSize = 128; // max bytes of data in a chunk (default 128)

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
    this.respondConnectCmd = this.command.respondConnectCmd();
    this.onCallCmd = this.command.onCallCmd();
    this.respondCallCmd = this.command.respondCallCmd();
    this.onCreateStreamCmd = this.command.onCreateStreamCmd();
    this.respondCreateStreamCmd = this.command.respondCreateStreamCmd();
  }

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

    while (readBytes < length) {
      switch (this.handshakeState) {
        // c0 처리
        case HANDSHAKE_UNINIT: {
          readBytes += 1;
          this.handshakeBytes = 0;
          this.handshakeState = HANDSHAKE_INIT;
          break;
        }

        // c1 처리
        case HANDSHAKE_INIT: {
          nextReadBytes = HANDSHAKE_PACKET_SIZE - this.handshakeBytes;
          nextReadBytes = nextReadBytes <= length ? nextReadBytes : length;
          data.copy(this.handshakePacket, this.handshakeBytes, readBytes, readBytes + nextReadBytes);
          this.handshakeBytes += nextReadBytes;
          readBytes += nextReadBytes;

          if(this.handshakeBytes === HANDSHAKE_PACKET_SIZE) {
            const s0s1s2 = Handshake.generateS0S1S2(this.handshakePacket);
            this.socket.write(s0s1s2);
            this.handshakeState = HANDSHAKE_ACK_SENT;
            this.handshakeBytes = 0;
          }
          break;
        }

        // c2 처리
        case HANDSHAKE_ACK_SENT: {
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
          return this.readChunks(data, readBytes, length);
        }
      }
    }
  }

  onSocketError(error) {
    console.error(error);
  }

  onSocketTimeout() {
    this.socket.close();
  }

  onSocketClose() {
    this.socket.close();
  }

  readChunks(data, readBytes, length) {
    let dataOffset = 0; // current offset of a chunk data received

    while (dataOffset < length) { // until finishing reading chunk
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
      }
      else { // uses extended timestamp
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
    const { mtid } = this.parsedPacket.header.chunkMessageHeader;
    const { payload } = this.parsedPacket;
    switch (mtid) {
      // protocol control message
      case PCM_SET_CHUNK_SIZE:
      case PCM_ABORT_MESSAGE:
      case PCM_ACKNOWLEDGEMENT:
      case PCM_WINDOW_ACKNOWLEDGEMENT:
      case PCM_SET_PEER_BANDWIDTH:
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
      case "connect":
        this.onConnectCmd.cmd = "connect";
        this.onConnectCmd.cmdObj = cmdObj;
        this.onConnectCmd.cmdObj.app = cmdObj.app;
        this.onConnectCmd.cmdObj.objectEncoding = (cmdObj.objectEncoding != null) ? cmdObj.objectEncoding : 0;
        this.onConnect();
        break;
      case "call":
        this.onCallCmd.cmd = "call";
        this.onCallCmd.transId = decodedMsg.transId;
        this.onCallCmd.cmdObj = cmdObj;
        this.onCallCmd.cmdObj.app = cmdObj.app;
        this.onCallCmd.cmdObj.objectEncoding = (cmdObj.objectEncoding != null) ? cmdObj.objectEncoding : 0;
        // TODO: fill
        this.onCall();
        break;
      case "createStream":
        this.onCreateStreamCmd.cmd = "createStream";
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
    this.respondConnect();
  }

  respondConnect() {
    this.respondConnectCmd.cmd = "_result";
    this.respondConnectCmd.transId = 1;
    this.respondConnectCmd.cmdObj = {
      // fmsVer
      // objectEncoding?
    };
    this.respondConnectCmd.info = {
      level: "status",
      code: "NetConnection.Connect.Success",
      description: "Connection succeeded",
    }
    // send message to client
    this.sendCmdMsg("respondConnect");
  }

  sendCmdMsg(cmdName) { // packetise command msg (response) and then chunk it to send to client
    let packet = packet.create();
    packet.header.basicHeader.fmt = CHUNK_TYPE_0;
    packet.header.basicHeader.csid = 3; // TODO: declare const later (channel invoke)
    packet.header.chunkMessageHeader.mtid = COMMAND_MESSAGE_AMF0; // TODO: why?
    packet.header.chunkMessageHeader.msid = 0;
    switch(cmdName) {
      case "respondConnect":
        packet.payload = AMF.encodeAmf0Cmd(this.respondConnectCmd);
        break;
      case "respondCall":
        packet.payload = AMF.encodeAmf0Cmd(this.respondCallCmd);
        break;
      case "respondCreateStream":
        packet.payload = AMF.encodeAmf0Cmd(this.respondCreateStreamCmd);
      default: break;
    }
    packet.payload = AMF.encodeAmf0Cmd();
    packet.header.chunkMessageHeader.plen = packet.payload.length;
    const chunks = this.createChunks(packet);
    this.socket.write(chunks);
  }

  onCall() { // runs RPC at the receiving end
    // TODO: fill
    this.respondCall();
  }

  respondCall() {
    // TODO: fill
    this.respondCallCmd.cmd = "_result";
    this.respondCallCmd.transId = this.onCallCmd.transId;
    this.respondCallCmd.cmdObj = null;
    this.sendCmdMsg("respondCall");
  }

  onCreateStream() {
    this.respondCreateStream();
  }

  respondCreateStream() {
    this.respondCreateStreamCmd.cmd = "_result";
    this.respondCreateStreamCmd.transId = this.onCreateStreamCmd.transId;
    this.respondCreateStreamCmd.cmdObj = null,
    this.sendCmdMsg("respondCreateStream");
  }
}

module.exports = RTMP_SESSION;