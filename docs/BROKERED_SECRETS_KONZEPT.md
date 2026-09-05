# Verity — Brokered Secrets (Konzept)

**Status:** Überarbeiteter Entwurf, 2026-07-17
**Geltungsbereich:** Agent-Sandboxes, CLI-Tool-Calls, Doppler-Anbindung und serverseitige
Credential-Vermittlung

**Verbindliche Entscheidung:**
[ADR 0009](adr/0009-brokered-secrets-and-secret-job-executor.md)
**Umsetzungsplanung:** Phase-0-Plan
(`docs/BROKERED_SECRETS_PHASE_0_PLAN.md`, nicht im öffentlichen Snapshot)
**Sicherheitsmodell:** [Threat Model](BROKERED_SECRETS_THREAT_MODEL.md)
**W3/W4-Verträge:** Daten- und Protokollentwurf
(`docs/BROKERED_SECRETS_W3_W4_CONTRACTS.md`, nicht im öffentlichen Snapshot)
**W8-Redaction:** Redacted Events und Persistenz
(`docs/BROKERED_SECRETS_W8_REDACTION.md`, nicht im öffentlichen Snapshot)
**W9-Resultate:** Resultate, Artefakte, Audit und Cleanup
(`docs/BROKERED_SECRETS_W9_RESULTS.md`, nicht im öffentlichen Snapshot)
**W5-Executor:** Platzierung und Lifecycle
(`docs/BROKERED_SECRETS_W5_EXECUTOR.md`, nicht im öffentlichen Snapshot)
**W6-Snapshots:** Immutable Snapshot-Verträge
(`docs/BROKERED_SECRETS_W6_SNAPSHOTS.md`, nicht im öffentlichen Snapshot)
**W7-Egress:** Protokollbewusste Netzwerk-Policy
(`docs/BROKERED_SECRETS_W7_EGRESS.md`, nicht im öffentlichen Snapshot)

## 1. Ziel

Verity-Agenten sollen projektbezogene Secrets verwenden können, ohne dauerhafte Provider- oder
Doppler-Credentials in der Agent-Sandbox, im Container-Image, im Repository, im Gesprächsverlauf
oder in gespeicherten Tool-Ergebnissen abzulegen.

Normale Entwicklungsbefehle laufen weiterhin lokal in der Session-Sandbox. Nur Befehle, die ein
Secret benötigen, werden explizit über `verity secret-run` in einer separaten, kurzlebigen
Ausführungsumgebung gestartet.

Der Agent arbeitet mit nicht geheimen Aliasen:

```text
expo_token
kubeconfig_staging
tailscale_auth
```

Nur der Verity Credential Broker kann einen autorisierten Alias auflösen. Ein lokaler Befehl erhält
weder den Wert noch ein auflösbares Provider-Credential.

## 2. Zentrale Sicherheitsgrenze

Dieses Konzept unterscheidet zwei Ziele, die nicht miteinander verwechselt werden dürfen:

1. **Secret-Hygiene:** Klartext liegt nicht dauerhaft in der Session, in Prompts oder in normalen
   Logs. Exact-Match-Redaction verhindert versehentliche Klartextausgabe.
2. **Secret-Isolation:** Vom Agenten kontrollierter Code soll den Wert nicht extrahieren können.

Ein generischer Prozess, der ein Secret als Environment-Variable, Datei, Argument oder `stdin`
erhält, kann dieses Secret grundsätzlich lesen. Darf der Agent beliebige Programme, Workspace-Code,
Ausgaben und Netzwerkziele kontrollieren, ist der Broker ein Extraction Oracle:

```sh
sh -c 'printf %s "$EXPO_TOKEN" | base64'
```

Exact-Match-Redaction erkennt eine solche Transformation nicht. Deshalb gilt:

> Ein generischer Secret-Job verbessert Secret-Hygiene. Eine belastbare Secret-Isolation
> entsteht erst durch eingeschränkte Ausführung oder einen spezialisierten Action Broker.

Das Produkt und die Dokumentation dürfen für den generischen Modus keine stärkere Garantie
behaupten.

## 3. Leitentscheidungen

1. **Hybrid statt vollständigem Shell-Proxy:** Lokale Befehle bleiben unverändert; Secret-Calls
   laufen über ein vom Verity Runner kontrolliertes natives beziehungsweise MCP-Tool. Die in der UX
   verwendete Darstellung `verity secret-run` ist kein authentifiziertes Sandbox-Executable.
2. **Discovery bei Bedarf:** Der initiale Agent-Kontext erklärt nur die Funktion. Der aktuelle
   Katalog wird über `verity secrets list` abgerufen.
3. **Doppler bleibt Source of Truth:** Verity speichert die Projektbindung verschlüsselt
   serverseitig und löst Werte erst für einen autorisierten Call auf.
4. **Separater Secret Job Executor:** Secret-Prozesse laufen weder im Verity-Serverprozess noch in
   der Agent-Sandbox. Ein außerhalb der Projekt-Sandbox betriebener Executor startet dafür
   kurzlebige, jobgebundene Ausführungsinstanzen. Der Begriff `Runner` bleibt dem in ADR 0006
   definierten Session Runner vorbehalten.
5. **Kein gemeinsam beschreibbarer Worktree:** Ein Secret-Prozess erhält niemals Schreibzugriff auf
   den Session-Worktree. Eingaben werden als Snapshot bereitgestellt; Ausgaben werden kontrolliert
   zurückgegeben.
6. **Redaction vor Beobachtbarkeit:** Rohes `stdout` und `stderr` dürfen Event Store, Logs,
   Telemetrie, WebSocket und Modell-Backend nicht erreichen.
7. **Explizite Vertrauensmodi:** Die UI und das Audit Event zeigen, ob ein Call nur Secret-Hygiene
   oder ein eng typisiertes, eingeschränktes Ausführungsprofil bietet.
8. **Spezialisierung für Hochrisiko-Credentials:** Wo eine Operation als Capability modelliert
   werden kann, ist ein Action Broker einem generischen Secret-Job vorzuziehen.

## 4. Nicht-Ziele

- Verity implementiert nicht für jedes CLI ein eigenes Tool.
- Redaction versucht nicht, alle Kodierungen, Transformationen oder Side Channels zu erkennen.
- Ein beliebiger, vom Agenten kontrollierter Prozess mit Secret-Zugriff wird nicht allein durch
  Platzhalter und Output-Filter vertrauenswürdig.
- Ein Secret-Alias ist keine Berechtigung. Autorisierung erfolgt serverseitig anhand von Projekt,
  Session, Policy und aktueller Secret-Freigabe.
- Der Secret Job Executor ersetzt nicht Least Privilege, kurzlebige Provider-Tokens oder
  zielsystemseitige
  Rechte.

## 5. Vertrauensmodi

### 5.1 `trusted` — Secret-Hygiene

Der Prozess darf ein freigegebenes Secret verwenden und besitzt die für das Tool übliche
Funktionalität. Verity verhindert dauerhafte Injektion und redigiert exakte Klartextwerte.

Dieser Modus eignet sich für vertrauenswürdige, fest versionierte Programme. Er schützt gegen
versehentliche Log-Leaks, aber nicht gegen absichtliche Extraktion durch das Programm, Repository-
Hooks, Plugins oder vom Agenten veränderten Code.

Die Verwendung benötigt eine projektseitige Freigabe und muss in UI und Audit als
`trusted / value visible to child process` gekennzeichnet sein.

### 5.2 `restricted` — typisiertes Ausführungsprofil

`restricted` ist kein frei formulierbarer Shell-Aufruf. Jedes Profil bindet unveränderlich:

- Executor-Image einschließlich Digest,
- absoluten Executable-Pfad und Binärdatei-Digest,
- typisiertes Schema erlaubter Argumente statt freier Argumentlisten,
- bereinigtes Environment, Arbeitsverzeichnis und erlaubte Input-Sets,
- erlaubte Interpreter, Plugins, Hooks und Unterprozesse,
- Zielprotokoll, Zielidentität und zulässige Requests,
- Ausgabe- und Artefaktvertrag.

PATH-Lookups, Shells, dynamische Loader-Overrides, Workspace-Binaries, Paketmanager-Shims,
Repository-Hooks und nicht ausdrücklich erlaubte Plugins sind deaktiviert. Programme wie `npm`,
`npx`, `node`, `python`, frei konfigurierbare HTTP-Clients und Workspace-Skripte gelten ohne ein
engeres Profil als `trusted`.

Zusätzlich gelten:

- dedizierte kurzlebige Job-Instanz,
- nicht privilegierter Benutzer, keine Host-Sockets und keine zusätzlichen Linux-Capabilities,
- schreibgeschützter Workspace-Snapshot,
- separates temporäres Dateisystem,
- protokollbewusster Egress-Proxy oder kein Netzwerk,
- Laufzeit-, Ausgabe-, Speicher- und Prozesslimits,
- kontrollierter Artefakt-Export,
- keine Rückgabe beliebiger temporärer Dateien an die Agent-Sandbox.

Kann eines dieser Felder nicht wirksam gebunden werden oder kann das Programm beliebigen
agentenkontrollierten Code ausführen, lehnt Verity das Profil als `restricted` ab. Es muss dann als
`trusted` ausgewiesen werden. Auch ein korrektes `restricted`-Profil reduziert Risiken, garantiert
aber keine Geheimhaltung gegenüber Fehlern oder Missbrauch innerhalb des ausdrücklich erlaubten
Protokolls und Zielsystems.

Netzwerkzugriff in `restricted` läuft fail-closed über einen protokollbewussten Policy-Proxy. Das
Profil bindet Schema, Host, Port, Zertifikatsidentität, erlaubte Methoden beziehungsweise RPCs und
gegebenenfalls Request-Felder. Die Job-Instanz besitzt keinen allgemeinen DNS- oder Raw-TCP-Zugang.
Der Proxy blockiert direkte IPs, private und Metadata-Netze, nicht autorisierte IPv6-Ziele,
Weiterleitungen und CONNECT-Tunnel. DNS wird vom Proxy aufgelöst und gegen die Policy sowie
Rebinding geprüft. Kann ein Protokoll nur als generisches TCP vermittelt werden oder kann ein
erlaubtes Ziel frei agentenkontrollierte Payloads entgegennehmen, ist das Profil `trusted`.

### 5.3 `action` — spezialisierter Broker

Der Agent übergibt nur fachliche Parameter, beispielsweise Commit-Daten, Kubernetes-Ressource oder
EAS-Build-Profil. Der Broker verwendet das Credential, ohne es einem universellen Child-Prozess zu
übergeben. Dies ist die stärkste Variante und der Standard für langlebige oder hoch privilegierte
Credentials.

## 6. Architektur

```text
┌──────────────────── Agent-Sandbox ─────────────────────┐
│ npm test / git diff / rg ... ────────────────► lokal   │
│ Repository-Code hat keinen Secret-Tool-Kanal           │
└────────────────────────────────────────────────────────┘

┌────────────── Verity Runner / Model Tool Gateway ──────┐
│ native/MCP: secrets.list / secret_run                   │
│ Darstellung im Transcript: `verity secret-run ...`     │
└─────────────────────────┬──────────────────────────────┘
                          │ authentifizierter Tool Call
                          ▼
┌──────────────── Verity Control Plane ──────────────────┐
│ Secret Catalog                                         │
│ • Projekt-/Session-Autorisierung                       │
│ • Alias → interne Doppler-Referenz                     │
│                                                       │
│ Credential Broker / Secret Job Orchestrator            │
│ • Policy und Vertrauensmodus prüfen                    │
│ • Secret just-in-time laden                            │
│ • Snapshot und kurzlebigen Job provisionieren          │
│ • redigierte Events und Audit-Daten entgegennehmen     │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────── Ephemeral Secret Job Instance ───────────┐
│ read-only Workspace-Snapshot + temporärer Write-Layer  │
│ Secret innerhalb der isolierten Executor-Trust-Domain  │
│ stdout/stderr → Streaming-Redactor                     │
│ kontrollierter Netzwerk- und Artefaktkanal             │
└─────────────────────────┬──────────────────────────────┘
                          │
                    erlaubte Zielsysteme
```

Die Ausführung verwendet drei getrennte Autorisierungsobjekte:

1. **Project broker capability:** bestehende, rotierbare Bindung der Projekt-Sandbox an den
   Credential Broker. Sie enthält kein Provider-Credential und entspricht der per-project Trust
   Domain aus ADR 0002. Gewöhnliche Workspace-Prozesse dürfen sie nicht direkt lesen; der Zugriff
   erfolgt über einen lokalen, eng begrenzten Broker-Client beziehungsweise über einen nicht
   vererbten Dateideskriptor.
2. **Single-use run grant:** kurzlebige, nicht wiederverwendbare Delegation für genau einen Request.
   Sie bindet Session-ID, Request-ID, Alias- und Profilversion, typisierte Argumente, Snapshot-ID,
   Freigabe, Audience, Ablaufzeit und Nonce. Der Broker führt einen Replay-Cache.
3. **Executor secret envelope:** einmaliger, jobgebundener und verschlüsselter Umschlag für eine
   authentifizierte Executor-Instanz. Er kann weder von der Agent-Sandbox noch für einen anderen Job
   eingelöst werden.

Der Serverprozess führt keine fremden Befehle selbst aus. Der **Secret Job Executor** ist ein eigener
deploybarer Dienst außerhalb der Projekt-Sandbox und außerhalb des ADR-0006-Session-Runners. Er
besitzt keine Control-Plane-Datenbank- oder Doppler-Credentials und akzeptiert nur versionierte,
gegenseitig authentifizierte Job-Anfragen des Orchestrators.

Das Konzept baut auf den Grenzen aus
[ADR 0002](adr/0002-credential-and-isolation-architecture.md) und
[ADR 0006](adr/0006-runner-in-sandbox-extraction.md) auf: Policy und Credential-Bindung bleiben in
der Control Plane; ausführbarer Code bleibt in einer separaten Ausführungsgrenze. Job-Lifecycle und
Event-Replay verwenden, soweit passend, dieselben restart-festen Semantiken wie ADR 0006, aber über
einen getrennten versionierten Executor-Vertrag.

## 7. Secret-Katalog

### 7.1 Projektseitige Definition

Ein Projekt gibt Aliase explizit frei und ordnet ihnen versionierte Ausführungsprofile zu. Die
folgende YAML-Darstellung beschreibt das öffentliche Konfigurationsmodell, nicht die physische
Datenbankstruktur:

```yaml
agent_secrets:
  - alias: expo_token
    source: doppler://mobile/prod/EXPO_TOKEN
    description: Authenticate Expo/EAS builds
    injection:
      type: env
      target: EXPO_TOKEN
    execution_profile: expo_build_trusted

  - alias: kubeconfig_staging
    source: doppler://infrastructure/staging/KUBECONFIG
    description: Access the staging Kubernetes cluster
    injection:
      type: file
      target: KUBECONFIG
    execution_profile: staging_kubectl
```

Serverseitig werden Provider-Binding, Secret-Alias und Execution-Profile als getrennte, versionierte
Entitäten gespeichert. Ein Alias darf nur auf eine Quelle innerhalb eines für das Projekt
autorisierten Provider-Bindings zeigen; projektübergreifende Doppler-Referenzen sind ausgeschlossen.
Profile enthalten Modus, Image- und Executable-Digests, Argument-Schema, Egress-Regeln,
Laufzeitlimit, Workspace-Inputs und Ausgabe-/Artefaktvertrag. Änderungen erzeugen eine neue Version
und verändern keine bereits genehmigten Run Grants.

`source` und Wert bleiben serverseitig. Der Agent sieht Alias, Beschreibung, Injektionsart, Ziel,
Profilversion und Vertrauensmodus, aber keine interne Doppler-Referenz.

### 7.2 Discovery

Der initiale Agent-Kontext enthält nur:

```text
This project provides brokered secrets. Use `verity secrets list` to discover
available aliases and `verity secret-run` to use one. Direct commands have no secrets.
```

Die maßgebliche Liste wird dynamisch über das Verity-native beziehungsweise MCP-Tool abgefragt. Im
Transcript und in Anweisungen wird der Tool Call zur besseren Lesbarkeit kommandoähnlich dargestellt:

```sh
verity secrets list
```

```text
ALIAS               MODE        INJECTION  TARGET       DESCRIPTION
expo_token          trusted     env        EXPO_TOKEN   Authenticate Expo/EAS builds
kubeconfig_staging  restricted  file       KUBECONFIG   Access staging Kubernetes
```

`verity secrets list --json` liefert eine versionierte, maschinenlesbare Struktur.
`verity secrets describe <alias>` zeigt Profil, Einschränkungen und ob eine Bestätigung erforderlich
ist. Der Katalog darf keine Existenz nicht freigegebener Aliase verraten.

## 8. Tool-UX

Die folgenden Beispiele sind kanonische Darstellungen strukturierter Tool Calls. Sie werden nicht
als authentifizierte Prozesse in der Agent-Sandbox ausgeführt. Ein lokales Convenience-CLI darf
nicht geheime Katalogdaten anzeigen, besitzt aber keine Berechtigung zum Start eines Secret-Jobs.

Der generische Modus ist ausdrücklich `trusted`:

```sh
verity secret-run --use expo_token --mode trusted -- eas build --platform ios
```

Das Tool zeigt vor Ausführung an, dass der Child-Prozess das Secret lesen und transformieren kann.
Eine projektseitige Policy entscheidet, ob zusätzlich eine Bestätigung in Verity erforderlich ist.

Ein `restricted`-Aufruf verwendet dagegen ein typisiertes Profil und benannte Parameter:

```sh
verity secret-run --profile staging_pods_list --param namespace=preview-123
```

Der Agent kann weder Executable noch rohe Argumentliste überschreiben. Die Profilversion legt
beispielsweise `/usr/local/bin/kubectl` samt Digest, das Verb `get`, die Ressource `pods`, das
Namespace-Schema und den Kubernetes-API-Proxy fest.

Mehrere Aliase sowie abweichende Environment-Variablen oder Dateien sind nur im Modus `trusted`
oder als fester Bestandteil eines typisierten Profils zulässig:

```sh
verity secret-run --mode trusted \
  --env CUSTOM_TOKEN=service_token \
  --file CONFIG=service_config \
  -- custom-cli deploy
```

Auch im Modus `trusted` überträgt das Tool ein Argument-Array und keine erneut interpretierte
Shell-Zeichenkette. Shells wie `sh -c` benötigen eine gesonderte Projektfreigabe und werden in der UI
als uneingeschränkt agentenkontrollierter Code ausgewiesen. Im Modus `restricted` sind Shells und
freie Argumentlisten unzulässig.

Secrets in Kommandoargumenten sind standardmäßig deaktiviert, weil sie in Prozesslisten,
Fehlerdiagnosen und Tool-Telemetrie erscheinen können. Interaktive `stdin`-Injektion folgt erst mit
PTY-Unterstützung und benötigt eine explizite Profilfreigabe.

## 9. Workspace- und Artefaktmodell

Reale Befehle benötigen häufig Quellcode, Konfiguration und erzeugte Artefakte. Die Job-Instanz
arbeitet deshalb mit einem unveränderlichen Snapshot der explizit ausgewählten Workspace-Eingaben.
Der Session-Worktree wird niemals direkt eingebunden.

### Eingaben

- Ein kleiner **Snapshot Exporter** innerhalb der Agent-Sandbox liest ausschließlich den
  freigegebenen Worktree-Baum. Die Control Plane orchestriert diesen Export, führt aber keine
  Repository-Befehle aus.
- Ein versioniertes Manifest beschreibt Git-Revision, uncommitted Änderungen, untracked Dateien,
  Löschungen, Umbenennungen, Dateimodi und explizite Ausschlüsse. Auswahlregeln und Größenlimits
  stammen aus dem Execution-Profile; der Client kann Manifest und Inhalts-ID vor Ausführung anzeigen.
- Der Export erfolgt atomar über sichere fd-relative Traversierung. Nur reguläre Dateien innerhalb
  desselben Mounts sind zulässig; Symlinks, Hardlinks, Sockets, Geräte, Mount-Wechsel, Submodule und
  LFS-Pointer werden standardmäßig abgelehnt und benötigen einen eigenen Importvertrag.
- Git-Credentials, Broker-Capabilities, `/run/verity*`, bekannte Secret-Dateien, VCS-Metadaten und
  projektspezifische Deny-Patterns werden nicht übernommen. Secret-Scanning ist zusätzliche Hygiene,
  aber kein Beweis, dass ein Snapshot secretfrei ist.
- Jeder Inhalt wird während der Erfassung gehasht. Der Executor verifiziert Manifest, Dateianzahl,
  Gesamtgröße und Content-Hash vor dem Start; Snapshot-ID und Run Grant sind untrennbar gebunden.
- In der Job-Instanz ist der Snapshot schreibgeschützt. Ausgaben landen in einem separaten,
  jobgebundenen und verschlüsselten Write-Layer.

### Ausgaben

- Standardmäßig werden nur redigierte `stdout`/`stderr`, Exit-Code und strukturierte Metadaten
  zurückgegeben.
- `restricted` darf nur strukturierte Ergebnisse exportieren, die der Executor gegen ein enges
  Schema dekodiert, validiert und selbst neu serialisiert. Alternativ überträgt der Broker ein
  Artefakt direkt an ein im Profil festgelegtes vertrauenswürdiges Ziel, ohne die Bytes dem Agenten
  zugänglich zu machen.
- Agentenlesbare Archive, Binärdateien oder andere opake Artefakte stufen den gesamten Call zu
  `trusted` herab, auch wenn nur benannte Pfade erlaubt sind. Exact-Match-Scanning ändert diese
  Einstufung nicht, weil transformierte Secrets unentdeckt bleiben können.
- Der Export lehnt Pfad-Escapes, Symlinks, Hardlinks, Geräte, Sparse Files, Extended Attributes,
  verschachtelte Archive und Größen-/Typabweichungen ab.
- Artefakte werden quarantänisiert und content-addressed in serververwaltetem Storage abgelegt. Ein
  Result Manifest enthält ID, Hash, Typ, Größe, Profil-/Image-Version und Aufbewahrungsfrist.
- Nichts wird automatisch in den Session-Worktree geschrieben. Ein späterer expliziter Import läuft
  als sichere Sandbox-Operation mit Konfliktprüfung und unveränderlicher Provenance.

## 10. Ausführungsablauf

1. Der Agent fragt bei Bedarf `verity secrets list` ab.
2. Für `trusted` sendet der Client Alias und Argument-Array; für `restricted` nur Profil-ID,
   Profilversion und typisierte Parameter.
3. Das Verity-native beziehungsweise MCP-Tool sendet den strukturierten Tool Call über seinen
   Runner-kontrollierten Kanal. Workspace-Prozesse können diesen Kanal weder aufrufen noch erben; ein
   lokales `verity secret-run`-Executable besitzt keine Startberechtigung.
4. Der Broker validiert Projekt, aktive Session, Alias-/Profilversion, Rate Limit und gegebenenfalls
   eine Benutzerfreigabe.
5. Der Snapshot Exporter erzeugt Manifest und unveränderliche Snapshot-ID.
6. Der Broker mintet einen Single-use Run Grant, der den vollständigen Request einschließlich
   Snapshot-ID bindet, und reserviert die Request-ID im Replay-Cache.
7. Der Orchestrator startet eine dedizierte kurzlebige Job-Instanz aus dem gepinnten Image. Die
   Instanz weist sich mit einer kurzlebigen, workloadgebundenen Executor-Identität aus.
8. Nach gegenseitiger Authentifizierung lädt der Broker den aktuellen Wert aus Doppler. Er sendet
   ihn als verschlüsselten, einmalig einlösbaren Envelope direkt an die konkrete Job-Instanz. Das
   Secret erscheint niemals in Container-/Pod-Spezifikation, Kommandozeile, Orchestrator-Environment
   oder Plattform-Logs.
9. Die Job-Instanz entschlüsselt den Envelope in Memory oder einem nicht persistierten anonymen
   Dateideskriptor beziehungsweise tmpfs. Core Dumps, ptrace, Swap und rohe Runtime-Logs sind
   deaktiviert; Secret-Dateideskriptoren sind `close-on-exec`, soweit das Zielprogramm sie nicht
   benötigt.
10. Das Secret ist innerhalb der isolierten Executor-Trust-Domain für den Zielprozess und technisch
    notwendige Nachfahren verfügbar. Das Konzept behauptet nicht, es sei ausschließlich in genau
    einem Prozess sichtbar.
11. Rohes `stdout` und `stderr` durchlaufen innerhalb dieser Trust Domain vor jedem externen Kanal
    den Streaming-Redactor. Nur redigierte, sequenzierte Frames verlassen die Instanz.
12. Der Orchestrator persistiert redigierte Frames und Jobstatus restart-fest. Client-Disconnect
    bedeutet Detach, nicht Cancel; erneutes Attach spielt Frames ab der bestätigten Sequenz erneut
    aus.
13. Nach terminalem Status prüft der Executor erlaubte strukturierte Ergebnisse oder übergibt
    freigegebene Artefakte in Quarantäne.
14. Cleanup entfernt Prozess-Cgroup, tmpfs und verschlüsselten Write-Layer. Ein unabhängiger Reaper
    reconciled verwaiste Jobs; das Run Grant und der Secret Envelope bleiben verbraucht.
15. Verity protokolliert Request-ID, sichere Alias-/Provider-Binding-ID, Profil-/Policy-Version,
    Snapshot-ID, Image-/Executable-Digest, Freigabe, Redactor-Version, Ergebnis und Cleanup-Status,
    aber niemals Secret-Wert oder rohe secrettragende Argumente.

## 11. Redaction und Persistenz

Der Broker hält pro Call eine nur intern sichtbare Zuordnung. Ausgehend ersetzt er jedes aktive,
exakt erkannte Secret durch einen Alias-Platzhalter:

```text
Prozessausgabe: authenticated with <actual value>
Agent erhält:   authenticated with {{secret:expo_token}}
```

Redaction muss vor folgenden Grenzen liegen:

- Event Store und Gesprächsverlauf,
- WebSocket- und REST-Streaming,
- Server-, Orchestrator- und Runner-Logs,
- Fehlerobjekte, Traces, Crash Dumps und Telemetrie,
- Push-Nachrichten und Tool-Ergebnisse aller Modell-Backends.

Chunkübergreifende Redaction ist bereits für den ersten produktiven Executor verpflichtend. Der
versionierte Redactor arbeitet byteorientiert vor Textdekodierung, hält
`maxActiveSecretBytes - 1` Bytes zurück und ersetzt überlappende Werte deterministisch
längste-zuerst. Binäre Frames bleiben binär und erhalten ausschließlich redigierte Payloads;
Truncation, Flush, Backpressure und Abbruch erzeugen nie einen ungefilterten Rest-Chunk.

Der Protokollvertrag begrenzt Anzahl und Länge gleichzeitig aktiver Werte sowie die maximale
Puffergröße. Konkrete Grenzwerte werden durch Last- und Kompatibilitätstests festgelegt und sind
zwischen Client, Broker und Executor ausgehandelte Protokollparameter. Werte unter einer definierten
Mindestlänge werden wegen hoher False-Positive-Gefahr abgelehnt. Property- und Fuzz-Tests prüfen
beliebige Chunk-Grenzen, Präfixe, Überlappungen, Binärdaten, Output-Limits und Verbindungsabbrüche.

Rohdaten dürfen auch bei Fehlern nicht in Debug-Logs oder persistente Spools fallen. Falls eine
vollständig rohe Transport- oder Plattformschicht technisch vor dem Redactor protokolliert, erfüllt
die Implementierung dieses Konzept nicht.

Redaction schützt nur exakte Werte. Base64, Hashes, zeichenweise Ausgabe, Dateien,
Netzwerk-Exfiltration, Exit-Codes und Timing-Kanäle bleiben außerhalb dieser Garantie.

## 12. Fehler- und Abbruchverhalten

- Direkte lokale Ausführung erhält kein Secret und schlägt regulär wegen fehlender
  Authentifizierung fehl.
- Unbekannte oder nicht autorisierte Aliase liefern eine nicht sensitive Fehlermeldung.
- Policy-Verstöße, harte Laufzeit-/Ressourcenlimits und explizites Cancel beenden die gesamte
  Prozess-Cgroup. Ein bloßer Client- oder Server-Verbindungsverlust beendet einen gestarteten Job
  nicht, sondern löst restart-festes Detach aus.
- Jeder Start besitzt `jobId`, idempotente `requestId`, monotone Frame-Sequenzen, terminalen Status
  und eine Controller-Lease. Derselbe Request darf nie einen zweiten Job erzeugen.
- Der Server kann nach Neustart Status und redigierte Frames erneut übernehmen. Executor und Server
  unterstützen mindestens N/N-1-Protokollkompatibilität entsprechend ADR 0006.
- Cleanup ist idempotent. Executor-Reaper entfernen verwaiste Instanzen nach ihrem absoluten
  Profil-Timeout unabhängig vom Request-Lebenszyklus. Zustände sind mindestens `pending`, `running`,
  `detached`, `cancelling`, `terminal`, `reaping` und `reaped`.
- Profile können idempotente provider-spezifische Cleanup-Hooks für externe Ressourcen wie
  Tailscale-Nodes oder Remote-Build-Sessions definieren. Tombstones, Retry/Backoff, Cleanup-SLO,
  Metriken und Alarmierung machen Fehlschläge sichtbar; eine Admin-Aktion ermöglicht kontrollierte
  manuelle Wiederholung.
- Rotation während eines Calls ändert dessen bereits injizierten Wert nicht. Neue Calls laden den
  aktuellen Wert; lange Vorgänge benötigen ein provider-spezifisches Renewal-Protokoll oder müssen
  neu gestartet werden.

## 13. Sicherheitsmodell

### Garantien

- Dauerhafte Doppler- und Provider-Credentials werden nicht in Agent-Sandboxes gemountet.
- Secret-Werte werden nicht in Agent-Prompts oder normalen Tool Calls benötigt.
- Nur explizit freigegebene Aliase und Profile sind innerhalb der zugehörigen aktiven Session
  verwendbar.
- Exakt ausgegebene aktive Werte werden vor externem Streaming und Persistenz ersetzt.
- Die Secret-Job-Instanz teilt weder Mount-, PID-, IPC- noch Network-Namespace mit der Agent-Sandbox
  und kann Session-Worktree, Metadatenservices oder Broker-Capabilities nicht erreichen.
- Widerrufene oder falsch gebundene Capabilities können keine neuen Calls auslösen.

### Keine Garantien

- `trusted` verbirgt das Secret nicht vor dem gestarteten Prozess.
- Redaction verhindert keine transformierte oder verdeckte Exfiltration.
- `restricted` kann Missbrauch über ausdrücklich erlaubte Programme und Zielsysteme nur reduzieren,
  nicht allgemein ausschließen.
- Ein breit berechtigtes Provider-Secret behält seinen zielsystemseitigen Blast Radius.
- Ein Secret, das selbst als universelles Bearer-Token funktioniert, wird nicht durch einen
  generischen Secret-Job zu einer eng begrenzten Capability.

### Defense in Depth

- kurzlebige und scopespezifische Provider-Tokens,
- Doppler-/Provider-Audit und regelmäßige Rotation,
- Kubernetes-/Cloud-/GitHub-RBAC im Zielsystem,
- profilbezogene Egress- und Executable-Regeln,
- Rate Limits und Concurrent-Call-Limits pro Session,
- explizite Bestätigung für produktive oder hoch privilegierte Aliase,
- spezialisierte Broker für wiederkehrende Hochrisiko-Workflows.

## 14. Verhältnis zu bestehenden Verity-Brokern

- **Aktuell — Git-Signing-Broker:** Der Agent liefert nur zu signierende Daten; der private Schlüssel
  verlässt die Broker-Grenze nie. Entspricht Modus `action`.
- **Aktuell — GitHub-Token-Broker:** Gibt ein kurzlebiges repo-scoped Token an den aufrufenden
  Sandbox-Prozess aus. Das reduziert Dauer und Scope, ist bezüglich dieses Prozesses aber kein
  vollständiger Secret-Entzug.
- **Zielarchitektur — Credential-Injection-Egress-Proxy aus ADR 0002/0006:** Ist für Protokolle
  geeignet, bei denen der Proxy Authentifizierung sicher terminieren oder injizieren kann. Dann muss
  das Credential keinen universellen Prozess erreichen.
- **Zielarchitektur — Secret Job Executor:** Kompatibilitätslösung für CLIs, die ein Credential lokal
  erwarten. Er ist nicht der Standard für zentrale Verity-Control-Plane-Credentials.

## 15. Einführungsphasen

### Phase 0 — Threat Model, Executor-Vertrag und Migration

- Datenfluss und Trust Boundaries gegen ADR 0002 und ADR 0006 festschreiben.
- Angreifermodelle für versehentliche Leaks, bösartigen Agent-Code und kompromittierte Dependencies
  trennen.
- Den Secret Job Executor als eigenen deploybaren Dienst und seinen versionierten Vertrag für
  Katalog, Grant, Start, Events, Attach, Cancel, Terminalstatus, Audit und Cleanup definieren.
- Drei Autorisierungsebenen, Replay-Schutz, Executor-Workload-Identität und verschlüsselten
  One-shot-Envelope prototypisch verifizieren.
- Snapshot-Manifest, sichere Sandbox-Export-Schnittstelle, Egress-Proxy und strukturierte
  Ergebnisverträge als testbare Protokolle spezifizieren.
- **Verpflichtende Bestandsmigration:** `DOPPLER_TOKEN` und freigegebene Secret-Werte nicht mehr in
  Agent- oder Dev-Server-Runtimes provisionieren; Provider-Bindings serverseitig auflösen,
  bestehende Sandboxes reprovisionieren und zuvor gemintete Tokens widerrufen. Bis diese Migration
  abgeschlossen ist, darf das Feature nicht als secretfreie Sandbox ausgeliefert werden.
- Normalisierte, versionierte Entitäten für Provider-Binding, Alias und Execution-Profile samt
  Rollen- und Änderungsmodell definieren.

### Phase 1 — Katalog und zwei eingeschränkte Pilotprofile

- Projektbezogene Alias- und Profilkonfiguration mit serverseitiger Doppler-Auflösung.
- `verity secrets list`, `describe` und typisierte `secret-run --profile`-Calls.
- Project Broker Capability, Single-use Run Grant und Executor Secret Envelope.
- Kurzlebige Job-Instanz mit gepinntem Image/Executable, Read-only-Snapshot, temporärem Write-Layer,
  Ressourcenlimits und protokollbewusstem Egress-Proxy.
- Versioniertes Snapshot-Manifest einschließlich atomarer Erfassung uncommitted Änderungen.
- Keine Shell-Strings, freien Argumentlisten, PTY-Nutzung oder agentenlesbaren opaken Artefakte.
- Chunkübergreifende Redaction vor sämtlichem Streaming und Persistenz.
- Restart-fester Jobstatus, idempotenter Start, Attach/Replay, Cancel, Audit und Reaper/Cleanup.
- Zunächst genau ein bis zwei nicht interaktive Workflows mit messbaren Startzeit-, Laufzeit- und
  Kostenbudgets pilotieren. Job-Instanzen werden nicht zwischen Jobs wiederverwendet.

### Phase 2 — Trusted Fallback, kontrollierte Ergebnisse und Developer Experience

- Generischen `trusted`-Modus mit expliziter Risikokennzeichnung und projektseitiger Freigabe
  ergänzen.
- Strukturierte `restricted`-Ergebnisse sowie quarantänisierte, opake `trusted`-Artefakte ergänzen.
- UI für Modus, Einschränkungen, Bestätigung und Artifact-Provenance.
- Mehrere kompatible Aliase im `trusted`-Modus, verständliche Policy-Fehler und expliziten Import mit
  Konfliktprüfung bereitstellen.

### Phase 3 — Interaktive Prozesse und Token-Lifecycle

- PTY- und `stdin`-Vermittlung mit Handle-Ersetzung.
- Definiertes Terminal-Echo-, Signal-, Resize- und Disconnect-Verhalten.
- Just-in-time Provider-Tokens sowie Renewal für unterstützte langlebige Prozesse.

### Phase 4 — Spezialisierte Capabilities

- Wiederkehrende Hochrisiko-Workflows aus generischen Secret-Jobs in Action Broker überführen.
- Beispiele: Kubernetes-Proxy, EAS-Build-Service und Cloud-Deployment-Aktionen.

## 16. Akzeptanzkriterien für Phase 1

1. Nach abgeschlossener Bestandsmigration enthält eine frisch provisionierte Agent-Sandbox weder
   Doppler-Token noch freigegebene Secret-Werte; alte Tokens wurden widerrufen.
2. Der Katalog zeigt ausschließlich autorisierte Metadaten und den korrekten Vertrauensmodus.
3. Ein lokaler Prozess kann einen Alias nicht auflösen.
4. Der Broker lehnt fremde, abgelaufene, widerrufene oder replayte Grants und Substitutionen von
   Request, Alias, Profil, Argumenten oder Snapshot ab.
5. Workspace-Code kann die Project Broker Capability nicht als frei lesbaren Bearer-Wert kopieren;
   parallele und wiederholte Requests unterliegen Rate-, Concurrency- und Replay-Schutz.
6. Ein Secret-Prozess läuft in einer eigenen kurzlebigen Job-Instanz und nie im Serverprozess oder
   ADR-0006-Session-Runner.
7. Der Session-Worktree ist für die Job-Instanz weder lesbar noch beschreibbar. Adversarial Tests
   decken Symlink-, Hardlink-, Mount-, Race-, Submodule-, Größen- und Spezialdatei-Angriffe ab.
8. `restricted` bindet Image, Executable, Argument-Schema, Environment, Inputs, Zielprotokoll und
   strukturierte Ergebnisse; unsichere Profile werden abgelehnt oder als `trusted` klassifiziert.
9. Der Egress-Proxy blockiert direkte IP-/DNS-/IPv6-/Redirect-/CONNECT-/Metadata-Umgehungen und fällt
   bei unbekannten Protokollen geschlossen aus.
10. Secrets werden über einen authentifizierten One-shot-Envelope geliefert und erscheinen nicht in
    Orchestrator-Spezifikationen, Runtime-Logs, Core Dumps, Swap oder persistentem Storage.
11. Exact-Match-Redaction funktioniert byteorientiert und chunkübergreifend vor Event Store, Logs
    und Agent-Streaming; Fuzz-Tests decken Überlappung, Binärdaten, Backpressure und Abbruch ab.
12. Adversarial Tests prüfen zusätzlich Executable-Substitution, Plugins/Hooks, transformierte
    Ausgabe, erlaubte-Ziel-Missbrauchsversuche, Transport-/Crash-Logs und Executor-Escape.
13. Disconnect und Server-Neustart erzeugen keinen zweiten Job und verlieren keine bestätigten
    Frames; Attach/Replay und explizites Cancel funktionieren idempotent.
14. Nach Abschluss oder Abbruch sind Prozess-Cgroup, tmpfs und Write-Layer innerhalb eines
    definierten Cleanup-SLO entfernt; Reaper und Alarmierung decken Fehlerfälle ab.
15. Audit-Daten enthalten sichere Identitäten und Versionen von Request, Alias, Provider-Binding,
    Profil, Policy, Snapshot, Image, Executable, Freigabe, Redactor und Cleanup, aber keinen Wert.
16. Normale lokale Befehle funktionieren unverändert und ohne Broker-Roundtrip.
17. Sicherheitsdokumentation und UI behaupten für `trusted` und `restricted` keine vollständige
    Geheimhaltung gegenüber dem Child-Prozess.

## 17. Offene Produkt- und Implementierungsentscheidungen

Die Trust Boundaries und Vertrauensmodi sind entschieden. Vor Implementierung sind noch folgende
Produkt- und Technologieentscheidungen zu treffen:

- Welche Container-/MicroVM-Technik implementiert die kurzlebige Job-Instanz und ihre verschlüsselte
  ephemere Storage-Grenze?
- Die beiden nicht interaktiven Pilotprofile sind als fester Kubernetes-Read und tenantgebundener
  HTTPS-JSON-Aufruf ausgewählt. Ihre Profile, Nachweise und vorläufigen SLO-Gates stehen im
  W10-Pilotvertrag (`docs/BROKERED_SECRETS_W10_PILOTS.md`, nicht im öffentlichen Snapshot);
  reale Messwerte bleiben vor Phase 1 offen.
- Welche konkrete Policy-Proxy-Technik erfüllt den festgelegten protokollbewussten Egress-Vertrag?
- Welche strukturierten Ergebnis-Schemas sowie opaken `trusted`-Artefakttypen und Größen werden in
  Phase 2 unterstützt?
- Welche Projektrollen dürfen Aliase, Profile und Bestätigungspflichten verwalten?
- Welche Secrets sind wegen Länge, Format oder Berechtigungsumfang für generische Secret-Jobs
  grundsätzlich unzulässig?
- Welche bestehenden GitHub- und Doppler-Flows werden zuerst auf kurzlebige oder spezialisierte
  Capabilities migriert?
