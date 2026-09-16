Do not cut a Server release for these CI scheduling and cache changes. Build
candidate sandbox and relay images during live acceptance, reuse one trusted
compiler artifact and compatibility ledger, and bound release cache exports.
Version and channel publication retain their existing acceptance gates.
Metadata-only release checks wait briefly for pending exact-base CI before
falling back to full validation.
