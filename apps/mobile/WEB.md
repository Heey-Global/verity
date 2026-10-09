# Browser client

The browser uses the same Expo screens and data logic as the native app. Build
from the repository root:

```sh
npm run build:web --workspace @verity/mobile-app -- --max-workers 1
```

Official Core Docker images include the browser export and serve it at
`https://<core-address>:8082/app/` by default, on the same port as the API.
Existing installations need an updated image to receive it.

For a source installation, configure the Core with `VERITY_WEB_APP_DIR` pointing to the absolute path of
`apps/mobile/dist`, then open `https://<core-address>/app/`. The Core serves the
web client and API on the same origin. Static exports must retain the `/app`
base path; standalone hosting on another origin is not the authenticated flow.

For the local prototype, accept the installer's certificate warning in Chromium.
The browser cannot enforce the native TLS public-key pin. Signed identity checks
bind a pasted pairing code to the Core identity, but an active intermediary can
relay them; use a trusted network until trusted HTTPS is configured.

Paste the complete `verity://pair?payload=…` link from the installer to initialize
or unlock the master password. Alternatively, paste an invitation link or code
created under **Devices** on an authenticated device. A web-created invitation
code pairs another browser; native-compatible links require the TLS pin retained
by a native app or installer. Browser credentials remain in a Secure, HttpOnly
session cookie; the installer bootstrap stays in memory only.
Use **Devices → Sign out** to revoke this browser's session. Other devices can
remove it through the shared Devices screen. Browser sessions expire after 30
days without authenticated activity. Changing the master password currently does
not revoke existing devices; remove their access explicitly under **Devices**.

Projects, sessions, live chat, and approvals use the shared client with a
same-origin cookie transport. Uplink, uploads, meeting/voice, and push support
are outside this first browser implementation. Native push listeners are skipped
in the browser. Existing shared image URLs use the cookie automatically.

The shared screens use React Native Web and Unistyles. Styles passed through
untransformed wrapper components or into FlashList must be plain values so the
browser receives layout and transcript inversion correctly. Metro includes
`wasm` assets for Expo SQLite; bundling its worker does not verify browser meeting
storage, which has additional hosting requirements.
