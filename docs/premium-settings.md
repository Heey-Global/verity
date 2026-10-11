# Verity Premium and Diagnostics — settings spec

Status: implemented · Targets: `apps/mobile/app/settings/premium.tsx`,
`apps/mobile/app/settings/diagnostics.tsx`, server-side feature switches.

Defers to [`design-language.md`](./design-language.md) for auto-save and the glossary. The
mockup is [`assets/premium/mockup.html`](assets/premium/mockup.html) (open it in a browser;
it is the editable source, one phone per state).

## 1. Why

- The paid features have no home: the key lives under *Server › Remote access*, the features
  are explained in upsell dialogs elsewhere, and the dialogs link to the wrong screen.
- Eight different labels describe two features ("Shared online", "Over the internet", "Remote
  Control", …).
- Uplink already grants `sharing` and `remote-control` separately, but there is no switch to
  keep one and turn the other off.
- Diagnostics are spread over four screens.

## 2. Vocabulary  [decided]

| Term | Meaning |
| --- | --- |
| **Verity Premium** | Umbrella for every paid Uplink feature; the only brand word in UI. |
| **Uplink subscription key** | The credential that activates Verity Premium on a server. |
| **Online sharing** | Preview links over the internet. |
| **Remote access** | Reaching the server from anywhere through Uplink. |
| **Teams** | Shared projects and sessions. *Coming soon*, not configurable. |

A feature works when the subscription includes it (`granted`) **and** it is switched on
(`enabled`). The app never says more than that.

## 3. Visual direction

The screens follow the meeting-start mockup, tuned to the app's tokens: cards and fields with
`radius.md` (10), buttons and tags with `radius.sm` (6), on the plain black ground. The
settings root keeps today's grouped-list style unchanged. **Blue (`primary`) carries every action** — the bottom CTA, links, selected
borders, the toggle knob. **Magenta (`accent`) is the signature only** — section eyebrows,
the Premium icon, the activation hero. Status is a small tag or dot, never a pill zoo. Text
stays minimal: a headline, one lead line, one-line subtitles.

## 4. Flow — one route, three states

`/settings/premium` renders one of three states from `uplinkSubscriptionKeyConfigured` and
the Uplink diagnostics. Every upsell deep-links here, so someone without a key lands on
the explanation, not on a form. See `mockup.html`, phones 0–4.

**0 · Entry** — *Settings › Server › Verity Premium* with the tag `Not active` / `Active`.
Replaces the "Remote access" row.

**1 · No subscription** — headline *Your server, reachable
anywhere.*, one lead line, three feature cards (Online sharing, Remote access, Teams with
`Soon`), and the CTA *Enter subscription key*.

**2 · Enter the key** — one masked field *Uplink subscription key* (masked, monospace) with a one-line note, CTA
*Activate*. While checking, the CTA turns into *Checking with Uplink…* with a spinner. A
rejected key gets a tag on the field (`Unknown`, `Revoked`, `Expired`) and a one-line reason
under it; no dialog.

**3 · Activated** — hero check mark, *Premium is active*, the two feature cards with their
toggles already on, confetti (~1.5 s, Reanimated + SVG, no new dependency), success haptic
(not on web), CTA *Continue* → state 4. Fires once per activation.

**4 · Manage** — *Subscription*: the Premium card with tag `Active`, below it a *Subscription
key* row (*Stored encrypted on your server*, *Replace ›*). The stored key is never read back. *Features*: one card per feature with a
toggle; Teams muted with `Soon`. A feature the subscription does not include keeps its
toggle but is muted with the subtitle *Not included in your subscription*. *Diagnostics*:
a *Connection* card with a status dot and a one-line summary, leading to Settings › Diagnostics. Bottom link *Remove subscription key* (danger,
confirmed; returns to state 1).

- Online sharing off → confirm *Active public links will be revoked* before saving.
- Remote access off → open remote connections end; the toggle shows a spinner until the
  server confirms. Defaults: both on. Servers without the switches hide the toggles. Existing `/settings/remote-access` links redirect here.

## 5. Diagnostics

Phone 5. Three cards: **Connection** (Uplink, Online sharing, Remote access with status dots
and a one-line reason only when off or not included), **Tests** (Test remote access, Record
connection test, Copy last recording — today's `PublicPreviewDiagnostics` controls, renamed),
**More** (Live transcription test, Matrix import errors with a count tag that expands the
details, Export app update logs with app and server versions). Fetch on focus and after a
test, never poll.

## 6. Server contract

- `GET/PATCH /settings`: `premiumSharingEnabled`, `premiumRemoteAccessEnabled` (default
  `true`). Remote access changes renegotiate only while a connection is needed; sharing off revokes active shares.
- `GET /api/uplink/diagnostics`: `features.{sharing,remoteAccess} = { granted, enabled,
  effective }`; the existing `sharing` / `remoteControl` fields report the effective state.
- `POST /api/uplink/check`: explicitly perform a bounded subscription-rights check.
- `GET /preview-capabilities`: `publicSharing: 'disabled'` for "switched off locally".

## Connection lifecycle

A stored subscription key does not by itself keep a connection open. Online sharing
connects when a preview or online-meeting share starts and disconnects after the last
share ends. Leaving Online sharing switched on without a share does not connect.
Remote access keeps a connection open to receive requests only when both the local
switch and the current Uplink entitlement allow it.

Switching a feature off or withdrawing its entitlement stops its data connections.
Without remaining effective demand, the control connection closes too. Cancellation
ends access when the entitlement expires, which may be later than the cancellation date.
A lease that expires without renewal also closes access and stops background attempts.

Initial and explicit entitlement checks are bounded to 15 seconds; final share
revocation is bounded to 5 seconds. Failed revocations remain durably queued for the
next explicitly requested connection. Local connectors are stopped independently of
whether Uplink acknowledges revocation. No background connection is opened solely to
retry queued revocations. A later tariff change is discovered by starting a share,
re-enabling Remote access, replacing the key, or choosing **Check subscription rights**.

Diagnostics report `control: 'idle'` for intentional disconnection and
`entitlement: 'unchecked' | 'checked'` for the last rights check. Cached grants are
historical when disconnected; every new connection verifies rights again.
`publicSharing: 'available'` means a share can be requested, including from idle;
it does not guarantee an active connection or entitlement before that check.

## 7. Open questions

- Show *Get Verity Premium ↗* in the open-source build, or only a neutral *Learn more*?
