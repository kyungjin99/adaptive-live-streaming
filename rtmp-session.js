/* chunk types */
const CHUNK_TYPE_0 = 0; // timestamp: 3B, message length: 3B, message type: 1B, message stream id: 4B
const CHUNK_TYPE_1 = 1; // timestamp: 3B, message length: 3B, message type: 1B
const CHUNK_TYPE_2 = 2; // timestamp: 3B
const CHUNK_TYPE_3 = 3; // 0B

/* protocol control messages */
const PCM_SET_CHUNK_SIZE = 1;
const PCM_ABORT_MESSAGE = 2;
const PCM_ACKNOWLEDGEMENT = 3;
const PCM_WINDOW_ACKNOWLEDGEMENT = 5;
const PCM_SET_PEER_BANDWIDTH = 6;

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
        payload: null,
        // clock: 0,
        // capacity: null,
        // bytes: 0,
      },
    };
  },
};

class RTMP_SESSION {
  constructor() {
    this.chunkSize = 128; // max bytes of data in a chunk (default 128). set by PCM_SET_CHUNK_SIZE
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
    } else if (csid >= 64 && csid <= 65599) { // chunk basic header 3: 3B
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
        // message stream id (stored in little endian)
        buf[10] = msid & 0XFF;
        buf[9] = (msid << 8) & 0XFF;
        buf[8] = (msid << 16) & 0XFF;
        buf[7] = (msid << 24) & 0XFF;
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
        buf[0] = 0xFF;
        buf[1] = 0XFF;
        buf[2] = 0XFF;
      } else {
        buf[0] = timestamp & 0XFF;
        buf[1] = (timestamp << 8) & 0XFF;
        buf[2] = (timestamp << 16) & 0XFF;
      }
    }

    // add message length and message stream id field except for type2, type3 chunks
    if (ctype < CHUNK_TYPE_2) {
      // message length
      buf[3] = mlen & 0XFF;
      buf[4] = (mlen << 8) & 0XFF;
      buf[5] = (mlen << 16) & 0XFF;
      // message type id
      buf[6] = mtid & 0XFF;
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
      extendedTimestampBuf[0] = header.messageHeader.timestamp & 0XFF;
      extendedTimestampBuf[1] = (header.messageHeader.timestamp << 8) & 0XFF;
      extendedTimestampBuf[2] = (header.messageHeader.timestamp << 16) & 0XFF;
      extendedTimestampBuf[3] = (header.messageHeader.timestamp << 24) & 0XFF;
    }
    // calculate the size of chunks
    const numOfChunks = Math.floor(header.chunkMessageHeader.plen / this.chunkSize);
    totalBufSize = bheaderSize + mHeaderSize + extendedTimestampBuf.length; // first chunk size
    if (numOfChunks > 1) { // remainder chunks (they are all type 3)
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
        // create message header: none
        if (useExtendedTimestamp) { // write extended timestamp
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
}

module.exports = RTMP_SESSION;
