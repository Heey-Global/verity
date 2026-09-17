Release the trusted CLI broker recovery fix that removes legacy flat secret files
at startup and isolates each new tool call in its own correlation-scoped directory,
so a killed or concurrent run cannot block later approved commands with `EEXIST`.
