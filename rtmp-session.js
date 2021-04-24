const Handshake = require('./rtmp-handshake');
const CURRENT_PROGRESS = require("./rtmp_center_ad");
const GENERATOR = require("./rtmp_center_gen");
const AMF = require('./rtmp_amf');

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
    this.appname = "";

    this.gopCacheQueue = null; // ?
    this.flvGopCacheQueue = null; // ?
    
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


    //NetStream 관련 변수들 정의
    this.nowStreamId = 0;
    this.nowStreamPath= "";
    this.nowArgs = {};

    this.publishStreamId = 0;
    this.publishStreamPath = "";
    this.publishArgs = {};

    this.status = Buffer.from("0000011", "binary"); // range 0 ~ 6
    // 0(is Start?, false) 0(is Publishing?, false) 0(is Playing?, false) 0(is Idling?, false) 0(is Pausing?, false)
    // 1(is Receiving Audio?, true) 1(is Receiving Video?, true)

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
  rtmpBandWidth(limit, type) {
      let buff = Buffer.from("0200000000000506000000000000000000", "hex");
      buff.writeUInt32BE(limit, 12);
      buff[16] = type;
      this.socket.write(buff);
  }


  rtmpSendAck(data) {
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
    if(typeof msg.st_name !== "String") return;

    //서버의 서브디렉토리(서버 실행파일을 포함하고 있는)에 저장된다.
    this.publishStreamPath = "/" + this.appname + "/" + msg.st_name.split("?")[0];
    this.publishStreamId = this.parsedPacket.chunkMessageHeader.ms_id;

    if(this.status[0] == 0) return;

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
    if(msg.st_id == this.nowStreamId) {
        if(this.status[3]) {
            CURRENT_PROGRESS.idlePlayers.delete(this.id);
            this.status[3] = 0; // set false
        }
        else { // 스트림 생성자인 경우
            let publisher_id = CURRENT_PROGRESS.publishers.get(this.nowStreamPath);
            if(publisher_id != null) {
                CURRENT_PROGRESS.sessions.get(publisher_id).players.delete(this.id);
            }
            this.status[2] = 0; // playing stop, set false
        }

        if(this.status[0]) {
            this.sendStatus() // "NetStream.Play.Stop" 상태메시지 보내기 - 흠 스펙에서는 안보낸다구 하던뎅
        }
        
        this.nowStreamId = 0;
        this.nowStreamPath = "";
    }

    if(msg.st_id == this.publishStreamId) {
        if(this.status[1]) {
            if(this.status[0]) {
                this.sendStatus() // "NetStream.Unpublish.Success" 상태메시지 보내기
            }

            for(let participantId of this.players) {
                let session = CURRENT_PROGRESS.sessions.get(participantId);

                if(session instanceof RTMPSession) {
                    session.sendStatus() // "NetStream.Play.UnpublishNotify" 상태메시지
                    session.flush();
                }
                else {
                    session.stop();
                }
            }

            // RTMPSession 클래스 타입이 아닌 세션 정리한 후
            for(let real_participantId of this.players) {
                let real_session = CURRENT_PROGRESS.sessions.get(real_participantId);
                CURRENT_PROGRESS.idlePlayers.add(real_participantId);
                real_session.status[2] = 0; // not playing
                real_session.status[3] = 1; // true idling    
            }

            CURRENT_PROGRESS.publishers.delete(this.nowStreamPath);
            if(this.gopCacheQueue) {
                this.gopCacheQueue.clear();
            }
            if(this.flvGopCacheQueue) {
                this.flvGopCacheQueue.clear();
            }

            this.players.clear();
            this.status[1] = 0; // not publishing
        }

        this.nowStreamId = 0;
        this.nowStreamPath = "";
    }
  }
}

module.exports = RTMP_SESSION;