const EventEmitter = require('events');
const ffmpegCommand = require('fluent-ffmpeg');
const mkdirp = require('mkdirp');
const fs = require('fs');
const constants = require('fs').constants;

class TRANS_SESSION extends EventEmitter {
  constructor(conf) {
    super();
    this.port = conf.port;
    this.streamPath = conf.streamPath;
    this.hlsName = 'index.m3u8';
    this.inPath = `rtmp://127.0.0.1:${this.port}${this.streamPath}`;
    this.output = 'high';
    this.output2 = 'middle';
    this.output3 = 'low';
  }

  convert(outPath, bitrate) {
    mkdirp.sync(outPath);
    const command = ffmpegCommand(this.inPath)
      .inputFormat('flv')
      .audioCodec('aac') // set audio codec
      .videoCodec('libx264') // set video codec // h264는 지원 안 하는 듯,, libx264로 해야 돌아감
      .videoBitrate(bitrate) // set video bitrate
      .size('640x480') // set output frame size
      .aspect('4:3') // set output frame aspect ratio
      .outputOptions([
        '-profile:v baseline', // baseline profile (level 3.0) for H264 video codec
        '-level 3.0',
        '-g 20', // specify GOP size. 우리꺼는 초당 10 frame인 듯,, (초당 frame 수) * (hls_time 값으로 준 수)
        //'-s 640x360', // 640px width, 360px height output video dimensions
        '-start_number 0', // start the first .ts segment at index 0
        '-hls_time 2', // 2 second segment duration
        '-hls_list_size 5', // maximum number of playlist entries (0 means all entries/infinite)
        '-hls_flags delete_segments', // deleted after a period of time equal to the duration of the segment plus the duration of the playlist
        '-f hls', // HLS format
      ])
      .output(`${outPath}/${this.hlsName}`) // add an output to the command
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

  run() {
    console.log('[TRANS SESSION] run method start');
    console.log(`this.streamPath: ${this.streamPath}`);
    const inPath = `rtmp://127.0.0.1:${this.port}${this.streamPath}`;
    const outPath = `.${this.streamPath}${this.output}`;
    const outPath2 = `.${this.streamPath}${this.output2}`;
    const outPath3 = `.${this.streamPath}${this.output3}`;

    // create master .m3u8 file
    const data = `
    #EXTM3U
    #EXT-X-STREAM-INF:BANDWIDTH=640000
    ${outPath}/${this.hlsName}
    #EXT-X-STREAM-INF:BANDWIDTH=440000
    ${outPath2}/${this.hlsName}
    #EXT-X-STREAM-INF:BANDWIDTH=150000
    ${outPath3}/${this.hlsName}    
    `;

    fs.open('master.m3u8', 'w+', (err, fd) => {
      if (err) console.log('error while creating/opening master m3u8 file');
      fs.write(fd, data, (err2) => {
        if (err2) console.log('error while writing to master m3u8 file');
        fs.close(fd, () => {
          console.log('master m3u8 file created');
        });
        this.convert(outPath, 1000); // high bitrate
        this.convert(outPath2, 500); // middle bitrate
        this.convert(outPath3, 300); // low bitrate
      });
    });
  }
}

module.exports = TRANS_SESSION;
