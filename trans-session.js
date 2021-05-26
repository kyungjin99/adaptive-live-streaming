const EventEmitter = require('events');
const { spawn } = require('child_process');
const mkdirp = require('mkdirp');
const fs = require('fs');

class TRANS_SESSION extends EventEmitter {
  constructor(conf) {
    super();
    this.ffmpegPath = conf.ffmpeg;
    this.port = conf.port;
    this.streamPath = conf.streamPath;
    this.args = conf.args;
    this.resolution = conf.resolution;

    this.hlsName = 'index.m3u8';

    this.ffmpegProcess = null;
  }

  run() {
    console.log('[TRANS SESSION] run method start');
    const vc = 'copy';
    const ac = 'copy';
    const inPath = `rtmp://127.0.0.1:${this.port}${this.streamPath}`;
    const outPath = `.${this.streamPath}`;

    mkdirp.sync(outPath);
    let argv = ['-y', '-i', inPath];

    Array.prototype.push.apply(argv, ['-c:v', vc]);
    Array.prototype.push.apply(argv, ['-c:a', ac]);
    Array.prototype.push.apply(argv, ['-f', 'tee', '-map', '0:a?', '-map', '0:v?']);
    Array.prototype.push.apply(argv, ['-hls_time', 2]);
    Array.prototype.push.apply(argv, ['-hls_list_size', 5]);
    Array.prototype.push.apply(argv, ['-hls_flags', 'delete_segments']);
    Array.prototype.push.apply(argv, [`${outPath}/${this.hlsName}`]);

    console.log(argv);

    this.ffmpegProcess = spawn(this.ffmpegPath, argv);
    this.ffmpegProcess.on('error', (error) => {
      console.log('[TRANS SESSION] ffmpeg start error');
      console.log(error);
    });
    this.ffmpegProcess.stdout.on('data', (data) => {
      console.log('[TRANS SESSION] ffmpeg stdout');
      console.log(data.toString());
    });
    this.ffmpegProcess.stderr.on('data', (data) => {
      console.log('[TRANS SESSION] ffmpeg stderr');
      console.log(data.toString());
    });
    this.ffmpegProcess.on('close', (code) => {
      this.emit('transEnd');
      fs.readdir(outPath, (error, files) => {
        if (error) {
          console.log('[TRANS SESSION] Read directory error after transmuxing');
          console.log(error);
        } else {
          for (const filename of files) {
            if (filename.endsWith('.ts') || filename.endsWith('.m3u8')) {
              fs.unlinkSync(`${outPath}/${filename}`);
            }
          }
        }
      });
    });
  }

  transEnd() {
    this.ffmpegProcess.kill();
  }
}

module.exports = TRANS_SESSION;
