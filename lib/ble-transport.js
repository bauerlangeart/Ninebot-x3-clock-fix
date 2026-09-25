// SPDX-License-Identifier: MIT
//
// Web Bluetooth transport for Ninebot scooters: device picker, GATT setup,
// fragmented writes and reassembly of notification fragments into frames.

export const NB_SERVICE = '6e400001-0000-0000-006e-696e65626f74';
export const NB_WRITE = '6e400002-0000-0000-006e-696e65626f74';
export const NB_NOTIFY = '6e400004-0000-0000-006e-696e65626f74';

export const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const GENERIC_ACCESS = 0x1800;
const DEVICE_NAME = 0x2a00;

// Web Bluetooth writes are limited to MTU - 3 bytes; the browser does not
// expose the negotiated MTU, so stay at the BLE 4.0 minimum.
const CHUNK = 20;

function timeoutError() {
  const e = new Error('Zeitüberschreitung');
  e.name = 'TimeoutError';
  return e;
}

export function isSupported() {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/**
 * Splits the notification byte stream into complete encrypted frames
 * (sync 5A A5/B5, LEN, LEN + 13 bytes in total). Exported for tests.
 */
export class FrameAssembler {
  constructor(onFrame) {
    this.buf = new Uint8Array(0);
    this.onFrame = onFrame;
  }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    for (;;) {
      let start = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 0x5a && (this.buf[i + 1] === 0xa5 || this.buf[i + 1] === 0xb5)) { start = i; break; }
      }
      if (start < 0) {
        this.buf = this.buf.length && this.buf[this.buf.length - 1] === 0x5a ? this.buf.slice(-1) : new Uint8Array(0);
        return;
      }
      this.buf = this.buf.slice(start);
      if (this.buf.length < 3) return;
      const total = this.buf[2] + 13;
      if (this.buf.length < total) return;
      this.onFrame(this.buf.slice(0, total));
      this.buf = this.buf.slice(total);
    }
  }

  reset() { this.buf = new Uint8Array(0); }
}

export class BleTransport {
  constructor() {
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.queue = [];
    this.waiters = [];
    this.assembler = new FrameAssembler((f) => this._deliver(f));
    this.onDisconnect = () => {};
  }

  /** Opens the browser's device picker. Must be called from a click handler. */
  async requestDevice() {
    this.device = await navigator.bluetooth.requestDevice({
      // Scooters do not always advertise their service UUID, so we cannot
      // filter on it; the user picks the scooter by name.
      acceptAllDevices: true,
      optionalServices: [NB_SERVICE, NORDIC_SERVICE, GENERIC_ACCESS],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect());
    return this.device;
  }

  async connect() {
    const server = await this.device.gatt.connect();

    let service;
    let writeUuid;
    let notifyUuid;
    try {
      service = await server.getPrimaryService(NB_SERVICE);
      writeUuid = NB_WRITE;
      notifyUuid = NB_NOTIFY;
    } catch {
      try {
        service = await server.getPrimaryService(NORDIC_SERVICE);
        writeUuid = NORDIC_WRITE;
        notifyUuid = NORDIC_NOTIFY;
      } catch {
        throw new Error('Auf dem Gerät wurde kein Ninebot-Bluetooth-Dienst gefunden. Ist das der Roller?');
      }
    }
    this.serviceUuid = service.uuid;
    this.writeChar = await service.getCharacteristic(writeUuid);
    this.notifyChar = await service.getCharacteristic(notifyUuid);
    this.notifyChar.addEventListener('characteristicvaluechanged', (ev) => {
      const v = ev.target.value;
      this.assembler.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    await this.notifyChar.startNotifications();
    return server;
  }

  /**
   * The name is the encryption key. The advertised name can be cut off, so
   * prefer the GATT Device Name characteristic when the browser allows it.
   */
  async readDeviceName() {
    try {
      const ga = await this.device.gatt.getPrimaryService(GENERIC_ACCESS);
      const ch = await ga.getCharacteristic(DEVICE_NAME);
      const v = await ch.readValue();
      const name = new TextDecoder().decode(v).replace(/\0/g, '').trim();
      if (name) return name;
    } catch {
      // Not readable in this browser; fall back to the advertised name.
    }
    return (this.device.name || '').trim();
  }

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  get connected() { return !!this.device?.gatt?.connected; }

  async send(bytes) {
    for (let o = 0; o < bytes.length; o += CHUNK) {
      const chunk = bytes.slice(o, o + CHUNK);
      if (this.writeChar.properties.writeWithoutResponse) await this.writeChar.writeValueWithoutResponse(chunk);
      else await this.writeChar.writeValueWithResponse(chunk);
      if (o + CHUNK < bytes.length) await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Drops frames that arrived but were never asked for. */
  flush() {
    this.queue = [];
    this.assembler.reset();
  }

  _deliver(frame) {
    const w = this.waiters.shift();
    if (w) w.resolve(frame);
    else this.queue.push(frame);
  }

  recv(timeoutMs = 5000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const w = {
        resolve: (f) => { clearTimeout(t); resolve(f); },
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(timeoutError());
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
}
