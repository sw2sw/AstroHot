# Initial Error-Recording Scope

[中文](ERROR-RECORDING.md) | [English](ERROR-RECORDING.en.md)

Status: An isolated development candidate exists; final acceptance and release integration remain pending. This page describes only the planned scope; update it according to actual acceptance results when the official source code is released.

## Planned Implementation
Reuse task runs, missing/rejected batches, model receipts, and retry records; add an idempotent error-event entry point. Source responses after RSS parsing/database insertion failures are retained in private persistent storage and are not lost when application transactions roll back; read-only queries output redacted statistics and internal associations.

## Out of Scope
No automatic repair, source requests, model reruns, unpausing, or release of unknown receipts; no public error API, new web pages/notifications, or high-frequency inspections.

## Privacy and Evidence
Retain only necessary source failure responses. Reuse existing receipt associations for original model responses rather than copying them into new events. Authentication information, query parameters, database connection strings, and private paths must not enter summaries. Real evidence must not be placed in public Issues or Git repositories.

## Definitions and Reporting Rules
Distinguish partial success from failure of an entire run, manual pauses, 429 backoff, waiting for capacity, and unknown requests. Valid rejections in scientific screening/copyright review are not system failures. Counts represent actual error observations and do not increase with repeated viewing; if the recorder itself fails, mark the check as incomplete rather than reporting zero errors.

The final CLI commands and fields are governed by the actual deliverable; no fictitious runnable commands are provided at present.
