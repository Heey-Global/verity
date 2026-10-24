# Retained trusted CLI output

`verity_secret_run` keeps a bounded inline preview and returns an `invocationId`
when its redacted output is available through `verity_secret_output`. Read pages
using that ID and `nextCursor`; `hasMore` indicates further stored frames. Reading
output never starts the command again. Access is restricted to the originating
project and session, using the current authenticated tool channel.

## Processing and limits

The privileged Runner-to-Server connection carries bounded stdout/stderr blocks.
The Server already owns the injected secrets and applies the streaming redactor
before persistence or tool output. Acknowledgments backpressure the Runner while
the Server processes each block; a small bounded redactor/batch tail can remain in
memory until more input or completion. Raw output is never persisted by this path.
Only committed redacted frames are exposed, encrypted at rest through the existing
secret-job frame store. This masks supported exact secret representations, not
arbitrary transformations a command could produce.

The inline response stays below the existing 24 KiB budget. Raw and retained
redacted output each have a 10 MiB per-invocation ceiling. Retained invocations
reserve their full allowance, with five per project and twenty across the Server.
Complete results that fit inline release their storage reservation immediately.
A full quota rejects a new retained-output execution before spawning its command.
Already stored output remains available after an output limit or other incomplete
execution; unresolved redactor tails are discarded instead of exposed.

Completed records expire one hour after completion. Abandoned running records
expire after two hours. Expiry is enforced on reads and by startup and periodic
cleanup. A Server restart does not extend the recorded deadline. Storage failures
are reported explicitly; they do not guarantee preservation of uncommitted data.

## Results and compatibility

`terminationReason` distinguishes process exit, timeout, output limit, redaction
failure, storage failure and transport failure. `terminationRequested` records a
requested process kill, not proof of successful cleanup. `exitCodeKnown: false`
means the numeric fallback is not an observed child exit code. A transport failure
does not authorize rerunning a potentially completed command.

Streaming is opt-in on the Server-to-Runner request. Older Runners return their
legacy redacted result; they do not provide retained output. Older Servers do not
request streaming. Credentials outside the streaming redactor's supported pattern
sizes or count also use the legacy path, including its 24 KiB withholding behavior.
Deploy both Server and Runner support before relying on large-output retrieval.
Historical output discarded by the legacy path cannot be recovered by this change.
