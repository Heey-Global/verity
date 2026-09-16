Release the Server fixes already merged in #402 and #403: preserve the usable
sandbox when replacement image preparation fails, and restore pull request
status discovery through GitHub App installation tokens.

Those changes arrived through the Verity GitHub App without release intents
because the validator exempted every bot. This follow-up records their backend
release decision. Agent-authored changes now require explicit intents; the
existing dependency and release automation exceptions remain narrowly named.
