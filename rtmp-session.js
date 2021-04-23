const Handshake = require('./rtmp-handshake');

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


/* 
  message header - type ids
*/
/* protocol control message types */
const PCM_SET_CHUNK_SIZE = 1;
const PCM_ABORT_MESSAGE = 2;
const PCM_ACKNOWLEDGEMENT = 3;
const PCM_WINDOW_ACKNOWLEDGEMENT = 5;
const PCM_SET_PEER_BANDWIDTH = 6;

/* user control message */
const USER_CONTROL_MESSAGE = 4;

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


/* user control message types */
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
class RTMP_SESSION {
  constructor(socket) {
    this.socket = socket;
    this.handshakeState = HANDSHAKE_UNINIT;
    this.handshakeBytes = 0;
    this.handshakePacket = Buffer.alloc(HANDSHAKE_PACKET_SIZE);
    this.startTimestamp = Date.now();

    this.chunkSize = 128; // max bytes of data in a chunk (default 128)

    // for parsing chunk
    this.parsingState = 0;
    this.bytesParsed = 0;
    this.parsedChunkBuf = Buffer.alloc(18); // stores parsed chunk. assign a header size of 18 (MAX)
    this.bheaderSize = 0; // chunk basic header size (in bytes)
    this.mheaderSize = 0; // chunk message header size (in bytes)
    this.useExtendedTimestamp = 0;
    this.parsedPacket = packet.create(); // this will multiplex a message
    this.packetList = new Map();
    
    this.currentAck = 0;
    this.lastAck = 0;
    this.ackSize = 0;
    this.limitType = LIMIT_TYPE_HARD;

    this.startTimestamp = null;
    this.pingRequestTimestamp = null;
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
    // TODO: dataOffset = readBytes가 되어야 하지 않나..?
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
          }
          break;
        }
        default: break;
      }
    }

    /* 
      TODO: 
      읽은 데이터 수 기록해놔야함.
      그래야 후에 pcm의 sendAck에서 활용 가능.
      일단 변수명 currentAck, lastAck로 설정해둠.
    */
    this.currentAck += length;
    if(this.currentAck >= 0xf00000000) {
      this.currentAck = 0;
      this.lastAck = 0;
    }
    if(this.currentAck - this.lastAck >= this.ackSize) {
      this.lastAck = this.currentAck;
      this.sendACK(this.currentAck);
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


  /*
    Handler
  */
  handler() {
    const { mtid } = this.parsedPacket.header.chunkMessageHeader.mtid;
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

  pcmHandler(mtid, payload) {
    switch (mtid) {
      case PCM_SET_CHUNK_SIZE: {
        this.setChunkSize(payload);
        break;
      }
      case PCM_ABORT_MESSAGE: {
        this.abortMessage(payload);
        break;
      }   
      case PCM_ACKNOWLEDGEMENT: {
        // this.receiveACK(payload);
        break;
      }
      case PCM_WINDOW_ACKNOWLEDGEMENT: {
        this.setWindowACKSize(payload);
        break;
      }
      case PCM_SET_PEER_BANDWIDTH: {
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

  /* 
    PCM 수신 시 사용되는 메서드들 
  */ 
  setChunkSize(payload) {
    const chunkSize = payload.readUInt32BE(); 
    this.chunkSize = chunkSize;
  }

  abortMessage(payload) {
    const csid = payload.readUInt32BE();
    this.packetList.delete(csid);
  }

  
  /*
    상대방에게 데이터를 전송할 때 필요한 메서드..
  */

  // receiveACK(payload) {
  //   const ack = payload.readUInt32BE();
  //   if(ack !== this.outWindowSize) {
      
  //   }
  // }

  setWindowACKSize(payload) {
    const ackSize = payload.readUInt32BE();
    this.ackSize = ackSize;
  }

  setPeerBandwidth(windowSize, limitType) {
    switch(limitType) {
      case LIMIT_TYPE_HARD: {
        this.ackSize = windowSize;
        this.limitType = limitType;
        break;
      }
      case LIMIT_TYPE_SOFT: {
        if(this.ackSize > windowSize) {
          this.ackSize = windowSize;
          this.limitType = limitType;
          break;
        }
      }
      case LIMIT_TYPE_DYNAMIC: {
        if(this.limitType === LIMIT_TYPE_HARD) {
          this.ackSize = windowSize;
          this.limitType = limitType;
          break;
        }
      }
      default: {

      }
    } 
  }

  
  /*
    PCM 전송 시 사용되는 메서드들
  */
  sendACK(payload) {
    return sequenceNumber; // test
    // write to socket
  }

  sendWindowACKSize() {
    
  }

  sendPeerBandWidth() {
    
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
      default: {

      }
    }
  }

  // 서버가 클라이언트로 전송하는 UCM 메서드
  streamBegin(cid) {
    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.cid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = MSID_PROTOCOL_MESSAGE;
    newPacket.payload = Buffer.from([0, UCM_PING_RESPONSE, (cid >> 24) & 0xff, (cid >> 16) & 0xff, (cid >> 8) & 0xff, cid & 0xff]);
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;

    this.socket.write(this.createChunks(newPacket));
  }
  
  // playback할 데이터가 없음을 알려주는 메서드. 필요없을듯?
  // streamEOF(cid) {
    
  // }

  // 특정 청크 스트림에 데이터가 없음을 클라이언트에게 알리는 메서드
  streamDry(cid) {
    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.cid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = MSID_PROTOCOL_MESSAGE;
    newPacket.payload = Buffer.from([0, UCM_STREAM_DRY, (cid >> 24) & 0xff, (cid >> 16) & 0xff, (cid >> 8) & 0xff, cid & 0xff]);
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;

    this.socket.write(this.createChunks(newPacket));
  }
  
  // 녹화가 실행되고 있는 cid를 클라이언트에 전송
  streamIsRecorded(cid) {
    const newPacket = packet.create();
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.cid = CSID_PROTOCOL_MESSAGE;
    newPacket.header.chunkMessageHeader.mtid = USER_CONTROL_MESSAGE;
    newPacket.header.chunkMessageHeader.msid = MSID_PROTOCOL_MESSAGE;
    newPacket.payload = Buffer.from([0, UCM_STREAM_IS_RECORDED, (cid >> 24) & 0xff, (cid >> 16) & 0xff, (cid >> 8) & 0xff, cid & 0xff]);
    newPacket.header.chunkMessageHeader.plen = newPacket.payload.length;

    this.socket.write(this.createChunks(newPacket));
  }

  pingRequest() {
    const newPacket = newPacket.create();
    const timestampDelta = Date.now() - this.startTimestamp;
    newPacket.header.basicHeader.fmt = CHUNK_TYPE_0;
    newPacket.header.basicHeader.cid = CSID_PROTOCOL_MESSAGE;
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
    if(this.pingRequestTimestamp !== timestamp)
      this.stop();
    else
      this.pingRequestTimestamp = null;
  }




  // RTMP COMMAND MESSAGES
  rcmHandler(mtid, payload) {
    return null;
  }

  netConnection() {

  }

  netStream() {

  }

  
  // netConnection에서 사용되는 메서드
  connect() {

  }

  call() {
    
  }

  createStream() {

  }

  // netStream에서 사용되는 메서드
  deleteStream() {

  }

  receiveAudio() {

  }

  receiveVideo() {

  }

  publish() {
    
  }


  // pcm, ucm, rcm 패킷 전송하는 메서드
  sendProcessMessage() {

  }
}

module.exports = RTMP_SESSION;