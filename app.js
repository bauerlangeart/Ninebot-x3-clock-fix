// SPDX-License-Identifier: MIT
//
// UI for the G3D clock fix. Only the timezone register is ever written.

import { BleTransport, isSupported } from './lib/ble-transport.js';
import { NbSession, CMD, hex } from './lib/nb-protocol.js';
import { analyse, encodeRaw, utcOffsetMinutes } from './lib/timezone.js';

// The timezone register is documented as DIS (0x01) index 134 (E-series).
// The Max G3 has no board 0x01; SHU reads its settings from the VCU (0x16),
// the dashboard is "tft" (0x23). All are tried with a harmless read; writing
// uses the board that answered.
const TZ_INDEX = 0x86;
const TZ_BOARDS = [
  // SHU reads the serial number and settings of a Max G3 from the VCU (0x16).
  { id: 0x16, name: 'Steuergerät (vcu, 0x16)' },
  { id: 0x23, name: 'Dashboard (tft, 0x23)' },
  { id: 0x01, name: 'Dashboard (dis, 0x01)' },
];
const SN_INDEX = 0x10;
const TIME_ZONE = 'Europe/Berlin';
const APP_VERSION = '9';

const $ = (id) => document.getElementById(id);
const els = {
  connect: $('btn-connect'),
  disconnect: $('btn-disconnect'),
  read: $('btn-read'),
  write: $('btn-write'),
  test: $('btn-test'),
  diag: $('btn-diag'),
  logBox: $('log-box'),
  forget: $('btn-forget'),
  copyLog: $('btn-copy-log'),
  name: $('in-name'),
  pwd: $('in-pwd'),
  shift: $('in-shift'),
  pressButton: $('press-button'),
  readResult: $('read-result'),
  targetInfo: $('target-info'),
  log: $('log'),
};

let transport = null;
let session = null;
let serial = '';
let tzBoard = null; // board that answered the timezone read
let pendingWrite = null; // { board, value, bytes, enc } - set by a successful read + analysis
let busy = false;

// ---- helpers --------------------------------------------------------------

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
}

function log(...parts) {
  const t = new Date().toLocaleTimeString('de-DE');
  els.log.textContent += `[${t}] ${parts.join(' ')}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function logFrame(dir, plain, enc) {
  if (typeof plain === 'string') return log(dir, plain);
  let shown = plain;
  // Never show the session password (SET_PWD payload) in the log.
  if (plain.length > 7 && plain[5] === CMD.SET_PWD && dir.startsWith('TX')) {
    shown = plain.slice(0, 7);
    return log(dir, hex(shown), '+ [Passwort ausgeblendet]');
  }
  log(dir, hex(shown), enc ? `→ ${hex(enc)}` : '');
}

function storage(fn) {
  try { return fn(window.localStorage); } catch { return null; }
}

const pwdKey = (name) => `g3d-clock-fix:pwd:${name}`;
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (s) => Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));

function setStepEnabled(sectionId, on) {
  $(sectionId).setAttribute('aria-disabled', on ? 'false' : 'true');
}

function refreshButtons() {
  const linked = !!transport?.connected;
  const connected = !!session && linked;
  els.connect.hidden = linked;
  els.disconnect.hidden = !linked;
  els.diag.disabled = !linked || busy;
  els.connect.disabled = busy || !isSupported();
  els.read.disabled = !connected || busy;
  els.test.disabled = !connected || busy;
  els.write.disabled = !connected || busy || !pendingWrite;
  setStepEnabled('step-read', connected);
  setStepEnabled('step-write', connected && !!pendingWrite);
}

async function run(fn) {
  busy = true;
  refreshButtons();
  try { await fn(); } finally { busy = false; refreshButtons(); }
}

function explain(e) {
  if (e?.name === 'NotFoundError') return 'Kein Gerät ausgewählt.';
  if (e?.name === 'SecurityError') return 'Bluetooth ist für diese Seite nicht erlaubt (nur über https nutzbar).';
  if (e?.name === 'NetworkError') return 'Verbindung fehlgeschlagen. Ist SHU noch verbunden? Roller in der Nähe?';
  if (e?.name === 'TimeoutError') return 'Der Roller antwortet nicht (Zeitüberschreitung).';
  return e?.message || String(e);
}

function describeTarget() {
  const minutes = utcOffsetMinutes(TIME_ZONE);
  const summer = minutes === 120;
  return { minutes, text: `Ziel: deutsche ${summer ? 'Sommerzeit' : 'Winterzeit'} (UTC+${minutes / 60}).` };
}

// ---- connect --------------------------------------------------------------

async function connect() {
  setStatus('status-connect', 'Gerät auswählen …');
  pendingWrite = null;
  els.readResult.hidden = true;
  transport = new BleTransport();
  transport.onLog = (dir, msg) => log(dir, msg);
  transport.onDisconnect = () => {
    log('INFO', 'Verbindung getrennt');
    session = null;
    setStatus('status-connect', 'Verbindung getrennt.', '');
    refreshButtons();
  };

  const device = await transport.requestDevice();
  setStatus('status-connect', `Verbinde mit „${device.name || 'Gerät'}“ …`);
  await transport.connect();
  log('INFO', `Version ${APP_VERSION}`);
  log('INFO', `GATT verbunden, Kanäle: ${transport.channels.map((c) => c.name).join(', ')}`);

  const name = els.name.value.trim() || await transport.readDeviceName();
  if (!name) throw new Error('Gerätename unbekannt. Bitte unter „Erweitert“ die Seriennummer eintragen.');
  els.name.value = name;
  log('INFO', `Gerätename (Schlüssel): ${name}`);

  const manual = els.pwd.value.replace(/[^0-9a-f]/gi, '');
  if (manual && manual.length !== 32) {
    throw new Error('Das Kopplungs-Passwort muss genau 32 Hex-Zeichen lang sein.');
  }
  const stored = manual || storage((s) => s.getItem(pwdKey(name)));
  if (manual) log('INFO', 'Verwende eingetragenes Kopplungs-Passwort');
  session = new NbSession(transport, { log: logFrame });
  setStatus('status-connect', 'Anmeldung am Roller …');
  let res = null;
  let lastError = null;
  for (let i = 0; i < transport.channels.length && !res; i++) {
    transport.useChannel(i);
    log('INFO', `Versuche Kanal ${transport.channel.name}`);
    try {
      res = await session.handshake(new TextEncoder().encode(name), {
        storedPassword: stored ? hexToBytes(stored) : null,
        onButtonPress: () => {
          els.pressButton.hidden = false;
          setStatus('status-connect', 'Warte auf Bestätigung am Roller …');
        },
      });
    } catch (e) {
      lastError = e;
      // Only "no answer at all" is worth retrying on the next channel.
      if (e?.code !== 'PRE_COMM' || transport.rawCount) throw e;
    }
  }
  if (!res) throw lastError;
  log('INFO', `Kanal ${transport.channel.name} funktioniert`);
  els.pressButton.hidden = true;
  serial = res.serial;
  storage((s) => s.setItem(pwdKey(name), bytesToHex(res.password)));
  log('INFO', `Angemeldet. Seriennummer ${serial}, Protokoll-Variante ${res.variant}`);
  setStatus('status-connect', `Verbunden mit ${serial}.`, 'ok');
}

els.connect.addEventListener('click', () => run(async () => {
  try {
    await connect();
  } catch (e) {
    els.pressButton.hidden = true;
    let msg = explain(e);
    if (e?.code === 'AUTH' && els.name.value.trim()) {
      // A stale stored password makes AUTH fail; drop it so the next try pairs anew.
      storage((s) => s.removeItem(pwdKey(els.name.value.trim())));
      msg += ' Die gespeicherte Kopplung wurde zurückgesetzt – bitte noch einmal verbinden.';
    }
    if (transport?.connected) {
      msg += transport.rawCount
        ? ` Es kamen ${transport.rawCount} unbekannte Nachrichten an (siehe Protokoll).`
        : ' Es kam keine einzige Nachricht vom Roller zurück.';
      msg += ' Die Bluetooth-Verbindung bleibt offen: Unten „Diagnose starten“ antippen und danach das Protokoll schicken.';
      els.logBox.open = true;
    }
    log('FEHLER', msg);
    setStatus('status-connect', msg, 'error');
    session = null;
  }
}));

els.disconnect.addEventListener('click', () => {
  transport?.disconnect();
  transport = null;
  session = null;
  pendingWrite = null;
  refreshButtons();
});

els.forget.addEventListener('click', () => {
  const name = els.name.value.trim();
  storage((s) => {
    Object.keys(s).filter((k) => k.startsWith('g3d-clock-fix:pwd:') && (!name || k === pwdKey(name)))
      .forEach((k) => s.removeItem(k));
  });
  log('INFO', 'Gespeicherte Kopplung gelöscht');
  els.forget.textContent = 'Vergessen ✓';
});

// ---- read -----------------------------------------------------------------

async function readTimezone() {
  const boards = tzBoard ? [TZ_BOARDS.find((b) => b.id === tzBoard)] : TZ_BOARDS;
  for (const b of boards) {
    setStatus('status-read', `Lese ${b.name} …`);
    try {
      const data = await session.readRegister(b.id, TZ_INDEX, 2);
      if (data.length >= 2) {
        log('INFO', `Zeitzone von ${b.name}: ${hex(data)}`);
        return { board: b, data: data.slice(0, 2) };
      }
    } catch (e) {
      log('INFO', `${b.name}: ${explain(e)}`);
    }
  }
  return null;
}

function showRead(board, bytes, a) {
  const rows = [
    ['Board', board.name],
    ['Rohwert', hex(bytes)],
    ['Als Zahl', a.u16 === a.i16 ? `${a.u16}` : `${a.u16} (vorzeichenbehaftet ${a.i16})`],
    ['Erwartete Roller-Zeitzone', `UTC${a.deviceMinutes >= 0 ? '+' : ''}${a.deviceMinutes / 60}`],
    ['Erkanntes Format', a.matches.length === 1 ? a.matches[0].label
      : a.matches.length ? 'mehrdeutig' : 'unbekannt'],
  ];
  els.readResult.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
  els.readResult.hidden = false;
}

els.read.addEventListener('click', () => run(async () => {
  pendingWrite = null;
  const shift = Number(els.shift.value);
  if (!Number.isInteger(shift) || Math.abs(shift) > 14) {
    setStatus('status-read', 'Bitte eine ganze Stundenzahl eintragen.', 'error');
    return;
  }
  const r = await readTimezone();
  if (!r) {
    setStatus('status-read', 'Kein Dashboard hat auf die Zeitzonen-Abfrage geantwortet. Bitte Protokoll kopieren und melden.', 'error');
    return;
  }
  tzBoard = r.board.id;
  const target = describeTarget();
  const a = analyse(r.data, shift, target.minutes);
  showRead(r.board, r.data, a);

  if (a.matches.length === 1) {
    const m = a.matches[0];
    pendingWrite = { board: r.board, value: m.target, bytes: encodeRaw(m.target), enc: m, before: r.data };
    setStatus('status-read', 'Format erkannt – Schritt 3 ist freigeschaltet.', 'ok');
    els.targetInfo.textContent = `${target.text} Neuer Wert: ${m.target} (Bytes ${hex(pendingWrite.bytes)}), bisher ${m.current}.`;
  } else {
    setStatus('status-read',
      'Das Format des Werts ist noch nicht bekannt. Zur Sicherheit wird nichts geschrieben. '
      + 'Bitte prüfe die Stundenzahl oben oder schicke den Rohwert und das Protokoll an die Entwickler.', 'error');
    els.targetInfo.textContent = '';
  }
}));

// ---- write ----------------------------------------------------------------

els.write.addEventListener('click', () => run(async () => {
  const w = pendingWrite;
  if (!w) return;
  const ok = window.confirm(
    `Zeitzone jetzt schreiben?\n\n${w.board.name}, Register 0x86\n`
    + `bisher: ${hex(w.before)} → neu: ${hex(w.bytes)} (${w.enc.label})\n\n`
    + 'Es wird nur dieses eine Register verändert. Der alte Wert steht im Protokoll, falls du ihn zurücksetzen möchtest.');
  if (!ok) return;

  setStatus('status-write', 'Schreibe …');
  log('INFO', `Schreibe ${hex(w.bytes)} auf ${w.board.name} Register 0x86 (vorher ${hex(w.before)})`);
  try {
    await session.writeRegisterNoResponse(w.board.id, TZ_INDEX, w.bytes);
    await new Promise((r) => setTimeout(r, 600));
    const after = await session.readRegister(w.board.id, TZ_INDEX, 2);
    if (after[0] === w.bytes[0] && after[1] === w.bytes[1]) {
      setStatus('status-write', 'Fertig! Roller jetzt aus- und wieder einschalten und die Uhr prüfen.', 'ok');
      log('INFO', `Kontrolle gelesen: ${hex(after)} ✓`);
      pendingWrite = null;
    } else {
      setStatus('status-write', `Der Roller meldet nach dem Schreiben ${hex(after)} statt ${hex(w.bytes)}. Bitte Protokoll melden.`, 'error');
      log('WARNUNG', `Kontrolle gelesen: ${hex(after)}`);
    }
  } catch (e) {
    setStatus('status-write', explain(e), 'error');
    log('FEHLER', explain(e));
  }
}));

// ---- diagnose -------------------------------------------------------------

// Read-only probes in the older, unencrypted Ninebot frame formats. Custom
// firmware may speak one of these instead of Encryption2. All of them only
// ask for the serial number (register 0x10); nothing is written.
function plainFrame(bytes) {
  let sum = 0;
  for (const b of bytes.slice(2)) sum += b;
  const cs = ~sum & 0xffff;
  return new Uint8Array([...bytes, cs & 0xff, cs >> 8]);
}

const PROBES = [
  { label: '5A A5 unverschlüsselt, Board 0x20, App-ID 0x3E', frame: [0x5a, 0xa5, 0x01, 0x3e, 0x20, 0x01, 0x10, 0x0e] },
  { label: '5A A5 unverschlüsselt, Board 0x20, App-ID 0x3D', frame: [0x5a, 0xa5, 0x01, 0x3d, 0x20, 0x01, 0x10, 0x0e] },
  { label: '5A A5 unverschlüsselt, Board 0x02 (G3-MCU)', frame: [0x5a, 0xa5, 0x01, 0x3e, 0x02, 0x01, 0x10, 0x0e] },
  { label: '5A A5 unverschlüsselt, Board 0x23 (G3-Dashboard)', frame: [0x5a, 0xa5, 0x01, 0x3e, 0x23, 0x01, 0x10, 0x0e] },
  { label: '55 AA (Protokoll 1), Board 0x20', frame: [0x55, 0xaa, 0x03, 0x20, 0x01, 0x10, 0x0e] },
];

async function diagnose() {
  log('DIAG', `Start. Bisher empfangene Rohnachrichten: ${transport.rawCount}`);
  for (let i = 0; i < transport.channels.length; i++) {
    transport.useChannel(i);
    for (const p of PROBES) {
      const f = plainFrame(p.frame);
      const before = transport.rawCount;
      log('DIAG', `[${transport.channel.name}] ${p.label}: TX ${hex(f)}`);
      transport.flush();
      await transport.send(f);
      await new Promise((r) => setTimeout(r, 2000));
      log('DIAG', transport.rawCount > before ? `→ ${transport.rawCount - before} Antwort(en)` : '→ keine Antwort');
    }
  }
  transport.useChannel(0);
  log('DIAG', `Ende. Empfangene Rohnachrichten insgesamt: ${transport.rawCount}`);
}

els.diag.addEventListener('click', () => run(async () => {
  try {
    await diagnose();
    setStatus('status-connect', 'Diagnose fertig – bitte „Protokoll kopieren“ und schicken.', 'ok');
  } catch (e) {
    log('FEHLER', `Diagnose: ${explain(e)}`);
  }
}));

// ---- misc -----------------------------------------------------------------

els.test.addEventListener('click', () => run(async () => {
  for (const b of TZ_BOARDS) {
    try {
      const d = await session.readRegister(b.id, SN_INDEX, 14);
      log('TEST', `${b.name} Seriennummer: ${new TextDecoder().decode(d).replace(/\0/g, '')}`);
      return;
    } catch (e) {
      log('TEST', `${b.name}: ${explain(e)}`);
    }
  }
}));

els.copyLog.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.log.textContent);
    els.copyLog.textContent = 'Kopiert ✓';
  } catch {
    els.copyLog.textContent = 'Kopieren nicht möglich – Text markieren';
  }
});

if (!isSupported()) $('unsupported').hidden = false;
els.targetInfo.textContent = describeTarget().text;
refreshButtons();

// Offline support: cache the app shell.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(
    () => { $('offline-state').textContent = `Version ${APP_VERSION} · offline nutzbar`; },
    () => { $('offline-state').textContent = `Version ${APP_VERSION}`; },
  );
}
