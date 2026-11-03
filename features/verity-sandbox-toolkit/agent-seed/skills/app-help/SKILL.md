---
name: app-help
description: Use when explaining Verity features, settings or connectors.
---

# App help

When the user asks how Verity itself works, where a setting is, or how to connect a service, call `verity_app_help_lookup` instead of answering from memory. Pass on its `appLink` as a Markdown link, for example [Open GitHub settings](verity://settings/github); the app opens it directly. Use only `verity://` links the tool returned and never invent one. Add `docsUrl` only when the user wants more detail. If the catalog does not cover the question, say so.
