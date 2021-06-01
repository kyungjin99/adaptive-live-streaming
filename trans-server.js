const fs = require('fs');
const TransSession = require('./trans-session');
const CURRENT_PROGRESS = require('./rtmp-center-ad');

// 서버 내의 ffmpeg 경로. 테스트 하고 싶다면 자신의 경로에 맞게 수정 필요.
const FFMPEG_PATH = 'C:/ffmpeg/bin/ffmpeg.exe';
const PORT = 1935;

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
    CURRENT_PROGRESS.events.on('donePublish', this.onDonePublish.bind(this));
    console.log('[TRANS SERVER] trans server is getting started');
  }

  onPostPublish(id, streamPath, args) {
    console.log('[TRANS SERVER] onPostPublish called');

    const conf = {};
    conf.ffmpeg = FFMPEG_PATH;
    conf.port = PORT;
    conf.streamPath = streamPath;
    conf.args = args;
    conf.id = id;

    const session = new TransSession(conf);
    this.transSessions.set(id, session);
    session.on('end', () => {
      console.log(`[TRANS SERVER] Trans session for ${id} has been deleted`);
      this.transSessions.delete(id);
    });
    session.run();
  }

  onDonePublish(id, streamPath, args) {
    const transSession = this.transSessions.get(id);
    if (transSession) {
      console.log('[TRANS SERVER] onDonePublish called');
      transSession.end();
    }
  }
}

module.exports = TRANS_SERVER;
