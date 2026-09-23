# AutoSecureCloud

AutoSecureCloud ist eine lokale Web-App zum Aufnehmen und sichtbaren Ausführen von Playwright-Automationen. Jeder automatische Schritt läuft in einem geöffneten Chromium-Fenster; Ziel, Klick und Fortschritt werden direkt auf der Zielseite eingeblendet.

## Installation und Start

Voraussetzungen: macOS, Node.js 22 oder neuer und npm.

```bash
npm install
npm run setup
npm run dev
```

Die Entwicklungsoberfläche ist anschließend unter `http://127.0.0.1:5173` erreichbar. Für den Zugriff von anderen Geräten im vertrauenswürdigen lokalen Netz den Server stattdessen mit `npm run dev:lan` starten und die lokale IPv4-Adresse des Rechners verwenden, zum Beispiel `http://192.168.2.176:5173`. Bei einer Änderung der Rechner-IP den Entwicklungsserver neu starten. Für den lokalen Produktionsbetrieb:

```bash
npm run build
npm start
```

Dann läuft die vollständige Anwendung unter `http://127.0.0.1:4310`.

### Manuell bereitgestelltes Chromium unter Linux

Wenn Chromium bereits manuell auf den Rechner kopiert wurde, kann AutoSecureCloud diese ausführbare Datei anstelle des von Playwright heruntergeladenen Browsers verwenden. Der Pfad muss auf die Datei `chrome` zeigen, nicht nur auf den Ordner `chrome-linux64`:

```bash
npm install
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/home/benutzer/chrome-linux64/chrome
npm run setup:external-browser
npm run dev:lan
```

Die Variable muss auch beim späteren Start gesetzt sein. Für einen Produktionsstart gilt entsprechend:

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/home/benutzer/chrome-linux64/chrome
npm start
```

Die Datei muss für den Benutzer, unter dem AutoSecureCloud läuft, ausführbar sein. Falls nötig: `chmod +x /home/benutzer/chrome-linux64/chrome`. Da Aufnahmen und Abläufe ein sichtbares Browserfenster öffnen, braucht der Prozess außerdem Zugriff auf eine grafische Linux-Sitzung, beispielsweise über die gesetzte Variable `DISPLAY`.

Verlangt die Startseite bereits vor dem Laden eine HTTP-Anmeldung, muss dem Gerät in AutoSecureCloud ein Zugangsdatenprofil zugewiesen sein. Dieses Profil wird für HTTP Basic/Digest nur an den exakten Ursprung der Start-URL übermittelt. Bei `ERR_INVALID_AUTH_CREDENTIALS` Benutzername und Passwort prüfen; in WSL kann außerdem ein Authentifizierungs-Proxy die Ursache sein.

## Erster Ablauf

1. Unter **Inventar** ein Zielgerät oder ein Portal mit seiner Start-URL anlegen.
2. Optional ein Zugangsdatenprofil anlegen und dem Gerät zuweisen. Für mehrere Geräte im Inventar die Checkboxen auswählen und **Zugangsdaten zuweisen** nutzen; alle verwenden dann dasselbe Profil.
3. Unter **Automationen** einen wiederverwendbaren Ablauf erstellen und **Im Browser aufnehmen** wählen.
4. Unter **Daten** die benötigten Spalten anlegen. Jede Spalte ist gleichzeitig eine Automationsvariable, zum Beispiel `{{data.seriennummer}}`.
5. Die Webseite im geöffneten Chromium-Fenster bedienen. Mit **Text erfassen** wird der nächste angeklickte Text einer Tabellenspalte zugeordnet.
6. Eingaben im Automationseditor auf feste Werte, Tabellenfelder, Zugangsdaten oder frühere Ergebnisse umstellen.
7. Im **Inventar** ein Gerät auswählen, die Automationen in die gewünschte Reihenfolge bringen und den kompletten sichtbaren Ablauf direkt aus der Liste oder dem Gerätedetail starten. Zugangsdaten und Gerätebearbeitung sind ebenfalls dort erreichbar. Portalquellen haben stattdessen die Aktion **Geräte synchronisieren**.

## Ablaufvorlagen für Gerätegruppen

Geräte mit demselben Standardablauf müssen nicht einzeln konfiguriert werden. Stelle die Automationen bei einem Gerät einmal in der richtigen Reihenfolge zusammen und wähle **Als Vorlage speichern**. Die Vorlage kann danach beim einzelnen Gerät über **Vorlage übernehmen** oder nach Mehrfachauswahl im Inventar über **Vorlage zuweisen** gleichzeitig mehreren Zielgeräten zugewiesen werden. Beim Zuweisen ersetzt die Vorlage die bisherige Automationsreihenfolge vollständig. Über **Automation hinzufügen** lässt sich eine einzelne Automation mehreren ausgewählten Geräten hinzufügen, ohne deren vorhandene Reihenfolge zu ersetzen.

## ATV-Dateien zusammenführen

Downloads werden unter ihrem Variablennamen als Dateireferenz in der Tabellenzeile des jeweiligen Geräts gespeichert. Für jede Dateivariable gibt es eine Spalte vom Typ **Datei**; sie wird beim ersten Download automatisch angelegt. Im Automationstudio wählt **ATV-Merger** die Dateivariablen für A und B aus und schreibt das Ergebnis in eine weitere Dateivariable derselben Gerätezeile. Der Dateiname des Ergebnisses wird separat festgelegt. Ein späterer Upload-Schritt kann die Ergebnisvariable auswählen. Lokale Dateipfade bleiben als Alternative möglich. Bereits vorhandene Downloads werden beim ersten Start in Dateivariablen übernommen, soweit ihre Schlüssel nicht mit Textspalten kollidieren.

Der Merge ist vorläufig: Datei A bildet die Basis; gleichnamige Hauptabschnitte werden vollständig durch Datei B ersetzt, zusätzliche Abschnitte angefügt. Es findet noch kein gerätespezifischer Abgleich innerhalb verschachtelter Abschnitte statt. Prüfe die erzeugte ATV-Datei vor dem Einspielen. Die austauschbare Merge-Funktion liegt in `apps/server/src/atv-merge.ts`.

Zum gefahrlosen Ausprobieren stehen die lokalen Testseiten `http://127.0.0.1:4310/fixture/firewall` und `/fixture/portal` bereit.

Die Datentabelle lässt sich wie ein kleines Spreadsheet bedienen: Zellen werden direkt bearbeitet, `Tab` wechselt zur nächsten Zelle, `Enter` zur nächsten Zeile und aus Excel kopierte Zellbereiche können auf einmal eingefügt werden. Über die Variablenauswahl oberhalb der Tabelle lässt sich der Schlüssel einer Spalte direkt kopieren.

## Verschachtelte Gerätesuche

Mit dem Automationsschritt **Geräte finden** lassen sich Karten- und Listenstrukturen sequenziell abarbeiten. Mehrere äußere Ebenen können beispielsweise Standorte und Hallen abbilden; innerhalb der letzten Ebene werden alle Maschinenkarten geöffnet und konfigurierte Werte gelesen.

- Das Portal wird direkt im Suchschritt als **Quellgerät** festgelegt. Beim Start zeigt die App nur diese Quelle an und fragt nicht nach Zielgeräten.
- Nur aktuell sichtbare Bereiche, Karten und Dialogelemente werden verarbeitet; unsichtbare Duplikate im DOM werden ignoriert.
- Einträge ohne Adresse werden übersprungen und im Laufprotokoll begründet.
- Gleiche Start-URLs werden zusammengeführt; wahlweise gewinnt der erste oder letzte Fund.
- Im Vorschaumodus wird nichts gespeichert. Mit aktivierter Übernahme entstehen Geräte und dynamische Tabellenspalten.
- Die lokale Seite `/fixture/discovery` simuliert zwei Standorte, sieben Maschinen, eine fehlende IP und eine doppelte IP.

Aufgenommene Ziele können im Schritteditor nachträglich Variablen enthalten. So wird aus einem Klick auf eine konkrete Maschinenkarte beispielsweise `{{device.name}}`; für eine Standortkarte kann `{{data.bereich}}` verwendet werden. Über **Kopieren** lässt sich anschließend aus einer vorhandenen Automation etwa ein eigener Baustein für „VPN starten“ oder „VPN-Datei herunterladen“ erstellen.

## Daten und Sicherheit

Die produktiven Daten liegen unter `~/.autosecurecloud/`. Mit `ASC_DATA_DIR=/anderer/pfad` lässt sich der Speicherort ändern. Die API bindet weiterhin nur an `127.0.0.1`; im optionalen LAN-Modus leitet Vite Anfragen von der lokalen IPv4-Adresse an sie weiter. Damit ist die Anwendung samt Zugangsdaten und Backups ohne Anmeldung für andere Geräte im selben Netz erreichbar. `dev:lan` nur in einem vertrauenswürdigen Netz starten; für entfernten Zugriff ist eine abgesicherte Verbindung mit Anmeldung erforderlich.

Wie für Version 1 festgelegt, werden Passwörter unverschlüsselt in der lokalen SQLite-Datei gespeichert. Die Oberfläche und Laufprotokolle zeigen sie nicht an. Die Datenbank sollte nicht geteilt oder in eine ungeschützte Cloud-Synchronisation gelegt werden.

Unter **Einstellungen → Daten und Backup** können automatische vollständige Backups täglich oder wöchentlich aktiviert werden. Die erste Sicherung entsteht direkt beim Einschalten; danach prüft der laufende Server den Zeitplan jede Minute und holt fällige Sicherungen nach einem Neustart nach. Während einer Aufnahme oder eines Geräteablaufs wartet er bis zum nächsten freien Zeitpunkt. Die Dateien liegen unter `~/.autosecurecloud/backups/` beziehungsweise unter `ASC_DATA_DIR/backups/`, können in der Oberfläche heruntergeladen oder wiederhergestellt werden und werden nach der gewählten Anzahl automatisch ausgedünnt. Diese lokalen Kopien schützen nicht vor dem Verlust des gesamten Rechners oder Datenträgers.

Über **Arbeitsbereich löschen** kann der aktuelle Datenbestand vollständig zurückgesetzt werden. Gespeicherte automatische Backups bleiben im Backup-Ordner und sind danach weiter auswählbar. Der Reset schaltet automatische Backups aus, damit die erhaltenen Sicherungen nicht durch neue ersetzt werden.

## Qualitätssicherung

```bash
npm test
npm run typecheck
npm run build
```

## Lizenz

Dieses Projekt ist mit [The Unlicense](LICENSE) vollständig zur freien Verwendung freigegeben. Der Code darf ohne Einschränkungen kopiert, verändert, veröffentlicht, verteilt, unterlizenziert, verkauft und für private oder kommerzielle Zwecke eingesetzt werden.
