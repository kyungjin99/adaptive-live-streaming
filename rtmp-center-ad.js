const sessions = new Map();
const publishers = new Map();
const idlePlayers = new Set();
const stat = {
  inBytes: 0,
  outBytes: 0,
  accepted: 0,
};

module.exports = {
  sessions,
  publishers,
  idlePlayers,
  stat,
};
