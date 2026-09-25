// SPDX-License-Identifier: Apache-2.0
//
// Ninebot BLE "Encryption2" frames and the 3-phase handshake
// (PRE_COMM -> SET_PWD -> AUTH), in plain browser JavaScript.
//
// Ported from nb_protocol.py and segway_ble_client.py of segway-ninebot-ble-cli
// (https://codeberg.org/NootNooot/segway-ninebot-ble-cli),
// Copyright 2026 NootNooot, licensed under the Apache License 2.0.
// Changes: rewritten in JavaScript, transport-agnostic, German status texts.
// See NOTICE and LICENSE-APACHE in the repository root.

import { NbCrypto, FW_DATA, generatePassword } from './nb-crypto.js';

export const BT_ID = 0x3e;

export const CMD = {
  READ: 0x01,
  WRITE: 0x02,
  WRITE_NR: 0x03,
  READ_RESP: 0x04,
  WRITE_RESP: 0x05,
  PRE_COMM: 0x5b,
  SET_PWD: 0x5c,
  AUTH: 0x5d,
};

export const BOARD_BLE = 0x04;

/**
 * The public docs disagree on the second sync byte and on the non-SN key
 * material. The reference client calls these two bundles "gen2" and "gen3";
 * both are tried, gen2 first (the documented Encryption2 default).
 */
export const VARIANTS = {
  gen2: { id: 'gen2', sync2: 0xa5, initialKey2: FW_DATA, ecbInput: FW_DATA },
  gen3: { id: 'gen3', sync2: 0xb5, initialKey2: null, ecbInput: new Uint8Array(16) },
};

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Plaintext app -> device frame: [5A, sync2, LEN, 3E, target, cmd, index, data...] */
export function buildFrame(variant, target, cmd, index, data = new Uint8Array(0)) {
  if (data.length > 255) throw new Error('Nutzdaten zu lang');
  const f = new Uint8Array(7 + data.length);
  f.set([0x5a, variant.sync2, data.length, BT_ID, target, cmd, index]);
  f.set(data, 7);
  return f;
}

/** Decrypted device -> app frame: [5A, sync2, LEN, source, 3E, cmd, index, data...] */
export function parseFrame(plain) {
  if (plain.length < 7 || plain[0] !== 0x5a) return null;
  if (plain[1] !== 0xa5 && plain[1] !== 0xb5) return null;
  if (plain[4] !== BT_ID) return null;
  const len = plain[2];
  return {
    board: plain[3],
    cmd: plain[5],
    index: plain[6],
    data: plain.slice(7, 7 + len),
  };
}

export class ProtocolError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * An authenticated connection on top of a transport that offers
 * send(bytes) and recv(timeoutMs) -> one complete encrypted frame.
 */
export class NbSession {
  constructor(transport, { log = () => {} } = {}) {
    this.transport = transport;
    this.log = log;
    this.crypto = null;
    this.variant = null;
  }

  async _send(plain) {
    const enc = await this.crypto.encrypt(plain);
    this.log('TX', plain, enc);
    await this.transport.send(enc);
  }

  async _recv(timeoutMs) {
    const enc = await this.transport.recv(timeoutMs);
    const { plain, ok } = await this.crypto.decrypt(enc);
    this.log(ok ? 'RX' : 'RX (MAC/Prüfsumme falsch)', plain, enc);
    return { plain, ok, frame: parseFrame(plain) };
  }

  /**
   * Phase 1 only: returns the PRE_COMM answer or null on timeout / rejection.
   * Used to find out which variant the scooter speaks.
   */
  async _preComm(variant, btName) {
    this.variant = variant;
    this.crypto = new NbCrypto(variant.ecbInput);
    this.crypto.setKey(btName, variant.initialKey2);
    const req = buildFrame(variant, BOARD_BLE, CMD.PRE_COMM, 0x00);
    this.transport.flush?.();
    await this._send(req);
    let resp;
    try {
      resp = await this._recv(3000);
    } catch (e) {
      if (e.name === 'TimeoutError') return null;
      throw e;
    }
    // The scooter echoes the request unchanged when it rejects the key.
    if (resp.plain.length === req.length && resp.plain.every((b, i) => b === req[i])) {
      return { rejected: true };
    }
    if (!resp.ok || !resp.frame || resp.frame.cmd !== CMD.PRE_COMM || resp.frame.data.length < 30) {
      return null;
    }
    return { frame: resp.frame };
  }

  /**
   * Full handshake.
   * @param btName        Uint8Array - advertised BLE name (= serial), key material
   * @param storedPassword Uint8Array|null - password from an earlier pairing of this browser
   * @param onButtonPress () => void - called when the scooter waits for a button press
   * @returns {Promise<{password: Uint8Array, serial: string, variant: string}>}
   */
  async handshake(btName, { storedPassword = null, variants = ['gen2', 'gen3'], onButtonPress = () => {} } = {}) {
    let pre = null;
    let sawReject = false;
    for (const id of variants) {
      this.log('INFO', `PRE_COMM mit Variante ${id}`);
      pre = await this._preComm(VARIANTS[id], btName);
      if (pre?.frame) break;
      if (pre?.rejected) sawReject = true;
      pre = null;
    }
    if (!pre) {
      throw new ProtocolError(sawReject
        ? 'Der Roller hat den Verbindungsaufbau abgelehnt. Meist stimmt der Gerätename (Seriennummer) nicht, '
          + 'oder der Roller nutzt das neuere, nicht unterstützte Verfahren "V3Auth".'
        : 'Der Roller antwortet nicht auf den Verbindungsaufbau.', 'PRE_COMM');
    }

    const auth = pre.frame.data.slice(0, 16);
    const snBytes = pre.frame.data.slice(16, 30);
    const hasStoredPwd = pre.frame.index !== 0;
    this.crypto.setAuthParam(auth);
    this.crypto.startSn();

    let password = hasStoredPwd && storedPassword ? storedPassword : null;

    if (!password) {
      this.crypto.setKey(btName, auth);
      password = await generatePassword(auth);
      await this._send(buildFrame(this.variant, BOARD_BLE, CMD.SET_PWD, 0x00, password));
      let r = await this._recv(10000);
      if (!r.frame || r.frame.cmd !== CMD.SET_PWD) {
        throw new ProtocolError('Unerwartete Antwort beim Setzen des Passworts.', 'SET_PWD');
      }
      if (r.frame.index === 0) {
        onButtonPress();
        try {
          r = await this._recv(60000);
        } catch (e) {
          if (e.name === 'TimeoutError') {
            throw new ProtocolError('Keine Bestätigung am Roller (Power-Taste nicht gedrückt?).', 'SET_PWD');
          }
          throw e;
        }
      }
      if (!r.frame || r.frame.index !== 1) {
        throw new ProtocolError('Der Roller hat das neue Passwort abgelehnt.', 'SET_PWD');
      }
    }

    this.crypto.setKey(password, auth);
    await this._send(buildFrame(this.variant, BOARD_BLE, CMD.AUTH, 0x00, snBytes));
    const a = await this._recv(5000);
    if (!a.frame || a.frame.cmd !== CMD.AUTH || a.frame.index !== 1) {
      throw new ProtocolError('Anmeldung am Roller fehlgeschlagen.', 'AUTH');
    }

    return {
      password,
      serial: new TextDecoder().decode(snBytes).replace(/\0/g, ''),
      variant: this.variant.id,
    };
  }

  /** Read `length` bytes from register `index` of board `target`. */
  async readRegister(target, index, length = 2) {
    this.transport.flush?.();
    await this._send(buildFrame(this.variant, target, CMD.READ, index, new Uint8Array([length])));
    // Skip unrelated frames (e.g. late answers) until the matching response arrives.
    for (let i = 0; i < 5; i++) {
      const r = await this._recv(3000);
      const f = r.frame;
      if (r.ok && f && f.cmd === CMD.READ_RESP && f.index === index) {
        return f.data;
      }
    }
    throw new ProtocolError('Keine passende Antwort vom Roller.', 'READ');
  }

  /** Write without response (WRITE_NR), as the official app does for settings. */
  async writeRegisterNoResponse(target, index, data) {
    await this._send(buildFrame(this.variant, target, CMD.WRITE_NR, index, data));
  }
}
