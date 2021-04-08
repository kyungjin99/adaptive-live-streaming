function generateS0S1S2(packet) {
  const rtmpVersion = Buffer.alloc(1, 3);
  const s0s1s2 = Buffer.concat([rtmpVersion, packet, packet]);
  return s0s1s2;
}

module.exports = { generateS0S1S2 };
