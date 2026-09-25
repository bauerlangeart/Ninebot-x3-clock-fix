// Run with: node test/run-tests.mjs
// vectors.json was generated with the Python reference client
// (segway-ninebot-ble-cli, nb_crypto.py / nb_protocol.py).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { deriveKey, JavaRandom, generatePassword, NbCrypto, FW_DATA } from '../lib/nb-crypto.js';
import { VARIANTS, buildFrame, parseFrame, NbSession, CMD, BOARD_BLE } from '../lib/nb-protocol.js';
import { FrameAssembler } from '../lib/ble-transport.js';
import { analyse, encodeRaw, decodeRaw, utcOffsetMinutes } from '../lib/timezone.js';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
const h2b = (s) => Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
const b2h = (b) => Buffer.from(b).toString('hex');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name); console.log(e); process.exitCode = 1; }
}

await test('deriveKey', async () => {
  for (const v of V.derive_key) {
    assert.equal(b2h(await deriveKey(h2b(v.k1), v.k2 ? h2b(v.k2) : null)), v.out);
  }
});

await test('JavaRandom', () => {
  assert.equal(b2h(new JavaRandom(V.java_random.seed).nextBytes(16)), V.java_random.bytes16);
});

await test('generatePassword', async () => {
  const p = V.password;
  assert.equal(b2h(await generatePassword(h2b(p.auth), p.time_ms)), p.out);
});

await test('non-SN PRE_COMM encrypt (gen2 + gen3)', async () => {
  const name = new TextEncoder().encode('TESTDEVICE0001');
  for (const v of V.non_sn) {
    const variant = VARIANTS[v.gen];
    const plain = buildFrame(variant, BOARD_BLE, CMD.PRE_COMM, 0);
    assert.equal(b2h(plain), v.plain);
    const c = new NbCrypto(variant.ecbInput);
    c.setKey(name, variant.initialKey2);
    const enc = await c.encrypt(plain);
    assert.equal(b2h(enc), v.enc);
    const d = new NbCrypto(variant.ecbInput);
    d.setKey(name, variant.initialKey2);
    const r = await d.decrypt(enc);
    assert.ok(r.ok);
    assert.equal(b2h(r.plain), v.plain);
  }
});

await test('SN-mode frame sequence (SET_PWD, AUTH, READ, WRITE_NR)', async () => {
  const s = V.sn_seq;
  const c = new NbCrypto(FW_DATA);
  const auth = h2b(s.auth);
  c.setAuthParam(auth);
  c.startSn();
  for (const f of s.frames) {
    c.setKey(f.key1 === 'name' ? h2b(s.name) : h2b(s.password), auth);
    assert.equal(b2h(await c.encrypt(h2b(f.plain))), f.enc);
  }
});

await test('SN-mode decrypt + MAC check', async () => {
  const s = V.sn_seq;
  const c = new NbCrypto(FW_DATA);
  c.setKey(h2b(s.password), h2b(s.auth));
  c.setAuthParam(h2b(s.auth));
  const enc = h2b(V.sn_resp.enc);
  const r = await c.decrypt(enc);
  assert.ok(r.ok);
  assert.equal(b2h(r.plain), V.sn_resp.plain);
  enc[5] ^= 1;
  assert.equal((await c.decrypt(enc)).ok, false);
  const f = parseFrame(h2b(V.sn_resp.plain));
  assert.deepEqual([f.board, f.cmd, f.index, b2h(f.data)], [0x23, CMD.READ_RESP, 0x86, '0800']);
});

await test('FrameAssembler reassembles fragmented + concatenated frames', () => {
  const frames = [];
  const a = new FrameAssembler((f) => frames.push(b2h(f)));
  const f1 = h2b(V.sn_seq.frames[1].enc); // 27 bytes -> two notifications
  const f2 = h2b(V.sn_resp.enc);
  a.push(new Uint8Array([0x00, 0x13])); // garbage
  a.push(f1.slice(0, 20));
  a.push(new Uint8Array([...f1.slice(20), ...f2.slice(0, 4)]));
  a.push(f2.slice(4));
  assert.deepEqual(frames, [b2h(f1), b2h(f2)]);
});

await test('timezone analysis', () => {
  // Clock 6h ahead in German summer time: the scooter is on UTC+8.
  let r = analyse(encodeRaw(8), 6, 120);
  assert.deepEqual(r.matches.map((m) => [m.id, m.target]), [['hours', 2]]);
  r = analyse(encodeRaw(480), 6, 120);
  assert.deepEqual(r.matches.map((m) => [m.id, m.target]), [['minutes', 120]]);
  r = analyse(encodeRaw(20), 7, 60); // winter
  assert.deepEqual(r.matches.map((m) => [m.id, m.target]), [['hours-plus-12', 13]]);
  assert.equal(analyse(encodeRaw(1234), 6, 120).matches.length, 0);
  assert.deepEqual(decodeRaw(encodeRaw(-60)), { u16: 0xffc4, i16: -60 });
});

await test('Europe/Berlin offset', () => {
  assert.equal(utcOffsetMinutes('Europe/Berlin', new Date('2026-07-01T12:00:00Z')), 120);
  assert.equal(utcOffsetMinutes('Europe/Berlin', new Date('2026-12-01T12:00:00Z')), 60);
  assert.equal(utcOffsetMinutes('Asia/Shanghai', new Date('2026-07-01T12:00:00Z')), 480);
});

// End-to-end: our handshake against a simulated scooter built from the same crypto.
await test('handshake + read against simulated scooter', async () => {
  const name = new TextEncoder().encode('TESTDEVICE0001');
  const serial = new TextEncoder().encode('TESTDEVICE0001');
  const auth = new Uint8Array(16).fill(7);
  const variant = VARIANTS.gen2;
  const dev = new NbCrypto(variant.ecbInput);
  let password = null;
  const inbox = [];
  const reply = async (plain) => inbox.push(await dev.encrypt(plain));
  const resp = (cmd, index, data = []) => new Uint8Array([0x5a, 0xa5, data.length, 0x04, 0x3e, cmd, index, ...data]);
  const transport = {
    async send(enc) {
      if (enc[1] !== variant.sync2) return; // gen3 attempt: stay silent
      if (dev.counter === 0) {
        dev.setKey(name, variant.initialKey2);
        const { plain } = await dev.decrypt(enc);
        assert.equal(plain[5], CMD.PRE_COMM);
        await reply(resp(CMD.PRE_COMM, 0, [...auth, ...serial]));
        dev.setAuthParam(auth);
        dev.startSn();
        dev.setKey(name, auth);
        return;
      }
      const { plain, ok } = await dev.decrypt(enc);
      assert.ok(ok, 'MAC ok on device side');
      const f = { cmd: plain[5], index: plain[6], data: plain.slice(7) };
      if (f.cmd === CMD.SET_PWD) {
        password = f.data;
        await reply(resp(CMD.SET_PWD, 0));
        await reply(resp(CMD.SET_PWD, 1)); // user pressed the button
        dev.setKey(password, auth);
      } else if (f.cmd === CMD.AUTH) {
        assert.equal(b2h(f.data), b2h(serial));
        await reply(resp(CMD.AUTH, 1));
      } else if (f.cmd === CMD.READ) {
        await reply(new Uint8Array([0x5a, 0xa5, 2, 0x23, 0x3e, CMD.READ_RESP, f.index, 8, 0]));
      }
    },
    async recv() {
      if (!inbox.length) { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }
      return inbox.shift();
    },
  };
  let pressed = false;
  const s = new NbSession(transport);
  const res = await s.handshake(name, { variants: ['gen3', 'gen2'], onButtonPress: () => { pressed = true; } });
  assert.equal(res.serial, 'TESTDEVICE0001');
  assert.equal(res.variant, 'gen2');
  assert.ok(pressed);
  assert.equal(b2h(res.password), b2h(password));
  assert.equal(b2h(await s.readRegister(0x23, 0x86, 2)), '0800');
});

console.log(`\n${passed} Tests bestanden${process.exitCode ? ', FEHLER vorhanden' : ''}`);
