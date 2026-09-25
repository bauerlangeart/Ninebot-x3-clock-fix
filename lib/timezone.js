// SPDX-License-Identifier: MIT
//
// Timezone register helpers. The public protocol docs only say "Timezone
// setting, 2 bytes, read/write" - the value format is not documented. We
// therefore derive it from what we know: the value read from the scooter and
// how far its clock is off compared to the phone.

/** Candidate encodings: UTC offset in minutes -> raw register number. */
export const ENCODINGS = [
  { id: 'hours', label: 'Stunden (UTC+8 = 8)', fromMinutes: (m) => m / 60 },
  { id: 'minutes', label: 'Minuten (UTC+8 = 480)', fromMinutes: (m) => m },
  { id: 'quarter-hours', label: 'Viertelstunden (UTC+8 = 32)', fromMinutes: (m) => m / 15 },
  { id: 'half-hours', label: 'halbe Stunden (UTC+8 = 16)', fromMinutes: (m) => m / 30 },
  { id: 'hours-plus-12', label: 'Stunden + 12 (UTC+8 = 20)', fromMinutes: (m) => m / 60 + 12 },
  { id: 'seconds', label: 'Sekunden (UTC+8 = 28800)', fromMinutes: (m) => m * 60 },
];

/** Raw 2 register bytes -> unsigned and signed little-endian numbers. */
export function decodeRaw(bytes) {
  const u16 = bytes[0] | (bytes[1] << 8);
  return { u16, i16: u16 >= 0x8000 ? u16 - 0x10000 : u16 };
}

/** Number -> 2 register bytes (little-endian, two's complement for negatives). */
export function encodeRaw(value) {
  if (!Number.isInteger(value) || value < -0x8000 || value > 0xffff) {
    throw new RangeError(`Wert ${value} passt nicht in 2 Bytes`);
  }
  const u = value & 0xffff;
  return new Uint8Array([u & 0xff, u >> 8]);
}

/** Current UTC offset of a time zone in minutes (e.g. Europe/Berlin: 120 in summer). */
export function utcOffsetMinutes(timeZone = 'Europe/Berlin', date = new Date()) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // "GMT+02:00" or "GMT"
  const m = part.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

/**
 * Figure out the encoding.
 * @param bytes          the 2 bytes read from the register
 * @param shiftHours     how many hours the dashboard clock is ahead (negative: behind)
 * @param targetMinutes  desired UTC offset in minutes (e.g. 120 for CEST)
 * @returns list of matching encodings with the value to write; exactly one
 *          match means the encoding is unambiguous.
 */
export function analyse(bytes, shiftHours, targetMinutes) {
  const { u16, i16 } = decodeRaw(bytes);
  const deviceMinutes = targetMinutes + shiftHours * 60;
  const matches = [];
  for (const enc of ENCODINGS) {
    const expected = enc.fromMinutes(deviceMinutes);
    if (!Number.isInteger(expected)) continue;
    if (expected === i16 || expected === u16) {
      const target = enc.fromMinutes(targetMinutes);
      if (Number.isInteger(target)) matches.push({ ...enc, current: expected, target });
    }
  }
  return { u16, i16, deviceMinutes, matches };
}
