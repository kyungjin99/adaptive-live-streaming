const EventEmitter = require('events');
const ffmpegCommand = require('fluent-ffmpeg');
const mkdirp = require('mkdirp');
const fs = require('fs');

class TRANS_SESSION extends EventEmitter {
  constructor(conf) {
    super();
    this.port = conf.port;
    this.streamPath = conf.streamPath;
    this.args = conf.args;
    this.hlsName = 'index.m3u8';;
  }

  run() {
    console.log('[TRANS SESSION] run method start');
    const inPath = `rtmp://127.0.0.1:${this.port}${this.streamPath}`;
    const outPath = `.${this.streamPath}`;

    mkdirp.sync(outPath);
    const command = ffmpegCommand(inPath)
      .inputFormat('flv')
      .audioCodec('aac') // set audio codec
      .videoCodec('libx264') // set video codec // h264는 지원 안 하는 듯,, libx264로 해야 돌아감
      .videoBitrate('1000') // set video bitrate
      .size('640x480') // set output frame size
      .aspect('4:3') // set output frame aspect ratio
      .output(`${outPath}/${this.hlsName}`) // add an output to the command
      .outputOptions([
        '-profile:v baseline', // baseline profile (level 3.0) for H264 video codec
        '-level 3.0',
        '-s 640x360', // 640px width, 360px height output video dimensions
        '-start_number 0', // start the first .ts segment at index 0
        '-hls_time 5', // 5 second segment duration
        '-hls_list_size 0', // Maximum number of playlist entries (0 means all entries/infinite)
        '-f hls', // HLS format
      ])
      .on('start', (commandLine) => { // ffmpeg process started
        console.log(`Spawned ffmpeg with command: ${commandLine}`);
      })
      .on('codecData', (data) => { // input codec data available
        console.log(`Input is ${data.audio} audio with ${data.video} video`);
      })
      .on('progress', (progress) => { // transcoding progress information
        console.log(`Processing: ${progress.percent}% done`);
      })
      .on('stderr', (stderrLine) => { // ffmpeg output
        console.log(`Stderr output: ${stderrLine}`);
      })
      .on('error', (err, stdout, stderr) => { // transcoding error
        console.log(`Cannot process video: ${err.message}`);
      })
      .on('end', (stdout, stderr) => { // processing finished
        console.log('Transcoding succeeded!!!!!');
        this.emit('transEnd');
      })
      .run();
  }
}

module.exports = TRANS_SESSION;
