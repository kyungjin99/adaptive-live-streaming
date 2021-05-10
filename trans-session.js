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
    const vc = 'copy';
    const ac = 'copy';
    const inPath = `rtmp://127.0.0.1:${this.port}${this.streamPath}`;
    const outPath = this.streamPath;

    console.log(`[TRANS SESSION] inPath = ${inPath}`);
    console.log(`[TRANS SESSION] outPath = ${outPath}`);

    mkdirp.sync(outPath);
    let argv = ['-y', '-i', inPath];
    argv = argv.concat([`-c:v ${vc}`]);
    argv = argv.concat([`-c:a ${ac}`]);
    argv = argv.concat(['-f', 'tee', '-map', '0:a?', '-map', '0:v?', `[hls_time=2:hls_list_size=5:hls_flags=delete_segments]${outPath}/${this.hlsName}`]);

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
              fs.unlinkSync(`outPath/${filename}`);
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
