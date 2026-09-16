Release the removal of obsolete file and environment GitHub token fallbacks. Server-side
GitHub operations now use only project-scoped tokens minted from the encrypted GitHub App
connection, while sandboxes continue to authenticate through broker capabilities.
