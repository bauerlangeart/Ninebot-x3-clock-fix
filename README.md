# G3D Uhr-Fix

Stellt die Zeitzone am Dashboard des **Ninebot Max G3 / G3D** per Bluetooth ein –
ohne die offizielle Segway-App. Gedacht für Roller, die nie mit der offiziellen
App gekoppelt wurden (z. B. nur über SHU) und deshalb noch mit der werksseitigen
China-Zeitzone (UTC+8) laufen: Die Uhr geht dann in Deutschland 6 Stunden (Sommer)
bzw. 7 Stunden (Winter) vor.

**Direkt benutzen:** <https://bauerlangeart.github.io/ninebot-x3-clock-fix/>
(in Chrome oder Edge öffnen)

> **Status:** Die Software ist fertig und gegen den Python-Referenzclient sowie einen
> simulierten Roller getestet. **Am echten Roller ist sie noch nicht erprobt.**
> Das Format des Zeitzonen-Registers ist nicht öffentlich dokumentiert. Die Seite
> ermittelt es beim Auslesen und schreibt nur, wenn es eindeutig erkannt wurde.

## Benutzung

1. Seite in **Chrome oder Edge** öffnen (Android oder Computer).
   Safari, Firefox und iPhone-Browser unterstützen kein Web Bluetooth.
2. SHU und andere Roller-Apps schließen, Roller einschalten.
3. **Verbinden** → Roller auswählen. Beim ersten Mal fragt der Roller nach einer
   Bestätigung: kurz die **Power-Taste** drücken.
4. Eintragen, um wie viele Stunden die Uhr vorgeht (Standard 6), dann
   **Zeitzone auslesen**. Dabei wird nichts verändert.
5. Wurde das Format erkannt: **Auf Deutschland setzen** → bestätigen.
6. Roller aus- und einschalten, Uhr prüfen.

Nach dem ersten Öffnen funktioniert die Seite auch **offline**. Über „Zum
Startbildschirm hinzufügen“ lässt sie sich wie eine App installieren (PWA).

Falls SHU sich danach nicht mehr verbindet: SHU einfach neu koppeln.

## Sicherheit

- Geschrieben wird ausschließlich Register `0x86` (Zeitzone) auf dem Dashboard-Board,
  und nur nach einem erfolgreichen Lesen mit eindeutig erkanntem Format.
- Vor dem Schreiben kommt ein Bestätigungsdialog. Danach wird der Wert zur Kontrolle
  zurückgelesen. Der alte Wert steht im Protokoll.
- Keine Server, keine Tracker, keine externen Bibliotheken – nur Web Bluetooth und
  Web Crypto des Browsers. Das Kopplungs-Passwort bleibt lokal im Browser
  (`localStorage`) und erscheint nicht im Protokoll.

## Protokoll (für Entwickler, z. B. zur Übernahme in andere Apps)

Die Kommunikation läuft über das Ninebot-Protokoll „Encryption2“ (AES-128, CCM-artig).
Vollständige Doku: <https://nootnooot.codeberg.page/segway-ninebot-ble/>.

**GATT**

| Rolle  | UUID |
|--------|------|
| Service | `6e400001-0000-0000-006e-696e65626f74` (Fallback Nordic UART `6e400001-b5a3-f393-e0a9-e50e24dcca9e`) |
| Write  | `6e400002-…` |
| Notify | `6e400004-…` (Nordic: `6e400003-…`) |

Schreibvorgänge in Stücken zu höchstens 20 Bytes. Antworten kommen fragmentiert
und werden über Sync-Bytes und Längenfeld zusammengesetzt.

**Handshake** (Ziel-Board BLE `0x04`): `PRE_COMM 0x5B` → `SET_PWD 0x5C` (nur bei
neuer Kopplung, Roller verlangt Tastendruck) → `AUTH 0x5D`. Schlüssel ist anfangs
der Bluetooth-Name (= Seriennummer). Details in `lib/nb-protocol.js`.

**Zeitzone**

| Feld | Wert |
|------|------|
| Board | Doku: DIS `0x01`. Beim Max G3 heißt das Dashboard laut Board-Map der App `tft` = **`0x23`**; es gibt dort kein Board `0x01`. Die Seite probiert `0x23`, dann `0x01`. |
| Register | `0x86` (134), 2 Bytes, Little Endian |
| Lesen | `5A A5 01 3E <board> 01 86 02` (Klartext vor Verschlüsselung) |
| Schreiben | `5A A5 02 3E <board> 03 86 <lo> <hi>` (`WRITE_NR`, wie die offizielle App bei Einstellungen) |
| Kodierung | **noch zu bestätigen** – siehe unten |

Kandidaten für die Kodierung (UTC+8 → Deutschland Sommer / Winter):
Stunden `8 → 2 / 1`, Minuten `480 → 120 / 60`, Viertelstunden `32 → 8 / 4`,
halbe Stunden `16 → 4 / 2`, Stunden+12 `20 → 14 / 13`, Sekunden `28800 → 7200 / 3600`.

<!-- Nach dem ersten erfolgreichen Test am echten Roller hier das bestätigte
     Board, die Kodierung und ein Beispiel-Log eintragen. -->

## Entwicklung

```bash
npm test          # Krypto gegen Testvektoren des Python-Referenzclients + simulierter Handshake
npm run serve     # lokal unter http://localhost:8000 (Web Bluetooth erlaubt localhost)
```

| Datei | Inhalt |
|-------|--------|
| `index.html`, `style.css`, `app.js` | Oberfläche |
| `lib/nb-crypto.js` | AES-Schlüsselableitung, CTR + CBC-MAC, Passwortgenerierung |
| `lib/nb-protocol.js` | Frames, Handshake, Register lesen/schreiben (unabhängig von Web Bluetooth) |
| `lib/ble-transport.js` | Web Bluetooth: Geräteauswahl, Fragmentierung, Zusammensetzen der Antworten |
| `lib/timezone.js` | Erkennung der Register-Kodierung |
| `sw.js`, `manifest.webmanifest` | Offline-Nutzung / Installation |

Für das Hosting reicht ein beliebiger statischer HTTPS-Webspace, z. B. GitHub Pages
(Branch, Ordner `/`). Web Bluetooth funktioniert nur über HTTPS oder `localhost`.

## Lizenz

MIT (siehe `LICENSE`) – mit Ausnahme von `lib/nb-crypto.js` und `lib/nb-protocol.js`.
Diese sind aus dem Apache-2.0-lizenzierten
[segway-ninebot-ble-cli](https://codeberg.org/NootNooot/segway-ninebot-ble-cli)
portiert und stehen weiter unter Apache 2.0 (siehe `LICENSE-APACHE` und `NOTICE`).

Inoffizielles Projekt, nicht verbunden mit Segway-Ninebot. Nur am eigenen Gerät
benutzen.
