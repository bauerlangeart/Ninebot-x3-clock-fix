// SPDX-License-Identifier: Apache-2.0
//
// Ninebot BLE "Encryption2" crypto primitives, in plain browser JavaScript.
//
// Ported from nb_crypto.py of segway-ninebot-ble-cli
// (https://codeberg.org/NootNooot/segway-ninebot-ble-cli),
// Copyright 2026 NootNooot, licensed under the Apache License 2.0.
// Changes: rewritten in JavaScript on top of the Web Crypto API.
// See NOTICE and LICENSE-APACHE in the repository root.
//
// Only browser built-ins are used (crypto.subtle, BigInt), so the same file
// runs in Chrome and in Node >= 20 (used by the tests).

const subtle = globalThis.crypto.subtle;

// Gen2 non-SN ECB input and initial key2 (libnbcrypto.so @ 0x45A80).
export const FW_DATA = new Uint8Array([
  0x97, 0xcf, 0xb8, 0x02, 0x84, 0x41, 0x43, 0xde,
  0x56, 0x00, 0x2b, 0x3b, 0x34, 0x78, 0x0a, 0x5d,
]);

const ZERO16 = new Uint8Array(16);

function pad16(bytes) {
  const out = new Uint8Array(16);
  out.set(bytes ? bytes.subarray(0, 16) : ZERO16);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function xor(a, b, n = Math.min(a.length, b.length)) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** SHA-1(key1_pad16 || key2_pad16)[0:16] -> 16-byte AES-128 key. */
export async function deriveKey(key1, key2) {
  const digest = await subtle.digest('SHA-1', concat(pad16(key1), pad16(key2)));
  return new Uint8Array(digest).slice(0, 16);
}

// Web Crypto has no ECB mode. One ECB block equals the first output block of
// AES-CBC with an all-zero IV, so that is what we use.
async function importAesKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt']);
}

async function aesEcbBlock(cryptoKey, block) {
  const out = await subtle.encrypt({ name: 'AES-CBC', iv: ZERO16 }, cryptoKey, block);
  return new Uint8Array(out).slice(0, 16);
}

// nonce_13 = counter_BE32 || auth[0:8] || 0x00
function buildNonce(counter, auth) {
  const n = new Uint8Array(13);
  new DataView(n.buffer).setUint32(0, counter >>> 0, false);
  n.set(auth.subarray(0, 8), 4);
  return n;
}

// A_i = 0x01 || nonce_13 || 0x00 || i
function buildABlock(nonce, i) {
  return concat([0x01], nonce, [0x00, i & 0xff]);
}

// B_0 = 0x59 || nonce_13 || 0x00 || payload_len
function buildB0(nonce, payloadLen) {
  return concat([0x59], nonce, [0x00, payloadLen & 0xff]);
}

async function cbcMac(key, plaintext, nonce) {
  let x = await aesEcbBlock(key, buildB0(nonce, plaintext.length - 3));
  // The 3-byte frame header acts as "associated data", zero-padded to 16.
  x = await aesEcbBlock(key, xor(x, pad16(plaintext.subarray(0, 3)), 16));
  const payload = plaintext.subarray(3);
  for (let o = 0; o < payload.length; o += 16) {
    x = await aesEcbBlock(key, xor(x, pad16(payload.subarray(o, o + 16)), 16));
  }
  return x.slice(0, 4);
}

async function ctrXor(key, data, nonce) {
  const out = new Uint8Array(data.length);
  for (let o = 0, i = 1; o < data.length; o += 16, i++) {
    const ks = await aesEcbBlock(key, buildABlock(nonce, i));
    const n = Math.min(16, data.length - o);
    for (let j = 0; j < n; j++) out[o + j] = data[o + j] ^ ks[j];
  }
  return out;
}

function checksum16(payload) {
  let sum = 0;
  for (const b of payload) sum += b;
  return ~sum & 0xffff;
}

/**
 * Stateful encryption context (mirrors crypto_param_t in libnbcrypto.so).
 * counter == 0 means "non-SN mode" (only used for PRE_COMM).
 */
export class NbCrypto {
  constructor(ecbInput = ZERO16) {
    this.ecbInput = pad16(ecbInput);
    this.key1 = new Uint8Array(0);
    this.key2 = null;
    this.auth = new Uint8Array(16);
    this.counter = 0;
    this._key = null;
  }

  setKey(key1, key2) {
    this.key1 = key1;
    this.key2 = key2;
    this._key = null;
  }

  setAuthParam(auth) { this.auth = pad16(auth); }
  startSn() { this.counter = 1; }
  resetSn() { this.counter = 0; }

  async _aesKey() {
    if (!this._key) this._key = await importAesKey(await deriveKey(this.key1, this.key2));
    return this._key;
  }

  /** Encrypt a plaintext frame. Output length = input length + 6. */
  async encrypt(plaintext) {
    const key = await this._aesKey();
    const header = plaintext.subarray(0, 3);
    const payload = plaintext.subarray(3);

    if (this.counter > 0) {
      this.counter += 1;
      const nonce = buildNonce(this.counter, this.auth);
      const tag = await cbcMac(key, plaintext, nonce);
      const body = await ctrXor(key, payload, nonce);
      const a0 = await aesEcbBlock(key, buildABlock(nonce, 0));
      const ctr = this.counter & 0xffff;
      return concat(header, body, xor(tag, a0, 4), [ctr >> 8, ctr & 0xff]);
    }

    const ks = await aesEcbBlock(key, this.ecbInput);
    const body = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ ks[i % 16];
    const cs = checksum16(payload);
    return concat(header, body, [0x00, 0x00, cs & 0xff, cs >> 8, 0x00, 0x00]);
  }

  /** Decrypt a frame. Returns { plain, ok } - ok is false on MAC/checksum mismatch. */
  async decrypt(frame) {
    const key = await this._aesKey();
    const header = frame.subarray(0, 3);
    const body = frame.subarray(3, frame.length - 6);
    const tail = frame.subarray(frame.length - 6);
    const recvCounter = (tail[4] << 8) | tail[5];

    if (recvCounter > 0) {
      const nonce = buildNonce(recvCounter, this.auth);
      const plain = concat(header, await ctrXor(key, body, nonce));
      const a0 = await aesEcbBlock(key, buildABlock(nonce, 0));
      const recvTag = xor(tail.subarray(0, 4), a0, 4);
      const expected = await cbcMac(key, plain, nonce);
      return { plain, ok: recvTag.every((b, i) => b === expected[i]) };
    }

    const ks = await aesEcbBlock(key, this.ecbInput);
    const out = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) out[i] = body[i] ^ ks[i % 16];
    const plain = concat(header, out);
    return { plain, ok: checksum16(out) === (tail[2] | (tail[3] << 8)) };
  }
}

// --- java.util.Random (48-bit LCG), needed for the session password -------

const MASK48 = (1n << 48n) - 1n;
const MULT = 0x5deece66dn;

export class JavaRandom {
  constructor(seed) { this.seed = (BigInt.asIntN(64, BigInt(seed)) ^ MULT) & MASK48; }

  _next(bits) {
    this.seed = (this.seed * MULT + 0xbn) & MASK48;
    return Number(this.seed >> BigInt(48 - bits));
  }

  nextBytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n;) {
      const rnd = this._next(32);
      for (let j = 0; j < 4 && i < n; j++) out[i++] = (rnd >>> (8 * j)) & 0xff;
    }
    return out;
  }
}

/**
 * 16-byte session password, exactly like the official app
 * (AbstractCryptoPwdProvider.getRandomData): SHA-256 over 16 bytes of
 * java.util.Random seeded with currentTimeMillis + f(auth).
 */
export async function generatePassword(auth, timeMs = Date.now()) {
  let j = 0n;
  auth.forEach((b, i) => {
    const signed = b < 128 ? b : b - 256;
    const shift = ((i % 8) * 8) & 31; // Java int shift wraps at 32
    j = BigInt.asIntN(64, j + BigInt((signed << shift) | 0));
  });
  const seed = BigInt.asIntN(64, BigInt(timeMs) + j);
  const random = new JavaRandom(seed).nextBytes(16);
  const sha = await subtle.digest('SHA-256', random);
  return new Uint8Array(sha).slice(0, 16);
}
