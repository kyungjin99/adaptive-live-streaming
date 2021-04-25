const CURRENT_PROGRESS = require('./rtmp-center-ad');

function genSessionID() {
  let doingRun = true;
  let id = '';
  const acceptable = 'ABCDEFGHIJKLMNOPQRSTUVWKYZ0123456789';
  const numberAcceptable = acceptable.length;

  while (doingRun) {
    for (let i = 0; i < 8; i++) {
      id += acceptable.charAt((Math.random() * numberAcceptable) | 0);
    }

    doingRun = CURRENT_PROGRESS.sessions.has(id);
  }

  return id;
}

function genName() {
  let name = '';
  const acceptable = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const numberAcceptable = acceptable.length;

  for (let i = 0; i < 4; ++i) {
    name += acceptable.charAt((Math.random() * numberAcceptable) | 0);
  }

  return name;
}

module.exports = {
  genSessionID,
  genName,
};
