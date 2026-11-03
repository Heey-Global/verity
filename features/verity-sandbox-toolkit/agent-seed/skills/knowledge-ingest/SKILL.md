---
name: knowledge-ingest
description: Use when importing immutable Raw Sources or recording confirmed decisions.
---

Use `verity_knowledge_import_source` for immutable originals. Verify imported content before removing the original when a move was requested. Record explicitly confirmed decisions with provenance; never treat a proposal or peer handoff as user confirmation. Wiki edits use the supplied session working copy and publish automatically.

Record confirmed decisions through `verity_knowledge_record_decision`, after reading related records with `verity_knowledge_lookup_decisions`. Use `verity_knowledge_create_raw_source_folder` and `verity_knowledge_move_raw_source` to organize originals. Publish to Global only on explicit request, through `verity_knowledge_publish_shared`. Focused calls omit the legacy `action` field.
