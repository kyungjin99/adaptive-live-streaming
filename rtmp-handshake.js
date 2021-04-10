const crypto = require('crypto');

const RANDOM_ECHO_SIZE = 1528;

function generateS0S1S2(packet) {
  // s0
  const rtmpVersion = Buffer.alloc(1, 3);

  // s1, s2
  const timestamp = packet.slice(0, 4);
  const zeros = Buffer.alloc(4, 0);
  const randomEcho = crypto.randomBytes(RANDOM_ECHO_SIZE);

  const s1 = Buffer.concat([timestamp, zeros, randomEcho]);
  const s2 = Buffer.concat([timestamp, zeros, randomEcho]);

  const s0s1s2 = Buffer.concat([rtmpVersion, s1, s2]);
  return s0s1s2;
}

module.exports = { generateS0S1S2 };
