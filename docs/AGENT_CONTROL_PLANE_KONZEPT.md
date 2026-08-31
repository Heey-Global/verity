# Verity — Agent Control-Plane + Mobile App (Konzept)

> **Projektname:** **Verity** (Repo `Heey-Global/verity`). „Frei von überall arbeiten, entspannt,
> im Flow." Die App heißt ebenfalls Verity.

**Status:** Entwurf v3 (4-Lens-Review eingearbeitet), 2026-06-19
**Autor:** Holger (mit Claude / Concierge)
**Geltungsbereich:** Eigene mobile App + dünner Control-Plane-Server, der die heey-global
Dev-Flotte steuert — Multi-Projekt, Multi-Agent, Handoff-Koordination, Idea-Inbox/Backlog/
Dispatch, plus eine **austauschbare** LLM-Runtime-Schicht für Resilienz/Exit-Option.
Ersetzt langfristig die Steuerung über die Claude-App und Concierges file-basiertes Handoff.

> **Leitentscheidungen:** (1) Claude-first, aber von Tag 1 **austauschbar** gebaut (kanonisches
> Event-Modell + Adapter-Seam; OpenCode → LLMBase später, flippbar). (2) Resilienz kommt aus der
> austauschbaren Runtime, nicht aus einem Provider-Abo. (3) Der Großteil der Schichten wird
> **adoptiert/geforkt**, nicht neu gebaut; Eigenbau = Orchestrierung + Learning-Loop. (4) **Voice
> ist primäre Eingabe** (Capture + Steering), nicht nice-to-have. (5) Single Source of Truth für
> den Verlauf: die **Datenbank** (die `.jsonl` ist nur eine materialisierte Arbeitskopie, §5a).

> **v3-Änderung:** durch ein 4-Lens-Review (Architekt / AI-Systems / UX / Security) geprüft. Die
> drei konvergenten Critical-Themen (State-Ownership/Recovery, App↔Server-Zugriff, Token-Blast-
> Radius) sind eingearbeitet; weitere Härtungen + offene Baupunkte stehen in §16.

---

## 1. Motivation in einem Absatz

Heute läuft die mobile Steuerung über die Claude-App (Remote-Control in tmux-`claude:main` pro
Container). Zwei wachsende Schmerzen: **(1)** die Claude-App wird bei langen Konversationen zäh,
**(2)** wir hängen vollständig an Anthropic — bei Claude-Ausfällen steht der Workflow. Dazu fehlt
eine **Intake-/Koordinations-Schicht:** kein reibungsloses Idee-Einfangen während ein Agent
arbeitet, keine leichtgewichtige Priorisierung, kein sauberes Dispatchen ins Worktree, fragile
file-basierte Cross-Repo-Handoffs. Ziel: eine **eigene, schnelle App** (Voice-first) + ein **dünner
Server**, der (a) alle Projekte/Agenten vom iPhone steuerbar macht, (b) die Runtime austauschbar
hält, (c) die Capture→Priorisieren→Dispatch→Tracking→PR/Merge-Pipeline schließt. Akute Resilienz
(bis der OpenCode-Adapter steht) trägt der Bedrock/Vertex-Stopgap (§13).

---

## 2. Status quo — Ist-Zustand

- **Container pro Projekt** (`dev-<p>`), je tmux-Session `claude`/Fenster `claude:main`, interaktiv
  `claude` (Subscription-Login, kein API-Key).
- **`dev`-CLI** treibt Claude per `docker exec … tmux send-keys` + `tmux capture-pane` (Scraping).
- **Concierge** delegiert via `dev handoff <p>` → `inbox/<ts>.md`; Reply `<ts>.reply.md` im
  `## Status:/Summary:/Details:`-Format; `dev handoffs` pollt.
- **Nightly-Digest-Loop** (`/opt/optimizer`): Transkripte → klassifizieren → Rekurrenz → Vorschlag
  → Operator-Approval → Rollout. Moat.
- **GitHub-backed**, Tailscale (MagicDNS), Doppler-Secrets, GitHub-App-Tokens (~1h, Auto-Refresh
  via `heey-token-mint` → `~/.gh-token`).

### Was fehlt
Schnelles eigenes Front-end · Resilienz/Exit-Option · dynamisches Spawnen paralleler Agenten ·
saubere getrackte Cross-Repo-Handoffs · Idea-Inbox + Backlog + Dispatch.

---

## 3. Architektur-Überblick

```
RN-App (iPhone, über Tailscale — ACL-gated)
   │  WebSocket (kanonische Events) + REST (Control-Plane)
   ▼
┌──────────────────────────────────────────────────────────┐
│  Control-Plane (Node/TS) — zustandsbehafteter Orchestrator │
│  • Durable Event-Log + Index (Postgres) = Source of Truth  │
│  • Projekt-/Agent-/Worktree-Lifecycle                      │
│  • Handoff-Bus (Phase 2) · Idea-Inbox/Backlog (GitHub)     │
│  • Enrichment + Permission-Bridge ◄ runtime-agnostisch     │
│  • Canonical Event Bus                                     │
│        ▲                         ▲                         │
│   Adapter: Claude Code      Adapter: OpenCode (Phase 3)    │
└────────┼─────────────────────────┼────────────────────────┘
         ▼ (setsid/tmux, überlebt Server-Restart)            ▼
  `claude -p stream-json`      `opencode serve` → LLMBase
   .jsonl ⇄ DB (materialize/tail) (deferred — Phase 3)
```

> **Achtung Etikett:** „dünner Server" meint *eine Code-Basis*, nicht *geringes Risiko*. Es ist ein
> **zustandsbehafteter Fleet-Orchestrator** (Sessions, Orchestrierung, Handoff-Bus, Inbox,
> Enrichment, Permission-Bridge). Die kritische Eigenschaft ist **Crash-Recovery** (§5a), nicht
> Schlankheit.

**Leitprinzip:** Die App spricht **nur** kanonische Events. Adapter-Seam wird gezogen,
*implementiert* ist anfangs ein Adapter (Claude Code). Seam bleibt **interne Konvention** (eine
Normalisierungsfunktion + `raw`-Escape-Hatch), **kein** stabilisierter Cross-Process-Vertrag bis
ein zweiter Adapter (OpenCode, Phase 3) ihn validiert.

---

## 4. Build-vs-Buy — was adoptieren, was bauen (Marktrecherche 2026-06-19)

**ADOPTIEREN / FORKEN — Commodity-Hüllen:**
- **Alternative LLMs (Exit-Pfad):** unser **OpenAI-kompatibler Anbieter LLMBase**, nativ konsumiert
  von OpenCode (Phase 3). Kein Consumer-Abo, kein Zwischen-Gateway.
- **Mobile-Client:** **Happy** (Fork) **oder** **opencode-manager**/**portal** (PWA) — Entscheidung
  beim MVP-Front-end.
- **Issue→PR-Dispatch (optional):** Tembo / OpenHands / Claude Code Action — nur falls wir den
  Dispatch-Kern nicht selbst wollen.
- **Sofort-Stopgap heute:** Anthropic Remote Control + Routines (zero-build, Claude-locked).

**SELBST BAUEN — das, was die Flotte einzigartig macht (= der Wert):**
- Orchestrierungs-Glue (Provisionierung hinter API + Worktree-per-Agent-Spawn).
- **Egress-Firewall (deny-by-default)** als Exfiltrations-Riegel — Design-Blueprint von **Clawker**
  (eBPF→CoreDNS-NXDOMAIN + Envoy-Pfad-Filter), in unsere ansible/Docker-Schicht nachgebaut.
- Cross-Repo-Handoff-Bus — Pattern aus **Warren** (MIT).
- Idea-Inbox → Backlog → Dispatch (GitHub-native).
- **Nightly-Learning-Loop** — kein fertiges Produkt; **der Moat** (liest Transkripte direkt).
- Dünner kanonischer Event-Server + Adapter.

**HAST DU SCHON — erweitern:** `dev`-CLI · Concierge · Learning-Loop · Doppler/Tailscale/agent-seed.

> **Verworfen als Basis:** **AgentsMesh** (BSL-1.1 bis 2030). **Vibe Kanban** (Sunset) / **Omnara**
> (archiviert) meiden. **Clawker** (AGPL, Solo, 32★, „early dev", Claude-only, will Container+Netz-
> Lifecycle besitzen → kollidiert mit `dev`/ansible + Tailscale) → **nur** Egress-Firewall-*Design*
> übernehmen, nicht als Dependency.

---

## 5. Agent-Runtime & Auth (Claude-first, austauschbar)

- **Default-Runtime: Claude über ACP v1** — `claude-agent-acp`, gestartet vom Runner-Supervisor
  über den Spawn-Broker (ADR 0012). Der ursprüngliche Pfad hier war
  `claude -p --output-format stream-json --resume <id>`; dieses native Transport-Backend ist
  abgelöst und existiert nicht mehr als Rollback-Option.
- **Auth über die Subscription:** Verity speichert die refreshbare
  `~/.claude/.credentials.json` aus dem Claude-Connect-Flow verschlüsselt in der
  Datenbank. Nur der Control Plane Server darf den rotierenden Refresh-Token
  einlösen; Refreshes sind accountweit serialisiert. **Der Access-Token verlässt den
  Control Plane nicht:** Agent-Prozesse bekommen als `CLAUDE_CODE_OAUTH_TOKEN` nur den
  nicht-geheimen Egress-Platzhalter und sprechen über den Sandbox-lokalen Connector mit
  dem Agent Gateway, das den echten Token erst upstream einsetzt (ADR 0010). Sandboxes
  erhalten weder Refresh-Token noch Credentials-Bind — und seit Phase 2 auch keinen
  Access-Token mehr.
- **Nicht das Agent-SDK direkt** (API-Key-only). Der ACP-Adapter treibt die `claude`-Binary
  als Subprozess (`CLAUDE_CODE_EXECUTABLE` zeigt auf das root-eigene Image-Binary).
- **Austauschbarkeit:** kanonisches Event-Modell (§5b) ist nicht Claude-spezifisch; OpenCode-Adapter
  (§13, Phase 3) steckt später ein, **per Config flippbar** (nur pro *neuer* Session — mitten in
  einer Session unmöglich wegen Cache-/Thinking-Block-Inkompatibilität).

### 5a. State-Ownership, Single Source of Truth & Recovery

- **Postgres = durable Source of Truth.** Der vollständige Gesprächs-Log lebt in der DB — ein
  **append-only Event-Log** (Messages, tool_use/tool_result, Compaction-Events), niemals getrunct.
  Er übersteht **Container-Neubau** (anders als ein Verlauf, der nur auf dem Container-Disk läge).
- **Die `.jsonl` ist eine materialisierte, wegwerfbare Arbeitskopie.** Beim Session-Start/Resume
  **rendert** der Server die `.jsonl` aus der DB in den Container; während der Live-Session **tailt**
  er Claudes Appends zurück in die DB. Claude liest/schreibt immer nur eine *normale* Datei — sie ist
  jederzeit aus der DB regenerierbar. (Aggressivere FUSE-Variante — Datei rein virtuell, real DB —
  siehe §16; höheres Hot-Path-Risiko, deshalb nicht v1.)
- **Voller Log in der DB — unabhängig vom Compaction-Verhalten.** *Compaction hängt an die
  append-only `.jsonl` an, statt sie zu kürzen — für explizites `/compact` **spike-bestätigt** (§18);
  für Auto-Compact am Kontextfenster-Limit noch offen (§16).* **Selbst wenn
  Claude Code die Datei stattdessen neu schreibt oder eine Continuation-Datei beginnt**, ist die DB
  geschützt: der Server **tailt jedes Event live in die DB, bevor** es überschrieben werden könnte —
  die DB hält damit den vollen Log *unabhängig* von diesem Verhalten (Defense-in-Depth, keine Wette).
  Was das Modell sieht, bleibt eine zur Laufzeit abgeleitete Sicht (gelöschte Historie wäre sonst
  unwiederbringlich). Der Adapter muss die **Session-Lineage** über evtl. verlinkte Continuation-
  Dateien verfolgen (§16).
- **Modell-Kontext ≠ Anzeige.** „Was das Modell sieht" rechnet Claude Code intern aus dem Verlauf
  (eigene Compaction) — andere *Form*, dieselbe *Basis*. Wir kürzen die Anzeige beliebig, ohne den
  Modell-Kontext zu berühren; „summarized memory" gehört NICHT in den `--resume`-Pfad (sonst
  Doppel-Compaction + Signalverlust).
- **Recovery ruht auf der DB:** Server-Crash verliert nichts — `.jsonl` aus der DB
  **re-materialisieren**, Log/Index ist schon da. `claude -p` läuft unter **`setsid`/tmux im
  Container** weiter und überlebt einen Server-Restart; **Live-Reattach** an den laufenden Prozess
  ist eine *Optimierung* und geht nur über eine **benannte** FIFO/Socket/tmux — **nie** eine anonyme
  stdout-Pipe (deren Read-End stirbt mit dem Parent → EPIPE).
- **Session-ID ↔ Worktree strikt 1:1.** Zwei Agenten dürfen **nie** dieselbe Session-ID resumen
  (Race → korrupter Verlauf). Session-ID + Lineage als harte Ressource tracken.

---

## 5b. Der dünne Server (Node/TypeScript) & Canonical Event Model

**Stack:** Node/TS — Typ-Sharing mit der RN-App (ein Event-Schema als eine `.ts`-Quelle), OpenCodes
SDK ist TS.

**Drei Schichten:** (1) **Adapter** (parst stream-json-NDJSON → kanonische Events; OpenCode später
via SDK). (2) **Enrichment + Permission-Bridge** (runtime-agnostisch): `tool_call name:"Bash"` →
Command-Karte, `Edit` → Diff-Karte, `gh pr`/URL → PR-Deep-Link; Permission-Bridge ↔ App-eigene
Approve/Reject-Buttons. (3) **Projektion-Index** (Postgres, §5a).

```ts
type AgentEvent =
  | { t: "session";     id: string; model: string; worktree: string }
  | { t: "status";      state: "running"|"awaiting_input"|"awaiting_dependency"|"crashed"|"completed" }
  | { t: "text";        delta: string }
  | { t: "thinking";    blockId: string; signature?: string; delta: string }  // Signatur fürs Resume-Replay
  | { t: "tool_call_start"; id: string; name: string }
  | { t: "tool_call";   id: string; name: string; input: unknown }   // erst bei block_stop valides JSON
  | { t: "tool_result"; id: string; output: unknown; isError: boolean }
  | { t: "permission";  id: string; tool: string; input: unknown; riskClass: "auto"|"ask" }
  | { t: "result";      usage: Usage; stopReason: string }
  | { t: "rate_limit";  status: string; resetsAt: number; window: "five_hour" }  // Quota-Headroom (§13)
  | { t: "compaction";  boundary: true }                       // aus stream-json system/compact_boundary
  | { t: "error";       kind: string; message: string }
  | { t: "raw";         backend: string; payload: unknown }   // nur Anzeige/Logging, NIE Steuerlogik
```

*Spike-verifiziert (2026-06-19): die stream-json-Realität liefert u. a. `system` (subtypes `init`/
`status`/`compact_boundary`), `assistant`, `user`, `result`, `rate_limit_event` — die obigen
Varianten sind daraus abgeleitet. Die `.jsonl` enthält zusätzlich interne Typen (`queue-operation`
etc.), die der Adapter ignorieren kann.*

**LCD-Risiko:** typisierter Kern + `raw`-Escape-Hatch + Capability-Flags (verhaltenswirksam, nicht
nur Render-Hints). Adapter gegen **aufgezeichnete stream-json-Fixtures pro gepinnter Version**
testen — hier lauert das instabile Schema.

**Permission-Modell — `--permission-mode auto` als Default (Operator-Entscheidung, fleet-weit):**
- Der **Auto-Mode-Classifier** (Anthropic) gatet den Großteil der Tool-Calls selbst; die
  **Permission-Bridge zeigt nur die *Eskalationen*** (was der Classifier ablehnt/unsicher ist),
  nicht jeden Call — passt zum Low-Friction-Workflow. Risikoklassen (read-only → auto; irreversibel/
  egress `push`/`rm`/`curl POST`/`send` → immer fragen, **nie** batch-„remember") gelten als
  zusätzliche, von uns kontrollierte Schicht.
- **Timeout bei Nichtantwort = parken**, nie still allowen.
- **Invariante: kein `--dangerously-skip-permissions`** — Start-/CI-Check, der die Agent-Invocation
  auf das Flag prüft und failt.
- *Spike-verifiziert (2026-06-19):* agent-seed-Hooks gaten auch headless (`touch` im `default`-Mode
  geblockt), **aber Auto-Mode ist permissiver** (dasselbe `touch` lief durch) → §16: prüfen, ob die
  Hooks im Auto-Mode überhaupt greifen, sonst ist der Classifier dort der **alleinige** Riegel.
- **Caveats:** (1) Auto-Mode hängt an Anthropics Classifier — Verfügbarkeits-Abhängigkeit (das
  „classifier temporarily unavailable" der Digests), läuft leicht gegen das Exit-Ziel. (2) überträgt
  sich **nicht** auf den OpenCode/LLMBase-Exit-Pfad (kein Anthropic-Classifier) → dort Hooks /
  `--permission-prompt-tool`.

---

## 6. Front-end (React Native)

**Warum RN:** vorhandener Stack, eine Codebase. (Beschleuniger: **Happy forken**, §4.)

**Claude-App-Lahmheit = Architektur, kein Framework** (ganzes Transkript im Speicher, keine
Virtualisierung). Unsere DB-gestützte, paginierte Anzeige (§5a) killt die Ursache.

**Perf-Patterns:** FlashList · paginiert aus dem Index · Streaming-Tokens batchen/throttlen,
streamende Message isoliert · Markdown/Code memoizen · Hermes + New Architecture.

**Voice-first (MVP-Kern):** Voice ist die **primäre Eingabemethode** — sowohl **Capture** (Idee →
Inbox) als auch **Steering** (Prompt/Antwort an einen Agenten diktieren). Tippen auf dem iPhone ist
die Hauptreibung. Transkriptions-Ansatz (on-device iOS-Diktat vs. server-seitig Whisper) → §16.

**Rich-Rendering aus kanonischen Events:** Code-/Command-/Diff-/Tool-/PR-Karten.

---

## 7. Isolation & Multi-Agent

| Was soll sich nicht stören?            | Mechanismus     | Ebene                          |
|----------------------------------------|-----------------|--------------------------------|
| Projekt A ↔ Projekt B (Deps, FS, Netz) | **Container**   | ein Container pro Projekt      |
| Agent 1 ↔ Agent 2 *im selben Projekt*  | **Git-Worktree**| mehrere Worktrees im Container |

Container = Projekt-Grenze. Worktrees lösen Git-Kollision *innerhalb*. **Mehrere Agenten** = N
Worktrees + N Prozesse; geteilte Toolchain + Dev-Server (gewollt), isolierte Working-Trees.
**Dynamisches Spawnen ist First-Class:** geblockt auf X → „neuer Agent" → frischer Worktree+Branch+
Prozess für Y.

**Worktree-Lifecycle als State-Machine + GC:** Branch-Naming (`agent/<session-id>`), Reaper-Job
(verwaiste Worktrees ohne lebenden PID → prune), Disk-Leak vermeiden, per-Worktree-Dev-Server-Port
über die Port-Registry. Isolations-Pattern: **Clawker** als Referenz.

---

## 8. Control-Plane / Orchestrator

Erweitert die **bestehende `dev`-CLI/ansible-Provisionierung**, ersetzt sie nicht — aber **nicht**
als API-Shim über die CLI-Textausgabe (das reproduziert die Scraping-Fragilität). Stattdessen den
**Provisioning-Kern als Library-Funktionen** extrahieren, die *CLI und API* gemeinsam aufrufen.
Verantwortungen: Projekt-Lifecycle (Repo hinzufügen → provisionieren), Worktree-/Agent-Lifecycle,
Port-Registry (§11), Handoff-Bus (§9).

---

## 9. Handoff-Bus & Cross-Repo-Koordination

Löst Concierges file-Scraping ab: Handoffs werden **First-Class-Objekte** (Zustand `sent →
in-progress → done/blocked/needs-help`, Quell-/Ziel-Projekt, Task, Reply). Das `## Status:`-Format
wird ein **Schema**. **Cross-Repo-Dependency-Tracking:** Handoff-Kette / Parent-Task mit
Sub-Handoffs; „B wartet auf A's PR-Merge". Pattern: **Warren**. In der App: Attention-Queue
absorbiert Handoff-Zustände + Koordinations-Ansicht. *(Phase 2 — nicht MVP.)*

---

## 10. Idea-Inbox + Backlog + Dispatch-Pipeline

Leitprinzip: *Capture entkoppelt von jedem laufenden Agenten — und reibungslos.*
**Capture → Priorisieren → Dispatch → Tracking → PR/Merge**
- **Capture:** Voice/Text → Issue. **Capture schreibt IMMER in einen projektlosen Triage-Bucket**
  (`inbox`-Repo / org-Project ohne Repo-Bindung) — **nie** wird im Capture-Pfad nach dem Projekt
  gefragt (sonst ist die Reibung zurück).
- **Priorisieren:** GitHub Issues = Atome, **GitHub Projects v2** = Board (Now/Next/Later);
  org-weites Project aggregiert über alle Repos. *(volles Board: Phase 2.)*
- **Projekt-Zuordnung** passiert **beim Priorisieren/Dispatch** (Kontext-Default / Triage /
  `gh issue transfer`), **Pflicht vor Dispatch** (ohne Projekt kein Worktree).
- **Dispatch:** Item → Worktree+Branch+Agent, vorbefüllt mit Issue-Body. ⚠️ Issue-Body als **Daten,
  nie als Instruktion** behandeln (Prompt-Injection, §16); kein Auto-Dispatch ohne Operator-Approval
  der ersten Aktion.
- **GitHub = Source of Truth**, Control-Plane **cacht** read-through; **Webhooks** als Invalidierung
  (kein TTL-Polling), Reconciliation beim Start. Writes immer zuerst an GitHub.

---

## 11. Port-Exposure (Tailscale)

Dev-Server hat MagicDNS-Adresse, iPhone im Tailnet → `http://<magicdns>:<port>` direkt (WireGuard-
verschlüsselt → plain http reicht). **MVP: laufenden Dev-Server-Port als klickbaren Link zeigen.**
Die *volle* Port-Registry (eindeutige Allokation, Buchführung, Teardown-Freigabe, Reconcile gegen
`docker port`) → Phase 2. Dev-Services im Tailnet unauthentifiziert → Tailscale-ACLs pro Port.

---

## 12. App-Features (MVP / v2)

**MVP:** Chat mit Rich-Rendering · **Projektliste mit Agent-Status-Badges** (kein volles Dashboard) ·
**Parallel-Agent-Spawn** · **Attention-Queue** (jeder Eintrag {Typ, Projekt, Agent, 1-Satz-Summary,
Alter}, sortiert nach Typ-Priorität; Crash/Hung als eigener Status) · **Voice-Input (Capture +
Steering)** · klickbare Dev-Server-Ports (simpel) · Lock-Screen Approve/Reject-Notifications
(actionable) · Idea-Capture → Triage-Inbox.

**v2:** voller Backlog→Tap-Dispatch + org-Board · Handoff-Bus + Dependency-Chaining · Fleet-Dashboard ·
PR/CI-Cockpit · Lern-Loop-Approval-Inbox + Classifier-Block-Notifications · Cross-Project-Suche ·
Async-Autonomie + /schedule.

---

## 13. Resilienz / LLM-Fallback

Resilienz kommt aus der **austauschbaren Runtime**, nicht aus einem Provider-Abo:
- **Exit-Pfad (Phase 3):** **OpenCode** als zweite Runtime, nativ OpenAI-kompatibel → **direkt mit
  LLMBase**. Kein Zwischen-Gateway, kein Consumer-Abo. Über den Adapter-Seam (§5b), flippbar pro
  *neuer* Session.
- **Warum nicht „durch Claude Code biegen":** CC-Harness ist auf Claude getunt → Fremdmodelle
  degradieren (Tool-Calling, verlorener Prompt-Cache). Nativ OpenAI-kompatible Runtime ist sauberer.
- **Same-Model-Stopgap (akut, bis OpenCode-Adapter steht):** **Bedrock/Vertex-Claude** = gleiches
  Modell, andere Infra (`CLAUDE_CODE_USE_BEDROCK/_VERTEX=1`) — rettet bei Anthropic-Kapazitäts-
  ausfällen ohne Modellwechsel. **Wahrscheinlich besseres Preis/Leistungs-Backup als ein Modell-
  wechsel** (s. Cost-Hinweis §16: CC-Subscription profitiert massiv vom Prompt-Caching).

### 13a. Quota-Bewusstsein (Subscription-5h-Fenster)

Die Subscription-Quota ist endlich und wird durch **Multi-Agent multipliziert** (N Agenten teilen
*ein* 5h-Fenster) — Erschöpfung = Arbeitsstopp. **Gut: die Quota ist beobachtbar.** Jedes
`rate_limit_event` im stream-json trägt `{status, resetsAt, rateLimitType:"five_hour", overageStatus}`
(spike-verifiziert 2026-06-19). Daraus:
- **Quota-aware Control-Plane:** liest `rate_limit_event` aus jedem Agenten-Stream → kennt Headroom +
  Reset-Zeit, zeigt sie in der App, **drosselt Parallel-Spawns** wenn das Fenster eng wird.
- **Exit-Pfad als Quota-Überlauf-Ventil:** bei Erschöpfung neue/laufende Agenten auf **LLMBase
  (per-Token)** flippen, bis das Fenster resettet. OpenCode→LLMBase ist damit *auch* Quota-Relief,
  nicht nur Ausfall-Resilienz.
- **Token-Hebel:** Compaction-Disziplin (kleiner Kontext = weniger Tokens/Turn — der Haupthebel),
  Modell-Tiering (sonnet/haiku für Routine), Parallelität steuern. ⚠️ Offen (§16): ob die 5h-Quota
  `cache_read` reduziert oder voll zählt — entscheidet, wie scharf die Multi-Agent-Mathematik ist.

---

## 14. Auth & Transport

- **App↔Server (v1): Tailscale-ACL** als Zugriffskontrolle (nur Phone-Node → Control-Plane-Port).
  Bewusst gewählt fürs Single-Operator-Tailnet. *Restrisiko:* schützt **nicht** gegen ein
  verlorenes/entsperrtes Handy im Tailnet — das könnte die Control-Plane erreichen und Approvals
  erteilen. Für jetzt akzeptiert.
- **Spätere Härtung (§16):** per-Device-Token + an `{tool_call.id, input-hash, nonce, expiry}`
  gebundene, replay-feste Approvals — sobald mehr Geräte/Leute dazukommen.

---

## 15. Phasing

1. **Phase 1 — MVP:** dünner Server (**ein** Claude-Code-Adapter, **Postgres=Truth** +
   materialisierte `.jsonl` + Recovery; **kein** generischer Seam) · RN-App (oder Happy-Fork) mit
   Rich-Rendering · Projektliste+Status-Badges · Parallel-Agent-Spawn · Attention-Queue (typisiert) ·
   **Voice-Input (Capture + Steering)** · klickbare Ports (simpel) · actionable Lock-Screen-
   Approve/Reject · Tailscale-ACL · Idea-Capture → Triage-Inbox. Eine Runtime (Claude Code,
   Subscription). Resilienz = kurzfristig Bedrock/Vertex-Stopgap.
2. **Phase 2 — Orchestrierung & Komfort:** Handoff-Bus (Cross-Repo-Deps) · Backlog→Dispatch +
   org-Board · volle Port-Registry · Fleet-Dashboard · PR/CI-Cockpit · Lern-Loop-Inbox.
3. **Phase 3 — Austauschbarkeit & tiefere Resilienz:** **OpenCode-Adapter → LLMBase** (flippbar).

Reihenfolge ist Schmerz-getrieben: erst die akuten Schmerzen (zähe App, kein Parallel-Agent, kein
Capture), dann Koordination, dann tiefere Austauschbarkeit — letztere am wenigsten dringend,
solange Subscription + Bedrock/Vertex-Stopgap die Verfügbarkeit tragen.

---

## 16. Härtung, Sicherheit & offene Baupunkte (aus dem 4-Lens-Review)

Bewusst getrackt, nicht im MVP-Critical-Pfad:

**Sicherheit**
- **OAuth-Token-Blast-Radius:** v1 geteilter Token (§5). Später per-Container-Token + Revoke-Runbook
  + Token nicht in die Agent-Bash-Env vererben (LoadCredential/file-fd).
- **App↔Server-Auth:** v1 Tailscale-ACL (§14). Später per-Device-Token + gebundene/replay-feste
  Approvals.
- **`git push` als Exfil-Kanal** trotz Egress-Firewall: GitHub-App-Token-Scope (nur installierte
  Repos) + Branch-Protection als bewusste Defense; Loop-Review von Push-Zielen.
- **Prompt-Injection:** Issue-Body/Repo-Inhalt/Transkripte sind **untrusted Daten** — im Dispatch-
  Prompt strikt von System-Policy trennen; Egress-Firewall + Permission-Bridge als Backstops.
- **Secret-Redaction** auf `tool_result` **vor** Persistenz (Secret-Shapes wie in AGENTS.md) — sonst
  Secret-Spread in Index/Loop.
- **Docker-Socket** nur in der Control-Plane, nie in Projekt-Containern; socket-proxy auf minimale
  Endpoints scopen (kein `exec`/`create` für Projekt-Container).
- **Envoy-MITM-CA** (Egress-Firewall) ist ein bewusster Trade-off — CA möglichst auf Proxy-Domains
  scopen.
- **Egress-Firewall ↔ Tailscale:** deny-by-default blockt Tailnet → `100.x`/`*.ts.net` allowlisten;
  vor Rollout in Wegwerf-Container testen.

**Learning-Loop-Härtung**
- Guardrail-Vorschläge **nur aus Operator-Aktionen/Korrekturen** ableiten, nie aus Tool-Output-Text
  (Provenance-Regel, = bestehende Memory-Poisoning-Regel).
- **Rekurrenz-Schwelle** N≥k gegen Overfitting auf Rauschen.
- **Ursache-vs-Symptom-Klassifikation** + Eval gegen Hold-out-Transkripte **vor** Enforce — ein
  Guardrail darf kein echtes Fehlersymptom maskieren (verstößt sonst gegen „fix root causes").
  Operator-Approval ist notwendig, aber nicht hinreichend → maschineller Vor-Filter.

**Architektur / Betrieb**
- **Cost-Messung** vor Phase 3: gleicher langer agentischer Lauf, Subscription (Cache-Read-Anteil!)
  vs. OpenCode→LLMBase per-Token — Cache-Verlust ist potenziell um Größenordnungen teurer.
- **Test-/Migrations-Strategie:** Adapter gegen stream-json-Fixtures; Postgres-Migrations-Tool;
  Dual-Write-Phase für die Concierge-file→Bus-Migration.
- **`raw`-Escape-Hatch** nur Anzeige/Logging, nie Steuerlogik (Lint-/Review-Regel).
- **Port-Registry** reconcile gegen `docker port` beim Start.
- **Compaction-/Continuation-File-Verhalten** von Claude Code beim Adapter-Bau verifizieren +
  Version pinnen (Session-Lineage vollständig erfassen, §5a).
- **FUSE-backed `.jsonl`** (Datei rein virtuell, real DB) als aggressivere Single-Storage-Variante
  zu „materialize+tail" — höheres Hot-Path-Risiko gegen das undokumentierte Format, daher erst bei
  Bedarf statt v1.

**Offene Spike-Verifikationen (aus 2026-06-19, s. §18)**
- **Zählt die 5h-Quota `cache_read` reduziert oder voll?** — Dreh- und Angelpunkt der Multi-Agent-
  Quota-Mathematik (§13a). Messen.
- **Auto-Compact am Kontextfenster-Limit** (nicht nur explizites `/compact`): append-only oder
  Rewrite/Continuation-Datei? — bisher nur `/compact` getestet (append bestätigt).
- **Greifen die agent-seed-Hooks im `--permission-mode auto`?** — im Spike lief ein `touch` im
  auto-Mode durch, das `default`+Hook blockte → ist der Classifier im Auto-Mode der alleinige Riegel?
- **Cold-Re-Prefill-Kosten** nach >1h Idle (gerade in Messung, §18).

**UX**
- **Offline/schlechte Verbindung:** Capture offline-puffern + später syncen; in-flight Approval bei
  Verbindungsverlust idempotent (kein Doppel-Approve).
- **Empty-States / Onboarding:** leere Attention-Queue als beruhigender „alles ruhig"-Zustand;
  Flow für neues-Projekt-hinzufügen + Claude-Auth-Pairing vom Handy.
- **Transkriptions-Ansatz** für Voice: on-device iOS-Diktat (billig, MVP) vs. server-seitig
  Whisper (bessere Qualität für lange technische Prompts) — entscheiden beim Front-end-Bau.

---

## 17. Deployment-Topologie

**Kein Docker-in-Docker (DinD) — Docker-out-of-Docker (DooD).** Der Control-Plane braucht *keinen*
eigenen Docker-Daemon im Container. Er mountet den **Host-Docker-Socket** (über einen
**docker-socket-proxy**) und erstellt damit **Geschwister-Container** auf dem Host-Daemon — die
Projekt-Container liegen *neben* dem Control-Plane, nicht *in* ihm.

**Das macht ihr schon:** genau dieses Muster nutzt heute der **Concierge** (verwaltet die
`dev-<p>`-Container via docker-socket-proxy; die `dev`-CLI orchestriert den Lifecycle). Der
Control-Plane ist „Concierges Rolle als richtiger Service" — gleiches Deployment, API statt
tmux-send-keys.

**Nichts wird geschachtelt:**
- Projekt-Container = **Geschwister** auf dem Host-Daemon (DooD), nicht genestet.
- Mehrere Agenten pro Projekt = **Prozesse + Worktrees *im* einen Projekt-Container** (Worktrees =
  Verzeichnisse, Agenten = `claude -p`-Prozesse) — **keine** zusätzlichen Container.
- Eine Ebene Container (alle Geschwister), darin Prozesse/Worktrees. Flach.

**Auf dem Stack:**
- **Control-Plane** = langlaufender Node/TS-Service auf dem **dev-server-Host** (Container wie
  Concierge oder systemd-Service), ausgerollt über das bestehende **ansible-auto-converge** — ein
  weiterer Stack, kein neues Paradigma.
- **Postgres** = ein Container daneben.
- **Tailscale** = Host ist bereits Tailnet-Node.
- **Sicherheit (§16):** Docker-Socket **nur** im Control-Plane, **nie** in Projekt-Containern;
  socket-proxy auf minimale Endpoints scopen (kein `exec`/`create` für Projekt-Container) — sonst
  ist Container→Host-root-Escape trivial.

**Warum nicht k8s** (trotz heey-k8s): der Dev-Loop (interaktive Agenten, Dev-Server, schnelles
Spawnen, Port-über-Tailnet) passt besser auf plain-Docker-auf-dem-dev-server als auf k8s-Pods —
k8s bringt nur Latenz/Komplexität für diesen Use-Case. Der dev-server ist die natürliche Heimat
(die Projekt-Container laufen eh schon dort).

---

## 18. Spike-Validierung (2026-06-19)

Wegwerf-Container (`dev-base:smoke`), die load-bearing Annahmen real getestet. **Fundament komplett
grün:**

| Test | Ergebnis |
|---|---|
| Headless-Auth via Claude credentials | ✅ Subscription/OAuth mit `CLAUDE_CODE_OAUTH_TOKEN`; Refresh-Credentials bleiben zentral im Control Plane Server; Scope `user:inference` |
| `claude -p stream-json` auf Subscription | ✅ **`apiKeySource:none`** — Subscription/OAuth, kein API-Key. Default-Modell headless = **sonnet-4-6** (Opus via `--model`) |
| `--resume` über getrennte Prozesse | ✅ Kontext trägt; **gleiche** session-id; `.jsonl` **append-only** (gewachsen, kein Rewrite/keine neue Datei) |
| Compaction (expliziter `/compact`) | ✅ hängt Summary + `compact_boundary`-Marker an (`isCompactSummary`/`compactMetadata`); **kein Truncate, keine Continuation-Datei** |
| Prompt-Cache | ✅ warmer Resume: **23.599/23.610 Input aus Cache** (~99,95 %); **1h-TTL** (`ephemeral_1h`); **Cache überlebt getrennte Prozesse** (server-seitig) |
| Quota-Beobachtbarkeit | ✅ `rate_limit_event` trägt `{status, resetsAt, rateLimitType:"five_hour", overageStatus}` → quota-aware Control-Plane möglich (§13a) |
| Permission headless | ✅ agent-seed-Hooks gaten auch headless (`touch` im `default` geblockt); plan-mode gatet; `permission_denials` taucht im `result` auf |
| `--permission-mode auto` | ✅ Classifier-gegatet (Operator-Default); permissiver als `default` (`touch` lief durch) — Hook-Wirkung im Auto-Mode offen (§16) |
| Input-Wege | ✅ (a) `--resume`-pro-Befehl **und** (b) Streaming-stdin (`--input-format stream-json`) beide funktionieren |

**Noch offen/in Messung:** Cold-Re-Prefill-Kosten nach >1h Idle (Cache abgelaufen) + ob die 5h-Quota
`cache_read` reduziert zählt — beides §16. Auto-Compact am echten Kontextfenster-Limit (nicht nur
`/compact`).

---

## 19. Multi-Repo Fleet Registry (Phase 1 Erweiterung, #174)

> **Status:** beschlossen 2026-06-26; Teile noch nicht implementiert. Source of truth für dieses
> Issue: [`Heey-Global/Verity#174`](https://github.com/Heey-Global/verity/issues/174).

Verity steuert nicht mehr nur sich selbst, sondern **alle Repos der heey-global GitHub-App-
Installation** als eigenständige Projekte. Projekt A ↔ Projekt B sind *container-isoliert*;
mehrere Sessions *im selben* Projekt teilen einen Container und nutzen Git-Worktrees (§7) —
dieselbe Isolationsmatrix, generalisiert auf die Flotte.

### 19.0 Projekt-Identität — kanonisierte `<owner>/<repo>` als einziger Treiber

Jede External-Input-Form eines Projekts (`POST /sessions { project: "<owner>/<repo>" }`, die
`GET /projects`-Liste, der `projects`-Tabellen-Schlüssel) **MUSS** vor der ersten Berührung mit
Dateisystem, Docker-Name oder Git-URL kanonisiert werden. Die kanonisierte Form ist der einzige
Wert, der in die drei gefährlichen Sinks (Host-Bind-Pfad, Container-Name, Clone-URL) eingeht.

**Kanonisierungsregeln (GitHub-konform):**

- Input: genau ein `/`-Separator trennt `<owner>` von `<repo>`; mehrfache `/`, führende/trailing
  `/`, `.`/`..`-Segmente → **400 Bad Request** (keine Silent-Normalisierung — der Client hat
  einen falschen Bezeichner geschickt).
- `<owner>`: Kleinschreibung per `.toLowerCase()`, Erlaubt-Zeichen `[a-z0-9-]`, Länge 1–39,
  kein führender/trailing `-` (GitHub-Owner-Rules).
- `<repo>`: Erlaubt-Zeichen `[A-Za-z0-9._-]`, Länge 1–100, kein führender/trailing `.`/`-`/
  `_`, keine konsekutiven `.` (GitHub-Repo-Rules). `.git`-Suffix wird gestrippt.
- **Abgeleitete Werte** (deterministisch, niemals vom Raw-Input):
  - `container_name = "dev-" + <owner> + "-" + <repo>`, owner/repo kleingeschrieben, alles Nicht-
    `[a-z0-9-]` in owner/repo zu `-` (Docker-Name-Charset).
  - `clone_path = "/data/dev/" + <owner> + "-" + <repo>` — eine einzelne Pfad-Segment (keine
    geschachtelten Verzeichnisse jenseits `dev/`), identische Transform wie `container_name`
    (`<owner>` kleingeschrieben, alles Nicht-`[a-z0-9-]` in `<owner>` UND `<repo>` zu `-`). Die
    ein-Segment-Regel verhindert, dass nach Kanonisierung ein weiteres `/` im Pfad verbleibt —
    d.h. `..`/`/`-Segmentgrenzen außerhalb `/data/dev/<slug>` sind konstruk­tiv ausgeschlossen.
    Dieselbe kanonisierte Slug-Form geht in `clone_path` und `container_name` ein — garantiert
    dass `rm -rf /data/dev/<slug>/` (§19.8) und `docker run -v /data/dev/<slug>:/work` (§19.3)
    auf dasselbe Verzeichnis operieren wie die Kanonisierung spezifiziert.
- **Persistierbar in `projects`** ist nur die kanonisierte Form. `<owner>` wird verpflichtend
  kleingeschrieben gespeichert (GitHub-Owner sind case-insensitive, aber persistiere konsistent).
  `<repo>` wird *ebenfalls kleingeschrieben* persistiert (GitHub-Repos sind case-insensitive; mit
  default Postgres-Collation wäre `UNIQUE(owner, repo)` sonst für `Foo`/`foo` unterschiedlich),
  und der ursprüngliche gemischte Repo-Name ist aus GitHub recoverbar (Nachschlagen via Repo-API
  im `GET /projects`-Sync). Alternativ: `CITEXT`-Spalten oder `LOWER(repo)`-Index — die
  cleane-Form ist lower-case-persistieren, dann entfällt das Workaround. `container_name`,
  `clone_path` werden ohnehin lower-case deriviert. Der Roh-String aus dem Request wird nach
  Kanonisierung verworfen; Unique-Constraints siehe §19.2 (`UNIQUE(owner, repo)`,
  `UNIQUE(container_name)`).

Diese Kanonisierung ist die **non-negotiable Eingangsvalidierung** für jeden `POST /sessions`-
Pfad und jeden internen Projekt-Lookup; sie verhindert Path-Traversal (`..`), Container-Name-
Kollisionen und injectierte URL-Komponenten in einem Schritt.

### 19.1 Projekt = Fleet-Container

- **Registrierungsmodell: Fleet-Container-Registry.** Ein "Projekt" ist ein `dev-<owner>-<repo>`
  Docker-Container, von Verity über den docker-socket-proxy provisioniert (§17 DooD-Geschwister-
  Container). Keine zweite Host-Clone-Topologie; Verity übernimmt die Lifecycle-Gewalt, die vorher
  ansible + `dev`-CLI manuell hielten.
- **Repo-Daten: bind-mount, nicht Container-ephemeral.** Clone bei `/data/dev/<owner>-<repo>`
  auf dem Host, gemountet als `/work` in den Container. Persistiert uncommitted Changes + alle
  Worktrees über Container-Neubauten hinweg. Verity klont beim ersten `POST /sessions` on-
  demand, niemals proaktiv geklont (die `GET /projects`-Auflistung *listet* proaktiv alle
  Installations-Repos als mögliche Projekte — aber Listen ≠ Klonen).
- **Verity-selbst = normales Projekt.** Kein Auto-Seed, kein `VERITY_REPO_DIR` Self-Mode; das
  Repo `heey-global/verity` taucht in der GitHub-Installationsliste auf und provisioniert beim
  ersten Session-Spawn wie jedes andere Repo. Der *Verity-Serverprozess* läuft in seinem eigenen
  HQ (Container/systemd) — kein Henne-Ei.

### 19.2 Schema

- **`projects`-Tabelle** `{ id (uuid), owner, repo, container_name, image_ref (nullable),
  state ('absent'|'cloning'|'container_starting'|'active'|'failed'), provision_error (nullable),
  created_at, updated_at }`. **Cache** des GitHub-Installation-Status + des Container-Lifecycle
  (§10: GitHub = Source of Truth, Verity cached read-through; die DB ist *nicht* die Source of
  Truth für die Existenz eines Repos — die ist GitHub).
- **Constraints (durchgesetzt von der DB, nicht nur Konvention):** `UNIQUE(owner, repo)` und
  `UNIQUE(container_name)` — letzteres hat Docker-Name-Kollisionen als Backstop. Die
  `(owner, repo)`-Kanonisierung aus §19.0 ist die Lookup-Form für den Upsert
  (`INSERT … ON CONFLICT (owner, repo) DO UPDATE`), und `container_name`/`clone_path` werden
  deterministisch abgeleitet und nie vom Client gesendet.
- **`sessions.project_id` nullable.** Schützt bestehende Verity-Eigen-Sessions vor der Migration
  (keine Projektbindung); neue Sessions referenzieren ein Projekt. Session↔Worktree bleibt 1:1
  (§5a).
- **Recovery-Pointer:** `sessions.project_id → projects.container_name → bind-path
  /data/dev/<owner>-<repo>/.verity-sessions/<session-id>/stream.jsonl` (wobei das Worktree-
  Verzeichnis selbst der per `dirNameFor` branch-sanitisierte Namen des Session-Branches —
  `agent/<session-id>` → `agent-<session-id>` — ist, nicht der rohe session-id-String; das ist das
  bestehende `packages/server/src/worktree.ts:46`-Verhalten, unverändert). **Kanonischer Recovery-
  Pfad**, kein „Source of Truth" (diese Bezeichnung ist §5a/§3/§10 vorbehalten — die `.jsonl`
  ist per §5a eine wegwerfbare Arbeitskopie, und die tatsächliche Truth-of-record ist das
  Postgres-Event-Log, nicht dieser Pfad). Path-Drift zwischen Worktree-String und tatsächlichem
  Container-Pfad vermieden, da der Host-Pfad aus `projects.container_name` deterministisch
  abgeleitet wird. `.jsonl` wird bei Resume **und beim** Container-Neubau (Stale-Detection) aus
  der DB re-materialisiert.

### 19.3 Provisionierungs-Flow (async)

`POST /sessions { project: "<owner>/<repo>", … }` ist der einzige Trigger; Provisionierung ist ein
idempotenter Side-Effect des Session-Spawns. Wenn `projects.state != 'active'`:

1. **`state='cloning'`** — Provider-frischer `ghs_*`-App-Installation-Token (`heey-token-mint`,
   ~1h-TTL, gleiche Provider-Form wie der PR-Lookup `main.ts:41`). **Token nie in die Clone-URL
   einbetten** (Git persistiert `remote.origin.url` in `.git/config`, das auf dem dauerhaften
   Bind-Mount liegt) — stattdessen `git -c http.extraheader="Authorization: Bearer <token>"
   clone https://github.com/<owner>/<repo>` (oder ein ad-hoc-Credential-Helper, der nach dem
   Clone geleert wird). **Nach erfolgreichem Clone** `git -C <clone> remote set-url origin
   https://github.com/<owner>/<repo>` (URL ohne Token überschreiben, eine Verteidigungsschicht
   auch falls `extraheader` irgendwo durchsickert). `404`/`403` vom Upstream → `state='failed'`
   mit `provision_error` (kein Pre-Check, Fehler ist der Beweis).
2. **`state='container_starting'`** — `docker run -d --name dev-<owner>-<repo> --label
   verity.project-id=<uuid> -v /data/dev/<owner>-<repo>:/work -v <gh-token-file>:ro
   <image_ref>`. Labels sind der Seam für spätere §11 (Port-Registry) und §16 (Egress-Firewall)
   Hooks; nicht MVP-implementiert.
3. **`state='active'`** — Verity startet den Agenten-Prozess (s. 19.4).

**Concurrency-Primitiv (MVP): `SELECT … FOR UPDATE`** auf der `projects`-Zeile, keyed nach
kanonisiertem `(owner, repo)`, umgibt den gesamten `state != 'active' → clone → run → active`-
Übergang. Zwei gleichzeitige `POST /sessions` für dasselbe noch-nicht-provisionierte Projekt:
der erste lockt, setzt `state='cloning'`, der zweite sieht den nicht-`absent`-state und wartet;
sobald der erste `active` setzt und commitet, bekommt der zweite den Lock, sieht `state='active'`
und springt direkt zum Agent-Dispatch. **Ohne diese Sperre** rennen beide ins `git clone`- /
`docker run --name`-Kollision (TOCTOU). Die Sperre MUSS im Implementierungs-PR drin sein; "prozess
interner Single-Flight-Pro-Container-Name" ist *nicht* genug (zwei Verity-Server-Prozesse oder
ein Server + ein Restart-Worker würden sie umgehen). Die `projects.state`-_column selbst ist der
Pessimistic-Lock-Indikator, und der Aux-Worker respektiert `state != 'absent'` als „nicht anfassen".

Job läuft im Hintergrund (`setsid`/Worker), `POST /sessions` returniert sofort `202` mit
`sessions.state='awaiting_provisioning'`. App zeigt Fortschritt; Verity startet den Agenten selbst,
sobald der Container `active` ist. **MVP-Recovery:** hängengebliebene Jobs → `POST /projects/<id>
-deprovision` (siehe §19.8) und Neu-Anlegen. Wiederaufnahme nach Verity-Restart ist *kein*
MVP-Ziel.

### 19.4 Agent-Dispatch & Stream-Transport

- **`docker exec` in den Projekt-Container** (über socket-proxy) startet `claude -p --resume <id>`
  (oder `opencode resume <handle>` pro session-konfigurierter Runtime; Flip nur pro *neuer*
  Session, §13) unter `setsid`/tmux. Der Prozess überlebt Verity-Server-Restart (§5a).
- **Stream-json über Tail-File im Bind-Mount, nicht FIFO.** Agent schreibt `stream-json >
  /work/.verity-sessions/<id>/stream.jsonl`; Verity tailt denselben Pfad vom Host-Bind mit
  Offset-Tracking. Kein Broken-Pipe-Risiko (FIFO bräche die §5a-Invariante "Prozess überlebt
  Server-Restart"); Multiple Sessions pro Container koexistieren (eine Datei je Session).
- **Runtime-agnostisch:** Claude- und OpenCode-Adapter schreiben/lesen dieselbe Datei; Resume-
  Handles bleiben adapter-spezifisch (`--resume <id>` vs. OpenCode-Handle). Verity dispatcht
  je Runtime; die Tail-Datei ist die runtime-unabhängige Brücke.

### 19.5 Container-Image (zentral gepinnt, pro Repo übersteuerbar)

`packages/server/config/default-project-image.json` (oder YAML), mit Renovate-Annotation:

```jsonc
// renovate: datasource=docker depName=ghcr.io/heey-global/dev-base
{ "image": "ghcr.io/heey-global/dev-base:2026.06-001@sha256:..." }
```

`POST /sessions` ohne `image_ref` verwendet den Default; mit `image_ref` pro Repo-Override.
`projects.image_ref` nullable (NULL = Default wird zur Container-Build-Zeit aufgelöst, nicht
eingefroren — ein Renovate-Bump des Default-Pins wirkt auf den nächsten Neubau des Containers,
auch ohne `projects`-Update). Renovate bumppt
den Default-Pin im Verity-Repo per PR; pro-Projekt-Overrides brauchen eigene Annotationen /
customManager-Regex (`.dev-server/Dockerfile`-ARG-Pattern, AGENTS.md-Beispiel). Kein Env-Short-
Circuit — Renovate greift atomar nur aufs Conf-File.

### 19.6 API-Oberfläche

| Route                                                              | Zweck                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /projects`                                                    | Liste der Repos der GitHub-App-Installation (live gespiegelt, `projects`-cache mit `state`). |
| `POST /sessions { project: "<owner/repo>", prompt, … }`            | Idempotenter Auto-Provisioning-Side-Effect; `202` + `state='awaiting_provisioning'`, falls Container nicht `active`. |
| `GET /projects/:projectId`                                         | Detail: Container-State + laufende Sessions.                                          |

### 19.7 Was nicht zum MVP gehört

- Wiederaufnahme hängengebliebener Provisioning-Jobs nach Verity-Restart (→ De-Provisionierung +
  Neu-Anlegen, siehe §19.8).
- Port-Registry-Allokation pro Projekt-Container (§11 bleibt für später; Labels schon gesetzt).
- Egress-Firewall-Enrollment pro Container (§16, Labels vorbereitet).
- Per-Container-Token-Mint (§16 — Shared-gh-Token-RO-mount ist MVP-Riegel). **Achtung
  Blast-Radius-Verschiebung:** heute kann nur der dev-server-Stack `~/.gh-token` lesen; §19 mountet
  selbiges Fleet-Token RO in **jeden** Projekt-Container. Ein kompromittierter Container kann das
  Token exfiltrieren und gegen jedes andere Installations-Repo pushen/PRs öffnen — nicht nur gegen
  sein eigenes. Die §16-Mitigation (Egress-Firewall + Branch-Protection + `git push`-Loop-Review)
  ist **ausdrücklich** *nicht* Teil dieses MVP — der Rest-Risiko verbleibt bis §16 landet. Pro
  Repo-Overrides/scope-limited-Tokens (per `VERITY_PROJECT_TOKEN_FILE` z.B.) sind die nächste
  Härtungsstufe und sollten zeitnah nach dem Multi-Repo-MVP-PR erfolgen.
- Volume-basierte oder SSH-Exec-Alternativen (siehe Issue #174 Optionsdiskussion).

### 19.8 De-Provisionierung

Um hängengebliebene Jobs wieder loszuwerden oder ein Repo aus der Flotte zu nehmen:

- `POST /projects/<id>/deprovision` (oder `DELETE /projects/<id>` mit Flag) setzt:
  - `docker stop dev-<owner>-<repo>` + `docker rm dev-<owner>-<repo>` (best-effort; Container kann
    schon weg sein).
  - `projects.state='absent'` (Zeile bleibt im Cache, GitHub-Listen-Sync re-populated sie später).
- **Bind-Mount fate (Operator-Wahl):**
  - **Default: behalten** — `/data/dev/<owner>-<repo>/` mit allen Worktrees + uncommitted Changes
    bleibt erhalten (persistent wie in §19.1 versprochen). Neu-Anlagen detecten den nicht-leeren
    Pfad und **überspringen das `git clone`** (Re-Use nehmen, nicht Re-Clone).
  - **Force-Clean** — `?purge=true` stopped+removes den Container UND `rm -rf /data/dev/<owner>-
    <repo>/`. Neu-Anlage fängt bei null an. **Irreversibel** — `provision_error`-Wording MUSS
    darauf hinweisen.
- **Re-Provisioning nach Deprovision-keep:** der Provisionierungs-Worker sieht einen nicht-leeren
  `/data/dev/<owner>-<repo>/`, führt stattdessen `git -C <clone> fetch + reset --hard origin/main`
    aus (Re-Sync, kein Clone), und startet dann den Container. Lock (§19.3) umgibt auch diesen
    Pfad.

### 19.9 Phasing

Implementiert als Phase 1 MVP-Erweiterung, sequenzielle PRs:

1. `projects`-Schema + Migration + store-API.
2. GitHub-Installation-Repo-Liste (`GET /projects`, gecacht).
3. Provisionierungs-Worker (clone + `docker run`, granulare States, async Job, `202`).
4. Agent-Dispatch via `docker exec` + Tail-File-Stream + Remote-Worktree-Provisioner.
5. Mobile: Projektauswahl im New-Session-Screen + Provisioning-Status.
