# G3D Uhr-Fix

Web-App (PWA), die per **Web Bluetooth** mit einem **Ninebot Max G3 / G3D** spricht –
ohne die offizielle Segway-App. Ziel ist es, die Uhr am Dashboard zu korrigieren:
Roller, die nie mit der offiziellen App gekoppelt wurden (z. B. nur mit SHU), laufen
mit der werksseitigen China-Zeit (UTC+8). Die Uhr geht in Deutschland dann 6 Stunden
(Sommer) bzw. 7 Stunden (Winter) vor, dazu kommt eine kleine Gangabweichung von
einigen Minuten.

**Direkt benutzen:** <https://bauerlangeart.github.io/Ninebot-x3-clock-fix/>
(in Chrome oder Edge öffnen)

> **Status (Oktober 2026)**
>
> - ✅ Verbinden, Koppeln und verschlüsselte Kommunikation mit dem Max G3 funktionieren
>   am echten Roller.
> - ✅ Alle per Bluetooth erreichbaren Steuergeräte lassen sich auslesen (nur lesend).
> - ❌ **Die Uhr lässt sich noch nicht stellen.** Auf keinem erreichbaren Board liegt
>   eine Zeitzone oder eine laufende Uhrzeit; das Dashboard selbst antwortet nicht.
>   Der Befehl, mit dem die offizielle App die Uhr stellt, ist unbekannt –
>   siehe [Mithelfen](#mithelfen).
>
> Am Roller wurde bei allen Tests nichts verändert.

## Benutzung

1. Seite in **Chrome oder Edge** öffnen (Android oder Computer). Safari, Firefox und
   iPhone-Browser unterstützen kein Web Bluetooth.
2. SHU und andere Roller-Apps schließen, Roller einschalten.
3. **Verbinden** → Roller auswählen. Beim ersten Mal erscheint „Power-Taste drücken“:
   kurz die Power-Taste am Roller drücken. Die Kopplung wird im Browser gespeichert,
   danach ist kein Tastendruck mehr nötig.
4. Diagnose-Werkzeuge unter „Protokoll für die Fehlersuche“:
   - **Testlesen** – liest die Seriennummer.
   - **Board-Suche + Scan** – sucht alle antwortenden Steuergeräte und liest deren
     Register (nur lesend). Das Protokoll lässt sich kopieren.

Eine neue Kopplung ersetzt die vorherige im Roller: Danach muss SHU neu gekoppelt
werden (und umgekehrt).

Nach dem ersten Öffnen funktioniert die Seite **offline** und lässt sich über
„Zum Startbildschirm hinzufügen“ wie eine App installieren.

## Sicherheit

- Geschrieben wird nur das Zeitzonen-Register, und nur nach einem erfolgreichen Lesen
  mit eindeutig erkanntem Format, Bestätigungsdialog und Kontroll-Lesen. Da beim G3
  kein solches Register gefunden wurde, schreibt die Seite derzeit nichts.
- Keine Server, keine Tracker, keine externen Bibliotheken – nur Web Bluetooth und
  Web Crypto des Browsers. Das Kopplungs-Passwort bleibt lokal im Browser
  (`localStorage`) und erscheint nicht im Protokoll.
- Das Protokoll enthält die Seriennummer des Rollers – nicht öffentlich posten.

## Protokoll am Max G3

Grundlage ist das Ninebot-Protokoll „Encryption2“ (AES-128, CTR + CBC-MAC).
Allgemeine Doku: <https://nootnooot.codeberg.page/segway-ninebot-ble/>.
Die folgenden Punkte weichen davon ab bzw. sind dort nicht beschrieben und wurden am
Max G3 (BLE 0.4.5, VCU mit SHU-tauglicher Firmware) ermittelt:

**Transport**

| Punkt | Max G3 |
|-------|--------|
| GATT-Dienste | Ninebot (`6e400001-0000-0000-006e-696e65626f74`) **und** Nordic UART (`6e400001-b5a3-f393-e0a9-e50e24dcca9e`) |
| Antwortet über | **nur Nordic UART**: Write `6e400002-b5a3-…`, Notify `6e400003-b5a3-…` |
| Schreiben | jeder Frame **am Stück** (Chrome handelt die MTU aus). In 20-Byte-Stücke zerlegte Frames werden ignoriert. |

**Handshake** (Ziel-Board BLE `0x04`)

1. `PRE_COMM 0x5B`, Variante „gen2“: Sync `5A A5`, Schlüssel SHA-1(Name ‖ FW_DATA),
   Nicht-SN-Modus. Antwort-Index `1` = Roller hat bereits eine Kopplung gespeichert.
2. `SET_PWD 0x5C` (nur bei neuer Kopplung): erster SN-Frame mit **Zähler 3**,
   alle **0,5 s** wiederholen, bis `index 0` (wartet auf Tastendruck) kommt; nach dem
   Druck auf die Power-Taste folgt `index 1`.
3. `AUTH 0x5D` mit Seriennummer. Beim Wiederverbinden mit gespeichertem Passwort ist
   AUTH der erste SN-Frame (Zähler 2).

Ermittelt wurde das u. a. durch einen Bluetooth-Mitschnitt einer Kopplung durch SHU;
die Krypto in `lib/nb-crypto.js` entschlüsselt diesen Mitschnitt fehlerfrei.

**Erreichbare Boards** (Board-Suche über alle 256 Adressen, Lesen von Register `0x10`)

| Board | Funktion | Bemerkung |
|-------|----------|-----------|
| `0x16` | VCU (Steuergerät) | Seriennummer `0x10–0x16`, Firmware VCU `0x17` / MCU `0x18` / BMS `0x19`, Kilometer `0x64–0x65`, Fahrzeit `0xFA–0xFB` |
| `0x00` | Spiegel der VCU | identische Werte |
| `0x02` | MCU (Motor-Controller) | |
| `0x04` | BLE-Modul | Gerätename, Kopplungsdaten |
| `0x07` | BMS (Akku) | Zellspannungen `0x9F–0xAC`, Temperaturen `0x95–0x9C` |
| `0x23` (Dashboard laut App-Konfiguration) | – | **antwortet nicht** |

Register sind 16-Bit-Werte, Little Endian. Lesen: `5A A5 01 3E <board> 01 <reg> <len>`
(Klartext vor der Verschlüsselung).

**Uhr / Zeitzone**

- Die allgemeine Doku nennt „Timezone“ als DIS `0x01`, Register `0x86` – das gilt für
  die E-Serie (Mopeds). Beim G3 gibt es kein Board `0x01`; VCU `0x86` enthält `0`.
- Zwei vollständige Scans im Abstand von zwei Tagen zeigen auf keinem Board einen
  Zeitzonen-Wert oder eine mitlaufende Uhrzeit (weder Unix-Zeitstempel noch Felder).
- Vermutung: Die Uhr sitzt im Dashboard und wird von der offiziellen App mit einem
  eigenen Befehl über die VCU gestellt.

## Mithelfen

Gesucht ist der Befehl, mit dem die **offizielle Segway-App** die Uhr stellt. Am
einfachsten über einen Bluetooth-Mitschnitt (Android: Entwickleroptionen →
„Bluetooth-HCI-Snoop-Protokoll“ auf „Aktiviert“):

- Roller: **Max G3, F3 oder GT3** (laut App-Konfiguration gleicher Board-Aufbau und
  Befehlssatz), notfalls ZT3 Pro – mit **Originalfirmware**, Dashboard mit Uhr.
- Der Mitschnitt muss eine **Neukopplung** (mit Druck auf die Power-Taste) enthalten,
  sonst lässt er sich nicht entschlüsseln; danach ca. 30 s verbunden bleiben.
- BLE- und VCU-Firmware-Version angeben. Sehr neue Firmware mit „V3Auth“ wird nicht
  unterstützt.

Mitschnitte enthalten Kopplungsdaten des jeweiligen Rollers – bitte nicht öffentlich
hochladen, sondern über ein Issue Kontakt aufnehmen.

## Entwicklung

```bash
npm test          # Krypto gegen Testvektoren des Python-Referenzclients + simulierter Roller
npm run serve     # lokal unter http://localhost:8000 (Web Bluetooth erlaubt localhost)
```

| Datei | Inhalt |
|-------|--------|
| `index.html`, `style.css`, `app.js` | Oberfläche, Diagnose, Board-Suche und Register-Scan |
| `lib/nb-crypto.js` | Schlüsselableitung, AES-CTR + CBC-MAC, Passwortgenerierung (Web Crypto) |
| `lib/nb-protocol.js` | Frames, Handshake (inkl. G3-Ablauf), Register lesen/schreiben – unabhängig von Web Bluetooth |
| `lib/ble-transport.js` | Web Bluetooth: beide GATT-Dienste, Senden am Stück, Zusammensetzen der Antworten |
| `lib/timezone.js` | Erkennung möglicher Kodierungen eines Zeitzonen-Werts |
| `test/` | Testvektoren (fiktive Seriennummer) und Tests |
| `sw.js`, `manifest.webmanifest` | Offline-Nutzung / Installation |

`lib/nb-protocol.js` erwartet nur ein Objekt mit `send(bytes)` und
`recv(timeoutMs)`; der Protokoll-Kern lässt sich so auch in anderen Umgebungen
nutzen oder in andere Sprachen übertragen.

Hosting: beliebiger statischer HTTPS-Webspace, z. B. GitHub Pages (Branch `main`,
Ordner `/`). Nach Änderungen `APP_VERSION` in `app.js` und `VERSION` in `sw.js`
erhöhen.

## English summary

Web Bluetooth PWA for the Segway-Ninebot Max G3 (Encryption2 protocol). Pairing and
encrypted communication work on a real G3; findings beyond the public docs: the G3
only answers on the **Nordic UART** service, frames must be written **unfragmented**,
SET_PWD starts at **SN counter 3** and is repeated every 0.5 s until index 0 (waiting
for the power button). Reachable boards: `0x00`/`0x16` (VCU), `0x02` (MCU), `0x04`
(BLE), `0x07` (BMS); the dashboard (`0x23`) does not answer. No timezone or clock
value was found, so **setting the clock is not possible yet**. Wanted: a Bluetooth
capture of the official app pairing a stock G3/F3/GT3.

## Lizenz

MIT (siehe `LICENSE`) – mit Ausnahme von `lib/nb-crypto.js` und `lib/nb-protocol.js`.
Diese sind aus dem Apache-2.0-lizenzierten
[segway-ninebot-ble-cli](https://codeberg.org/NootNooot/segway-ninebot-ble-cli)
portiert und stehen weiter unter Apache 2.0 (siehe `LICENSE-APACHE` und `NOTICE`).

Inoffizielles Projekt, nicht verbunden mit Segway-Ninebot. Nur am eigenen Gerät
benutzen.
