const EventEmitter = require('events');
const FfmpegCommand = require('fluent-ffmpeg');
const mkdirp = require('mkdirp');
const fs = require('fs');
const util = require('util');
const path = require('path');
const constants = require('fs').constants;
const CURRENT_PROGRESS = require('./rtmp-center-ad');

const readdir = util.promisify(fs.readdir);
const unlink = util.promisify(fs.unlink);
const rmdir = util.promisify(fs.rmdir);

/*
  테스트 결과
  크롬 대역폭 high : 5M/s middle : 3M/s low : 1M/s 로 설정하고
  트랜스먹싱 비트레이트는 현재 설정값과 동일하게 한 뒤 실험하니
  크롬에서 대역폭 바꿔줄때마다 각 대역폭에 맞는 ts파일을 가져온다.
*/

// 현재 스트리머가 2.5Mb/s로 인코딩하여 전달해주므로
// high 품질의 비트레이트를 2.5Mb/s로 설정 (오디오는 따로 추가해주어야할듯? 128k)
// high : 2.5M/s, middle : 1.5M/s low : 800K/s
const HIGH_BITRATE = 2500000;
const MIDDLE_BITRATE = 1500000;
const LOW_BITRATE = 800000;

const HIGH_RESOLUTION = '1280x720';
const MIDDLE_RESOLUTION = '854x480';
const LOW_RESOLUTION = '640x360';

class TRANS_SESSION extends EventEmitter {
  constructor(conf) {
    super();

    this.ffmpegProcess = null;

    this.id = conf.id;

    this.port = conf.port;
    this.streamPath = conf.streamPath;
    this.mediaFolder = path.join(__dirname, this.streamPath);
    this.hlsName = 'index.m3u8';
    this.inPath = `rtmp://127.0.0.1:${this.port}${this.streamPath}`;
    this.output = 'high';
    this.output2 = 'middle';
    this.output3 = 'low';

    this.outPath = path.join(this.mediaFolder, this.output);
    this.outPath2 = path.join(this.mediaFolder, this.output2);
    this.outPath3 = path.join(this.mediaFolder, this.output3);
    this.on('transEnd', this.transEnd.bind(this));

    console.log(`[TRANS SESSION] mediaFolder = ${this.mediaFolder}`);
    console.log(`[TRANS SESSION] outPath = ${this.outPath}`);
    console.log(`[TRANS SESSION] outPath2 = ${this.outPath2}`);
    console.log(`[TRANS SESSION] outPath3 = ${this.outPath3}`);
  }

  convert() {
    try {
      mkdirp.sync(this.outPath);
      fs.accessSync(this.outPath, constants.F_OK);

      mkdirp.sync(this.outPath2);
      fs.accessSync(this.outPath2, constants.F_OK);

      mkdirp.sync(this.outPath3);
      fs.accessSync(this.outPath3, constants.F_OK);
    } catch (error) {
      console.log('[TRANS SESSION] Folder access permission denied');
    }

    this.ffmpegProcess = new FfmpegCommand(this.inPath)
      .output(`${this.outPath}/${this.hlsName}`) // add an output to the command
      .inputFormat('flv')
      .audioCodec('aac') // set audio codec
      .videoCodec('libx264') // set video codec // h264는 지원 안 하는 듯,, libx264로 해야 돌아감
      // .withFPSInput(30)
      // .aspect('4:3') // set output frame aspect ratio
      .outputOptions([
        '-threads 4',
        '-profile:v high', // baseline profile (level 3.0) for H264 video codec
        '-level 4.1',
        '-g 60', // specify GOP size. 우리꺼는 초당 10 frame인 듯,, (초당 frame 수) * (hls_time 값으로 준 수)
        //'-s 640x360', // 640px width, 360px height output video dimensions
        '-start_number 0', // start the first .ts segment at index 0
        '-hls_time 2', // 2 second segment duration
        '-hls_list_size 5', // maximum number of playlist entries (0 means all entries/infinite)
        '-hls_flags delete_segments', // deleted after a period of time equal to the duration of the segment plus the duration of the playlist
        '-f hls', // HLS format
        '-max_muxing_queue_size 9999',
      ])
      .videoBitrate(HIGH_BITRATE / 1000) // set video bitrate
      .size(HIGH_RESOLUTION) // set output frame size

      .output(`${this.outPath2}/${this.hlsName}`) // add an output to the command
      .inputFormat('flv')
      .audioCodec('aac') // set audio codec
      .videoCodec('libx264') // set video codec // h264는 지원 안 하는 듯,, libx264로 해야 돌아감
      // .withFPSInput(30)
      // .aspect('4:3') // set output frame aspect ratio
      .outputOptions([
        '-threads 4',
        '-profile:v high', // baseline profile (level 3.0) for H264 video codec
        '-level 4.1',
        '-g 60', // specify GOP size. 우리꺼는 초당 10 frame인 듯,, (초당 frame 수) * (hls_time 값으로 준 수)
        //'-s 640x360', // 640px width, 360px height output video dimensions
        '-start_number 0', // start the first .ts segment at index 0
        '-hls_time 2', // 2 second segment duration
        '-hls_list_size 5', // maximum number of playlist entries (0 means all entries/infinite)
        '-hls_flags delete_segments', // deleted after a period of time equal to the duration of the segment plus the duration of the playlist
        '-f hls', // HLS format
        '-max_muxing_queue_size 9999',
      ])
      .videoBitrate(MIDDLE_BITRATE / 1000) // set video bitrate
      .size(MIDDLE_RESOLUTION) // set output frame size

      .output(`${this.outPath3}/${this.hlsName}`) // add an output to the command
      .inputFormat('flv')
      .audioCodec('aac') // set audio codec
      .videoCodec('libx264') // set video codec // h264는 지원 안 하는 듯,, libx264로 해야 돌아감
      // .withFPSInput(30)
      // .aspect('4:3') // set output frame aspect ratio
      .outputOptions([
        '-threads 4',
        '-profile:v high', // baseline profile (level 3.0) for H264 video codec
        '-level 4.1',
        '-g 60', // specify GOP size. 우리꺼는 초당 10 frame인 듯,, (초당 frame 수) * (hls_time 값으로 준 수)
        //'-s 640x360', // 640px width, 360px height output video dimensions
        '-start_number 0', // start the first .ts segment at index 0
        '-hls_time 2', // 2 second segment duration
        '-hls_list_size 5', // maximum number of playlist entries (0 means all entries/infinite)
        '-hls_flags delete_segments', // deleted after a period of time equal to the duration of the segment plus the duration of the playlist
        '-f hls', // HLS format
        '-max_muxing_queue_size 9999',
      ])
      .videoBitrate(LOW_BITRATE / 1000) // set video bitrate
      .size(LOW_RESOLUTION) // set output frame size

      .on('start', (commandLine) => { // ffmpeg process started
        // console.log(`Spawned ffmpeg with command: ${commandLine}`);
      })
      .on('codecData', (data) => { // input codec data available
        console.log(`[FFMPEG] Input is ${data.audio} audio with ${data.video} video`);
      })
      .on('progress', (progress) => { // transcoding progress information
        // console.log(`[FFMPEG] Processing: ${progress.percent}% done`);
      })
      .on('stderr', (stderrLine) => { // ffmpeg output
        console.log(`[FFMPEG] Stderr output: ${stderrLine}`);
      })
      .on('error', (err, stdout, stderr) => { // transcoding error
        console.log(`[FFMPEG] Cannot process video: ${err.message}`);
        this.transEnd(this.id);
        CURRENT_PROGRESS.events.emit('transError', this.id);
      })
      .on('end', this.onFFmpegEnd.bind(this));

    this.ffmpegProcess.run();
  }

  onFFmpegEnd(stdout, stderr) {
    console.log('[TRANS SESSION] Transcoding Finished!!!!!');
    this.emit('transEnd', this.id);
  }

  run() {
    console.log('[TRANS SESSION] Run method start');
    console.log(`[TRANS SESSION] Stream path: ${this.streamPath}`);
    // const inPath = `rtmp://127.0.0.1:${this.port}${this.streamPath}`;

    // create master .m3u8 file
    const data = `#EXTM3U
    #EXT-X-STREAM-INF:BANDWIDTH=${LOW_BITRATE + 130000},RESOLUTION=${LOW_RESOLUTION},NAME=low
    ${path.join(this.output3, this.hlsName)}
    #EXT-X-STREAM-INF:BANDWIDTH=${MIDDLE_BITRATE + 130000},RESOLUTION=${MIDDLE_RESOLUTION},NAME=middle
    ${path.join(this.output2, this.hlsName)}
    #EXT-X-STREAM-INF:BANDWIDTH=${HIGH_BITRATE + 130000},RESOLUTION=${HIGH_RESOLUTION},NAME=high
    ${path.join(this.output, this.hlsName)}
    `;

    try {
      mkdirp.sync(this.mediaFolder);
      fs.accessSync(this.mediaFolder, constants.F_OK);
    } catch (error) {
      console.log('[TRANS SESSION] master.m3u8 folder access permission denied');
    }

    const masterPath = path.join(this.mediaFolder, 'master.m3u8');
    fs.open(masterPath, 'w+', (err, fd) => {
      if (err) console.log('[TRANS SESSION] error while creating/opening master m3u8 file');
      fs.write(fd, data, (err2) => {
        if (err2) {
          console.log('[TRANS SESSION] Error while writing to master m3u8 file');
        } else {
          fs.close(fd, () => {
            console.log('[TRANS SESSION] master.m3u8 created');
          });
          this.convert();
        }
      });
    });
  }

  async transEnd(id) {
    console.log(`[TRANS SESSION] 종료하라고 명령받은 id = ${id}`);
    console.log(`[TRANS SESSION] 현재 trans session의 id = ${this.id}`);
    if (this.id !== id) return;

    this.emit('end');
    try {
      const files = await readdir(this.outPath);
      files.forEach(async (filename) => {
        if (filename.endsWith('.ts') || filename.endsWith('.m3u8')) {
          const targetPath = path.join(this.outPath, filename);
          await unlink(targetPath);
        }
      });
    } catch (error) {
      console.log('[TRANS SESSION] high .ts delete error');
    }

    try {
      const files = await readdir(this.outPath2);
      files.forEach(async (filename) => {
        if (filename.endsWith('.ts') || filename.endsWith('.m3u8')) {
          const targetPath = path.join(this.outPath2, filename);
          await unlink(targetPath);
        }
      });
    } catch (error) {
      console.log('[TRANS SESSION] middle .ts delete error');
    }

    try {
      const files = await readdir(this.outPath3);
      files.forEach(async (filename) => {
        if (filename.endsWith('.ts') || filename.endsWith('.m3u8')) {
          const targetPath = path.join(this.outPath3, filename);
          await unlink(targetPath);
        }
      });
    } catch (error) {
      console.log('[TRANS SESSION] low .ts delete error');
    }

    try {
      const files = await readdir(this.mediaFolder);
      files.forEach(async (filename) => {
        console.log(`${this.mediaFolder} 하위 파일이름 : ${filename}`);
        const deleteTarget = path.join(this.mediaFolder, filename);
        if (filename.endsWith('.m3u8')) {
          await unlink(deleteTarget);
        } else {
          await rmdir(deleteTarget);
        }
      });
    } catch (error) {
      console.log('[TRANS SESSION] mediaFolder .m3u8 or directory delete error');
    }

    // try {
    //   await rmdir(this.mediaFolder);
    // } catch (error) {
    //   console.log('[TRANS SESSION] mediaFolder delete error');
    // }
  }

  end() {
    this.ffmpegProcess.kill();
  }
}

module.exports = TRANS_SESSION;
