//
//  Created by Mingliang Chen on 18/3/9.
//  illuspas[a]gmail.com
//  Copyright (c) 2018 Nodemedia. All rights reserved.
//
const EventEmitter = require('events');
const { spawn } = require('child_process');
const mkdirp = require('mkdirp');
const fs = require('fs');

const PORT = 1935;
class NodeTransSession extends EventEmitter {
  constructor(conf) {
    super();
    this.conf = conf;
  }

  run() {
    let vc = this.conf.vc || 'copy';
    let ac = this.conf.ac || 'copy';
    let inPath = `rtmp://127.0.0.1:${PORT}${this.conf.streamPath}`;
    let ouPath = `live/${this.conf.streamPath}`;
    let mapStr = '[hls_time=2:hls_list_size=5:hls_flags=delete_segments]';

    mkdirp.sync(ouPath);
    let argv = ['-y', '-i', inPath];
    Array.prototype.push.apply(argv, ['-c:v', vc]);
    Array.prototype.push.apply(argv, this.conf.vcParam);
    Array.prototype.push.apply(argv, ['-c:a', ac]);
    Array.prototype.push.apply(argv, this.conf.acParam);
    Array.prototype.push.apply(argv, ['-f', 'tee', '-map', '0:a?', '-map', '0:v?', mapStr]);

    this.ffmpeg_exec = spawn(this.conf.ffmpeg, argv);
    this.ffmpeg_exec.on('error', (e) => {
      // Logger.ffdebug(e);
    });

    this.ffmpeg_exec.stdout.on('data', (data) => {
      // Logger.ffdebug(`FF输出：${data}`);
    });

    this.ffmpeg_exec.stderr.on('data', (data) => {
      // Logger.ffdebug(`FF输出：${data}`);
    });

    this.ffmpeg_exec.on('close', (code) => {
      console.log(`[Transmuxing end] ${this.conf.streamPath}`);
      this.emit('end');
      fs.readdir(ouPath, (err, files) => {
        if (!err) {
          files.forEach((filename) => {
            if (filename.endsWith('.ts')
              || filename.endsWith('.m3u8')
              || filename.endsWith('.mpd')
              || filename.endsWith('.m4s')
              || filename.endsWith('.tmp')) {
              fs.unlinkSync(`${ouPath}/${filename}`);
            }
          });
        }
      });
    });
  }

  end() {
    this.ffmpeg_exec.kill();
  }
}

module.exports = NodeTransSession;
