'use strict';

/**
 * Tiny zero-dependency QR code encoder, just enough to show the game URL as a
 * scannable code in the Terminal at startup.
 *
 * Scope: byte mode, error-correction level M, versions 1–6 (up to 106 bytes —
 * plenty for "http://192.168.x.x:3000"). Follows ISO/IEC 18004.
 */

// Versions 1..6 at ECC level M: [total codewords, EC codewords per block, blocks]
const VERSIONS = [null, [26, 10, 1], [44, 16, 1], [70, 26, 1], [100, 18, 2], [134, 24, 2], [172, 16, 4]];

// ---- GF(256) Reed–Solomon -------------------------------------------------
const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly; // leading coefficient 1
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

// ---- Data codewords -------------------------------------------------------
function encodeCodewords(bytes, version) {
  const [total, ecLen, blocks] = VERSIONS[version];
  const dataLen = total - ecLen * blocks;
  const bits = [];
  const put = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, 8); // count (8 bits for versions 1–9)
  bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataLen * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into equal blocks (true for v1–6 at M), add EC, interleave.
  const per = dataLen / blocks;
  const dBlocks = [];
  const eBlocks = [];
  for (let b = 0; b < blocks; b++) {
    const d = data.slice(b * per, (b + 1) * per);
    dBlocks.push(d);
    eBlocks.push(rsRemainder(d, ecLen));
  }
  const out = [];
  for (let i = 0; i < per; i++) dBlocks.forEach((d) => out.push(d[i]));
  for (let i = 0; i < ecLen; i++) eBlocks.forEach((e) => out.push(e[i]));
  return out;
}

// ---- Matrix ---------------------------------------------------------------
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function buildBase(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    m[y][x] = dark;
    fn[y][x] = true;
  };
  // Timing patterns
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns + separators
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
    }
  }
  // Alignment pattern (v2–6 have exactly one, at size-7)
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // Reserve format areas (real bits drawn later) + dark module
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue; // don't overwrite the timing patterns
    set(8, i, false);
    set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  set(8, size - 8, true);
  return { size, m, fn };
}

function drawFormat(m, size, mask) {
  const data = (0b00 << 3) | mask; // ECC level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const set = (x, y, d) => (m[y][x] = d);
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function placeData(m, fn, size, codewords) {
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        m[y][x] = i < total ? ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;
        i++;
      }
    }
  }
}

function penalty(m, size) {
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && get(a, b) === get(a, b - 1)) run++;
        else {
          if (run >= 5) p += run - 2;
          run = 1;
        }
      }
      // finder-like 1:1:3:1:1 with 4 light modules on a side
      for (let b = 0; b + 10 < size; b++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(a, b + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  line((a, b) => m[a][b]);
  line((a, b) => m[b][a]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x < size - 1 && y < size - 1) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
      }
    }
  }
  p += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  return p;
}

/** Encode text -> 2D boolean array (true = dark). */
function qrMatrix(text, forceMask) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 1;
  while (version <= 6 && bytes.length > VERSIONS[version][0] - VERSIONS[version][1] * VERSIONS[version][2] - 2) version++;
  if (version > 6) throw new Error('QR: text too long');
  const codewords = encodeCodewords(bytes, version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue;
    const { size, m, fn } = buildBase(version);
    placeData(m, fn, size, codewords);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
    drawFormat(m, size, mask);
    const score = penalty(m, size);
    if (!best || score < best.score) best = { score, m };
  }
  return best.m;
}

/** Render for a terminal: two module rows per text line, forced black-on-white. */
function qrTerminal(text, quiet = 2) {
  const m = qrMatrix(text);
  const size = m.length + quiet * 2;
  const dark = (x, y) => {
    const xx = x - quiet;
    const yy = y - quiet;
    return yy >= 0 && xx >= 0 && yy < m.length && xx < m.length && m[yy][xx];
  };
  const lines = [];
  for (let y = 0; y < size; y += 2) {
    let s = '';
    for (let x = 0; x < size; x++) {
      const top = dark(x, y);
      const bot = y + 1 < size && dark(x, y + 1);
      // fg colours the upper half block, bg the lower half
      s += `\x1b[${top ? 30 : 97};${bot ? 40 : 107}m▀`;
    }
    lines.push(s + '\x1b[0m');
  }
  return lines.join('\n');
}

module.exports = { qrMatrix, qrTerminal };
