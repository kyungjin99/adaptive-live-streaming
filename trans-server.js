const fs = require('fs');
const mkdirp = require('mkdirp');
const TransSession = require('./trans-session');
const CURRENT_PROGRESS = require('./rtmp-center-ad');

// 서버 내의 ffmpeg 경로. 테스트 하고 싶다면 자신의 경로에 맞게 수정 필요.
const FFMPEG_PATH = 'C:/ffmpeg/bin/ffmpeg.exe';
const PORT = 1935;
const RESOLUTIONS = ['1080p', '720p', '480p'];

class TRANS_SERVER {
  constructor() {
    this.transSessions = new Map();
  }

  run() {
    try {
      fs.accessSync(FFMPEG_PATH, fs.constants.X_OK);
    } catch (error) {
      console.log('[TRANS SERVER] ffmpeg path access fail');
      console.log(error);
    }

    CURRENT_PROGRESS.events.on('postPublish', this.onPostPublish.bind(this));
    console.log('[TRANS SERVER] trans server is getting started');
  }

  onPostPublish(id, streamPath, args) {
    console.log('[TRANS SERVER] onPostPublish called');

    const conf = {};
    conf.ffmpeg = FFMPEG_PATH;
    conf.port = PORT;
    conf.streamPath = streamPath;
    conf.args = args;
    // conf.resolution = resolution;

    const session = new TransSession(conf);
    this.transSessions.set(id, session);
    session.on('transEnd', () => {
      this.transSessions.delete(id);
    });
    session.run();

    // for (const resolution of RESOLUTIONS) {
    //   const conf = {};
    //   conf.ffmpeg = FFMPEG_PATH;
    //   conf.port = PORT;
    //   conf.streamPath = streamPath;
    //   conf.args = args;
    //   conf.resolution = resolution;

    //   const session = new TransSession(conf);
    //   this.transSessions.set(`${id} ${resolution}`, session);
    //   session.on('transEnd', () => {
    //     this.transSessions.delete(`${id} ${resolution}`);
    //   });
    //   session.run();
    // }
  }
}

module.exports = TRANS_SERVER;
