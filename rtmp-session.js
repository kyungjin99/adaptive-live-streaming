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

const AV = require('./rtmp-av');
const { AUDIO_SOUND_RATE, AUDIO_CODEC_NAME, VIDEO_CODEC_NAME } = require('./rtmp-av');
const AMF = require('./rtmp-amf');


class RTMP_SESSION {
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

      // (!) session? address?

    }
  }
}

module.exports = RTMP_SESSION;
