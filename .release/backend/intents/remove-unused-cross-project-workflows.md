Include the removal of the unused cross-project workflow feature in the next
Server release. Remove its API, delivery tool, background processing, and store
implementation, and drop the unused workflow tables during migration.

Verity Control continues to create project sessions, deliver session handoffs,
and inspect progress. This cleanup does not require a breaking-change release.
