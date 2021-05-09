const EventEmitter = require('events');

const sessions = new Map();
const publishers = new Map();
const idlePlayers = new Set();
const events = new EventEmitter();
const stat = {
  inBytes: 0,
  outBytes: 0,
  accepted: 0,
};

module.exports = {
  sessions,
  publishers,
  idlePlayers,
  events,
  stat,
};
