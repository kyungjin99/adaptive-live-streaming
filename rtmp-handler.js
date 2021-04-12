/* protocol control messages */
const PCM_SET_CHUNK_SIZE = 1;
const PCM_ABORT_MESSAGE = 2;
const PCM_ACKNOWLEDGEMENT = 3;
const PCM_WINDOW_ACKNOWLEDGEMENT = 5;
const PCM_SET_PEER_BANDWIDTH = 6;

/* user control message */
const USER_CONTROL_MESSAGE = 4;

/* rtmp command messages */
const COMMAND_MESSAGE_AMF0 = 20;
const COMMAND_MESSAGE_AMF3 = 17;
const DATA_MESSAGE_AMF0 = 18;
const DATA_MESSAGE_AMF3 = 15;
const SHARED_OBJECT_MESSAGE_AMF0 = 19;
const SHARED_OBJECT_MESSAGE_AMF3 = 16;
const AUDIO_MESSAGE = 8;
const VIDEO_MESSAGE = 9;
const AGGREGATE_MESSAGE = 22;

class RTMP_HANDLER {
  // PROTOCOL CONTROL MESSAGES
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
        this.callPCMHandler(mtid, payload);
        break;
      // user control message
      case USER_CONTROL_MESSAGE:
        this.callUCMHandler(mtid, payload);
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
        this.callRCMHandler(mtid, payload);
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
        this.sendACK(payload);
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

  setChunkSize(size) {
    this.chunkSize = size;
    // write to socket
  }

  abortMessage(csid) {
    return csid; // test
    // write to socket
  }

  sendACK(sequenceNumber) {
    return sequenceNumber; // test
    // write to socket
  }

  setWindowACKSize(windowSize) {
    return windowSize; // test
    // write to socket
  }

  setPeerBandwidth(windowSize, limitType) {
    return { windowSize, limitType }; // test
    // write to socket
  }


  

  // USER CONTROL MESSAGES
  ucmHandler(mtid, payload) {
    return null;
  }

  streamBegin() {

  }

  streamEOF() {

  }

  streamDry() {

  }

  streamIsRecorded() {

  }

  pingRequest() {

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
}

module.exports = RTMP_HANDLER;