# Mobile session auxiliary reads

Opening a session keeps its existing history chain. On compatible servers the
session detail also includes optional `googleStatus`: effective Gmail, Calendar
and Contacts access plus the assigned Workspace document. This is local
presentation metadata, using the same scope and inheritance rules as the
individual status routes. It never decrypts credentials, invokes Google or
starts account authorization. It is not an authorization token; tool execution
still checks current access independently.

The attachment menu loads the Google account catalog when opened, with visible
loading and error states. Direct Google actions may also discover accounts.
The model catalog loads when the model picker opens; the stored model label
remains visible without discovery. Concurrent picker refreshes share a request.

After history readiness, focused chats still load linked sessions and pending
message approvals automatically. Their live subscriptions coalesce changes and
cancel reads when focus or session changes. Sidebar linkage markers continue to
come from existing overview summaries.

Focused chats observe `/sessions/:id/google-status` for later changes. As with
other live resources, the first observation and reconnect close the gap after
the detail response with a compact refresh. The server samples this local
resource every 15 seconds while observed; successful session, account and
project Google mutations schedule an immediate sample. This replaces the five
independent opening reads, rather than promising no status refresh at all.

Older servers without `googleStatus` use one delayed sequence of the four
existing status reads per focus. They do not load the account catalog or watch
the new endpoint. All asynchronous results are scoped to the server and session;
local mutation results invalidate older reads.

Scoped hook, API, store-backed route and resource-observer tests cover these
contracts. Device latency still requires a delivered client and before/after
measurements; fewer requests alone do not prove a latency improvement.
