class RTMP_BITOPR {
  constructor(buffer) {
    this.buffer = buffer;
    this.buflen = buffer.length;
    this.bufpos = 0;
    this.bufoff = 0;
    this.iserro = false;
  }

  read(n) {
    let v = 0;
    let d = 0;
    let temp = n;

    while (temp) {
      if (temp < 0 || this.bufpos >= this.buflen) {
        this.iserro = true;
        return 0;
      }

      this.iserro = false;
      d = this.bufoff + temp > 8 ? 8 - this.bufoff : temp;

      v <<= d;
      v += (this.buffer[this.bufpos] >> (8 - this.bufoff - d)) & (0xff >> (8 - d));

      this.bufoff += d;
      temp -= d;

      if (this.bufoff === 8) {
        this.bufpos += 1;
        this.bufoff = 0;
      }
    }
    return v;
  }

  look(n) {
    let p = this.bufpos;
    let o = this.bufoff;
    let v = this.read(n);
    this.bufpos = p;
    this.bufoff = o;
    return v;
  }

  readGolomb() {
    let n;
    for (n = 0; this.read(1) === 0 && !this.iserro; n++);
    // eslint-disable-next-line no-bitwise
    return (1 << n) + this.read(n) - 1;
  }
}
module.exports = RTMP_BITOPR;
