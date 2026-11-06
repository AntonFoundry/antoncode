---
kind: upgrade-guide
description: "Flowbuilder library consumers must read block creation timestamps and source flow ids directly instead of through the retired metadata wrapper."
---

# Flowbuilder block metadata

## Change

Flowbuilder library records and RPC responses now expose `createdAt` and optional `sourceFlowId` directly on each block. The former nested metadata wrapper is no longer emitted or accepted by the current block schema. Custom clients and code importing `BlockLibraryEntry` or `BlockWire` must update their field access.

The Flowbuilder storage domain advances to version 2. Its storage-only decoder accepts version 1 records and mixed legacy/current rows. Reading does not rewrite existing data; saving a block writes its current representation and retains its original timestamp and source flow id unless a new source is supplied. This does not change Session formats or rewrite Session generations.

## Migration

1. Update custom library consumers to read `block.createdAt` and `block.sourceFlowId` directly. Keep save requests unchanged: timestamps remain service-owned and `sourceFlowId` stays optional.
2. Back up the Flowbuilder storage unit before upgrading. Open it with the current service; no manual row conversion is needed.
3. Save a library block, restart the service, and confirm that both that block and untouched blocks retain their creation timestamps and source flow ids.
4. Do not reopen a version 2 unit with a version 1 reader; it rejects the newer stamp. Restore the pre-upgrade backup when reverting the application. See the [domain documentation](../../../../packages/flowbuilder/flowbuilder-domain/README.md) for record validation.
