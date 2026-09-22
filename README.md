# AutoSecureCloud

AutoSecureCloud ist eine lokale Web-App zum Aufnehmen und sichtbaren Ausführen von Playwright-Automationen. Jeder automatische Schritt läuft in einem geöffneten Chromium-Fenster; Ziel, Klick und Fortschritt werden direkt auf der Zielseite eingeblendet.

## Installation und Start

Voraussetzungen: macOS, Node.js 22 oder neuer und npm.

```bash
npm install
npm run setup
npm run dev
```

Die Entwicklungsoberfläche ist anschließend unter `http://127.0.0.1:5173` erreichbar. Für den lokalen Produktionsbetrieb:

```bash
npm run build
npm start
```

Dann läuft die vollständige Anwendung unter `http://127.0.0.1:4310`.

## Erster Ablauf

1. Unter **Geräte** ein Gerät mit seiner Start-URL anlegen.
2. Optional ein Zugangsdatenprofil anlegen und dem Gerät zuweisen.
3. Unter **Pipelines** eine Pipeline erstellen und **Aufnehmen** wählen.
4. Unter **Datentabelle** die benötigten Spalten anlegen. Jede Spalte ist gleichzeitig eine Pipeline-Variable, zum Beispiel `{{data.seriennummer}}`.
5. Die Webseite im geöffneten Chromium-Fenster bedienen. Mit **Text erfassen** wird der nächste angeklickte Text einer Tabellenspalte zugeordnet.
6. Eingaben im Pipeline-Editor auf feste Werte, Tabellenfelder, Zugangsdaten oder frühere Ergebnisse umstellen.
7. Über **Ausführen** ein oder mehrere Geräte wählen und den sichtbaren Lauf starten.

Zum gefahrlosen Ausprobieren stehen die lokalen Testseiten `http://127.0.0.1:4310/fixture/firewall` und `/fixture/portal` bereit.

Die Datentabelle lässt sich wie ein kleines Spreadsheet bedienen: Zellen werden direkt bearbeitet, `Tab` wechselt zur nächsten Zelle, `Enter` zur nächsten Zeile und aus Excel kopierte Zellbereiche können auf einmal eingefügt werden. Über die Variablenauswahl oberhalb der Tabelle lässt sich der Schlüssel einer Spalte direkt kopieren.

## Daten und Sicherheit

Die produktiven Daten liegen unter `~/.autosecurecloud/`. Mit `ASC_DATA_DIR=/anderer/pfad` lässt sich der Speicherort ändern. Der Server bindet nur an `127.0.0.1`.

Wie für Version 1 festgelegt, werden Passwörter unverschlüsselt in der lokalen SQLite-Datei gespeichert. Die Oberfläche und Laufprotokolle zeigen sie nicht an. Die Datenbank sollte nicht geteilt oder in eine ungeschützte Cloud-Synchronisation gelegt werden.

## Qualitätssicherung

```bash
npm test
npm run typecheck
npm run build
```

## Lizenz

Dieses Projekt ist mit [The Unlicense](LICENSE) vollständig zur freien Verwendung freigegeben. Der Code darf ohne Einschränkungen kopiert, verändert, veröffentlicht, verteilt, unterlizenziert, verkauft und für private oder kommerzielle Zwecke eingesetzt werden.
