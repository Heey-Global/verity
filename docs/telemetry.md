# Telemetry

Verity collects product analytics only on the public website, `verity.build`.
The server, mobile app, and self-hosted installations send no analytics.

The website loads the cookieless Rybbit tag from a Heey-operated instance at
`stats.heey.global`, using a site-specific public ID. It records page paths,
referrers, and basic browser/device information. It does not receive prompts,
repository data, agent output, credentials, account identities, or error logs.

The tag is loaded with `defer` and does not set cookies or write browser
storage. These are technical properties, not a legal assessment of whether a
consent banner or another lawful basis is required.

Inter is served from the website's own origin. The page no longer contacts
Google Fonts.

To verify the deployment, load `verity.build` with browser developer tools
open and inspect its network requests, cookies, and storage.
