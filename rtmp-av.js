const BitOpr = require('./rtmp-bitopr');

const AAC_SAMPLE_RATE = [
  96000, 88200, 64000, 48000,
  44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000,
  7350, 0, 0, 0,
];

// (!) 8
const AAC_CHANNELS = [
  0, 1, 2, 3, 4, 5, 6, 7,
];

// reference document : video file format spec v10
const AUDIO_CODEC_NAME = [
  '',
  'ADPCM',
  'MP3',
  'LinearLE',
  'Nellymoser16',
  'Nellymoser8',
  'Nellymoser',
  'G711A',
  'G711U',
  '',
  'AAC',
  'Speex',
  '',
  '',
  'MP3-8K',
  'DeviceSpecific',
  'Uncompressed',
];

const AUDIO_SOUND_RATE = [
  5512, 11025, 22050, 44100,
];

const VIDEO_CODEC_NAME = [
  '',
  'Jpeg',
  'Sorenson-H263',
  'ScreenVideo',
  'On2-VP6',
  'On2-VP6-Alpha',
  'ScreenVideo2',
  'H264',
  '',
  '',
  '',
  '',
  'H265',
];

function getObjectType(bitOpr) {
  let aacObjectType = bitOpr.read(5);
  if (aacObjectType === 31) { // 31 is reserved
    aacObjectType = bitOpr.read(6) + 32; // for #32~46
  }
  return aacObjectType;
}

// If samplingFrequencyIndex equals 15
// then the actual sampling rate is signaled directly by the value of samplingFrequency
// In all other cases samplingFrequency is set to the value of the corresponding entry
function getSampleFrequency(bitOpr, info) {
  info.samplingFrequencyIdx = bitOpr.read(4);
  if (info.sampleFrequency === 0x0F) {
    return bitOpr.read(24);
  }
  return AAC_SAMPLE_RATE[info.samplingFrequencyIdx];
}

function getChannelNumber(bitOpr, info) {
  info.channelConfig = bitOpr.read(4);
  if (info.channelConfig < AAC_CHANNELS.length) {
    return AAC_CHANNELS[info.channelConfig];
  }
}

// (!)12 more profileNames exist
function getProfileName(info) {
  switch (info.objectType) {
    case 1:
      return 'Main';
    case 2:
      if (info.ps > 0) {
        return 'HEv2';
      }
      if (info.sbr > 0) {
        return 'HE'; // Hev1
      }
      return 'LC';
    case 3:
      return 'SSR';
    case 4:
      return 'LTP';
    case 5:
      return 'SBR';
    default:
      return '';
  }
}

function readAacHeader(aacSequenceHeader) {
  const info = {};
  const bitOpr = new BitOpr(aacSequenceHeader);
  info.objectType = getObjectType(bitOpr);
  info.sampleFrequency = getSampleFrequency(bitOpr, info);
  info.channelNumber = getChannelNumber(bitOpr, info);
  // default. basic AAC profile doesn't have sbr and ps
  info.sbr = -1;
  info.ps = -1;

  // type 5 is High Efficiency AAC Profile (HE-AAC v1)
  // type 29 is HE-AAC v2 Profile
  if (info.objectType === 5 || info.objectType === 29) {
    if (info.objectType === 29) {
      info.ps = 1;
    }
    info.sbr = 1;
    info.sampleFrequency = getSampleFrequency(bitOpr, info);
    info.objectType = getObjectType(bitOpr);
  }

  info.profileName = getProfileName(info);

  return info;
}

// (!) video handler. AVC(H.264) HEVC(H.265)
function readH264SpecificConfig(avcSequenceHeader) {
  const info = {};
  let profileIdc;
  let width;
  let height;
  let cropLeft;
  let cropRight;
  let cropTop;
  let cropBottom;
  let frameMbsOnly;
  let n;
  let cfIdc;
  let numRefFrames;
  const bitop = new Bitop(avcSequenceHeader);
  bitop.read(48);
  info.width = 0;
  info.height = 0;

  do {
    info.profile = bitop.read(8);
    info.compat = bitop.read(8);
    info.level = bitop.read(8);
    info.nalu = (bitop.read(8) & 0x03) + 1;
    info.nb_sps = bitop.read(8) & 0x1F;
    if (info.nb_sps === 0) {
      break;
    }
    /* nal size */
    bitop.read(16);

    /* nal type */
    if (bitop.read(8) !== 0x67) {
      break;
    }
    /* SPS */
    profileIdc = bitop.read(8);

    /* flags */
    bitop.read(8);

    /* level idc */
    bitop.read(8);

    /* SPS id */
    bitop.read_golomb();

    if (profileIdc === 100 || profileIdc === 110
      || profileIdc === 122 || profileIdc === 244 || profileIdc === 44
      || profileIdc === 83 || profileIdc === 86 || profileIdc === 118) {
      /* chroma format idc */
      cfIdc = bitop.read_golomb();

      if (cfIdc === 3) {
        /* separate color plane */
        bitop.read(1);
      }

      /* bit depth luma - 8 */
      bitop.read_golomb();

      /* bit depth chroma - 8 */
      bitop.read_golomb();

      /* qpprime y zero transform bypass */
      bitop.read(1);

      /* seq scaling matrix present */
      if (bitop.read(1)) {
        for (n = 0; n < (cfIdc !== 3 ? 8 : 12); n++) {
          /* seq scaling list present */
          if (bitop.read(1)) {

            /* TODO: scaling_list()
            if (n < 6) {
            } else {
            }
            */
          }
        }
      }
    }

    /* log2 max frame num */
    bitop.read_golomb();

    /* pic order cnt type */
    switch (bitop.read_golomb()) {
      case 0:
        /* max pic order cnt */
        bitop.read_golomb();
        break;

      case 1:
        /* delta pic order alwys zero */
        bitop.read(1);

        /* offset for non-ref pic */
        bitop.read_golomb();

        /* offset for top to bottom field */
        bitop.read_golomb();

        /* num ref frames in pic order */
        numRefFrames = bitop.read_golomb();

        for (n = 0; n < numRefFrames; n++) {
          /* offset for ref frame */
          bitop.read_golomb();
        }
        break;
      default:
    }

    /* num ref frames */
    info.avc_ref_frames = bitop.read_golomb();

    /* gaps in frame num allowed */
    bitop.read(1);

    /* pic width in mbs - 1 */
    width = bitop.read_golomb();

    /* pic height in map units - 1 */
    height = bitop.read_golomb();

    /* frame mbs only flag */
    frameMbsOnly = bitop.read(1);

    if (!frameMbsOnly) {
      /* mbs adaprive frame field */
      bitop.read(1);
    }

    /* direct 8x8 inference flag */
    bitop.read(1);

    /* frame cropping */
    if (bitop.read(1)) {
      cropLeft = bitop.read_golomb();
      cropRight = bitop.read_golomb();
      cropTop = bitop.read_golomb();
      cropBottom = bitop.read_golomb();
    } else {
      cropLeft = 0;
      cropRight = 0;
      cropTop = 0;
      cropBottom = 0;
    }
    info.level /= 10.0;
    info.width = (width + 1) * 16 - (cropLeft + cropRight) * 2;
    info.height = (2 - frameMbsOnly) * (height + 1) * 16 - (cropTop + cropBottom) * 2;
  } while (0);

  return info;
}

function HEVCParsePtl(bitop, hevc, maxSubLayersMinus1) {
  const generalPtl = {};

  generalPtl.profile_space = bitop.read(2);
  generalPtl.tier_flag = bitop.read(1);
  generalPtl.profileIdc = bitop.read(5);
  generalPtl.profile_compatibility_flags = bitop.read(32);
  generalPtl.general_progressive_source_flag = bitop.read(1);
  generalPtl.general_interlaced_source_flag = bitop.read(1);
  generalPtl.general_non_packed_constraint_flag = bitop.read(1);
  generalPtl.general_frame_only_constraint_flag = bitop.read(1);
  bitop.read(32);
  bitop.read(12);
  generalPtl.level_idc = bitop.read(8);

  generalPtl.sub_layer_profile_present_flag = [];
  generalPtl.sub_layer_level_present_flag = [];

  for (let i = 0; i < maxSubLayersMinus1; i++) {
    generalPtl.sub_layer_profile_present_flag[i] = bitop.read(1);
    generalPtl.sub_layer_level_present_flag[i] = bitop.read(1);
  }

  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) {
      bitop.read(2);
    }
  }

  generalPtl.sub_layer_profile_space = [];
  generalPtl.sub_layer_tier_flag = [];
  generalPtl.sub_layer_profileIdc = [];
  generalPtl.sub_layer_profile_compatibility_flag = [];
  generalPtl.sub_layer_progressive_source_flag = [];
  generalPtl.sub_layer_interlaced_source_flag = [];
  generalPtl.sub_layer_non_packed_constraint_flag = [];
  generalPtl.sub_layer_frame_only_constraint_flag = [];
  generalPtl.sub_layer_level_idc = [];

  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (generalPtl.sub_layer_profile_present_flag[i]) {
      generalPtl.sub_layer_profile_space[i] = bitop.read(2);
      generalPtl.sub_layer_tier_flag[i] = bitop.read(1);
      generalPtl.sub_layer_profileIdc[i] = bitop.read(5);
      generalPtl.sub_layer_profile_compatibility_flag[i] = bitop.read(32);
      generalPtl.sub_layer_progressive_source_flag[i] = bitop.read(1);
      generalPtl.sub_layer_interlaced_source_flag[i] = bitop.read(1);
      generalPtl.sub_layer_non_packed_constraint_flag[i] = bitop.read(1);
      generalPtl.sub_layer_frame_only_constraint_flag[i] = bitop.read(1);
      bitop.read(32);
      bitop.read(12);
    }
    if (generalPtl.sub_layer_level_present_flag[i]) {
      generalPtl.sub_layer_level_idc[i] = bitop.read(8);
    } else {
      generalPtl.sub_layer_level_idc[i] = 1;
    }
  }
  return generalPtl;
}

function HEVCParseSPS(SPS, hevc) {
  const psps = {};
  const NumBytesInNALunit = SPS.length;
  const NumBytesInRBSP = 0;
  const rbspArray = [];
  const bitop = new Bitop(SPS);

  bitop.read(1); // forbidden_zero_bit
  bitop.read(6); // nal_unit_type
  bitop.read(6); // nuh_reserved_zero_6bits
  bitop.read(3); // nuh_temporal_id_plus1

  for (let i = 2; i < NumBytesInNALunit; i++) {
    if (i + 2 < NumBytesInNALunit && bitop.look(24) === 0x000003) {
      rbspArray.push(bitop.read(8));
      rbspArray.push(bitop.read(8));
      i += 2;
      // let emulationPreventionThreeByte = bitop.read(8); /* equal to 0x03 */
      bitop.read(8); /* equal to 0x03 */
    } else {
      rbspArray.push(bitop.read(8));
    }
  }
  const rbsp = Buffer.from(rbspArray);
  const rbspBitop = new Bitop(rbsp);
  psps.sps_video_parameter_set_id = rbspBitop.read(4);
  psps.sps_maxSubLayersMinus1 = rbspBitop.read(3);
  psps.sps_temporal_id_nesting_flag = rbspBitop.read(1);
  psps.profile_tier_level = HEVCParsePtl(rbspBitop, hevc, psps.sps_maxSubLayersMinus1);
  psps.sps_seq_parameter_set_id = rbspBitop.read_golomb();
  psps.chroma_format_idc = rbspBitop.read_golomb();
  if (psps.chroma_format_idc === 3) {
    psps.separate_colour_plane_flag = rbspBitop.read(1);
  } else {
    psps.separate_colour_plane_flag = 0;
  }
  psps.pic_width_in_luma_samples = rbspBitop.read_golomb();
  psps.pic_height_in_luma_samples = rbspBitop.read_golomb();
  psps.conformance_window_flag = rbspBitop.read(1);
  if (psps.conformance_window_flag) {
    const vertMult = 1 + (psps.chroma_format_idc < 2);
    const horizMult = 1 + (psps.chroma_format_idc < 3);
    psps.conf_win_left_offset = rbspBitop.read_golomb() * horizMult;
    psps.conf_win_right_offset = rbspBitop.read_golomb() * horizMult;
    psps.conf_win_top_offset = rbspBitop.read_golomb() * vertMult;
    psps.conf_win_bottom_offset = rbspBitop.read_golomb() * vertMult;
  }
  // Logger.debug(psps);
  return psps;
}

function readHEVCSpecificConfig(hevcSequenceHeader) {
  const info = {};
  info.width = 0;
  info.height = 0;
  info.profile = 0;
  info.level = 0;
  // let bitop = new Bitop(hevcSequenceHeader);
  // bitop.read(48);
  hevcSequenceHeader = hevcSequenceHeader.slice(5);

  do {
    const hevc = {};
    if (hevcSequenceHeader.length < 23) {
      break;
    }

    hevc.configurationVersion = hevcSequenceHeader[0];
    if (hevc.configurationVersion !== 1) {
      break;
    }
    hevc.general_profile_space = (hevcSequenceHeader[1] >> 6) & 0x03;
    hevc.general_tier_flag = (hevcSequenceHeader[1] >> 5) & 0x01;
    hevc.general_profileIdc = hevcSequenceHeader[1] & 0x1F;
    hevc.general_profile_compatibility_flags = (hevcSequenceHeader[2] << 24) | (hevcSequenceHeader[3] << 16) | (hevcSequenceHeader[4] << 8) | hevcSequenceHeader[5];
    hevc.general_constraint_indicator_flags = ((hevcSequenceHeader[6] << 24) | (hevcSequenceHeader[7] << 16) | (hevcSequenceHeader[8] << 8) | hevcSequenceHeader[9]);
    hevc.general_constraint_indicator_flags = (hevc.general_constraint_indicator_flags << 16) | (hevcSequenceHeader[10] << 8) | hevcSequenceHeader[11];
    hevc.general_level_idc = hevcSequenceHeader[12];
    hevc.min_spatial_segmentation_idc = ((hevcSequenceHeader[13] & 0x0F) << 8) | hevcSequenceHeader[14];
    hevc.parallelismType = hevcSequenceHeader[15] & 0x03;
    hevc.chromaFormat = hevcSequenceHeader[16] & 0x03;
    hevc.bitDepthLumaMinus8 = hevcSequenceHeader[17] & 0x07;
    hevc.bitDepthChromaMinus8 = hevcSequenceHeader[18] & 0x07;
    hevc.avgFrameRate = (hevcSequenceHeader[19] << 8) | hevcSequenceHeader[20];
    hevc.constantFrameRate = (hevcSequenceHeader[21] >> 6) & 0x03;
    hevc.numTemporalLayers = (hevcSequenceHeader[21] >> 3) & 0x07;
    hevc.temporalIdNested = (hevcSequenceHeader[21] >> 2) & 0x01;
    hevc.lengthSizeMinusOne = hevcSequenceHeader[21] & 0x03;
    const numOfArrays = hevcSequenceHeader[22];
    let p = hevcSequenceHeader.slice(23);
    for (let i = 0; i < numOfArrays; i++) {
      if (p.length < 3) {
        break;
      }
      const nalutype = p[0];
      // const n = (p[1]) << 8 | p[2];
      const n = (p[1] << 8) | p[2];
      // Logger.debug(nalutype, n);
      p = p.slice(3);
      for (let j = 0; j < n; j++) {
        if (p.length < 2) {
          break;
        }
        k = (p[0] << 8) | p[1];
        // Logger.debug('k', k);
        if (p.length < 2 + k) {
          break;
        }
        p = p.slice(2);
        if (nalutype === 33) {
          // SPS
          const sps = Buffer.alloc(k);
          p.copy(sps, 0, 0, k);
          // Logger.debug(sps, sps.length);
          hevc.psps = HEVCParseSPS(sps, hevc);
          info.profile = hevc.general_profileIdc;
          info.level = hevc.general_level_idc / 30.0;
          info.width = hevc.psps.pic_width_in_luma_samples - (hevc.psps.conf_win_left_offset + hevc.psps.conf_win_right_offset);
          info.height = hevc.psps.pic_height_in_luma_samples - (hevc.psps.conf_win_top_offset + hevc.psps.conf_win_bottom_offset);
        }
        p = p.slice(k);
      }
    }
  } while (0);

  return info;
}

function readAVCSpecificConfig(avcSequenceHeader) {
  const codecId = avcSequenceHeader[0] & 0x0f;
  let res;
  if (codecId === 7) {
    res = readH264SpecificConfig(avcSequenceHeader);
  } else if (codecId === 12) {
    res = readHEVCSpecificConfig(avcSequenceHeader);
  }
  return res;
}

function getAVCProfileName(info) {
  switch (info.profile) {
    case 1:
      return 'Main';
    case 2:
      return 'Main 10';
    case 3:
      return 'Main Still Picture';
    case 66:
      return 'Baseline';
    case 77:
      return 'Main';
    case 100:
      return 'High';
    default:
      return '';
  }
}

module.exports = {
  AUDIO_SOUND_RATE,
  AUDIO_CODEC_NAME,
  VIDEO_CODEC_NAME,
  readAacHeader,
  readAVCSHeader,
};
