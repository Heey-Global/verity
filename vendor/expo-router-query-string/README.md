# Expo Router SDK 57 query serialization backport

This private package replaces only Expo Router's `query-string` dependency. Its serializer backports the URLSearchParams implementation from [Expo PR #50725](https://github.com/expo/expo/pull/50725). SDK 57's bundled React Navigation helpers also require `parse`; that compatibility entry uses the platform decoder and retains repeated keys and bare-key null values.

Generated queries follow the upstream fix: spaces use `+`, `*` remains literal, `~` becomes `%7E`, and null values become empty values. Existing percent-encoded links remain readable.

Remove the override and this directory when the supported Expo Router release removes `query-string`. This is not a general replacement for the query-string API. Tests scan installed Expo Router consumers so a new API use fails verification.
