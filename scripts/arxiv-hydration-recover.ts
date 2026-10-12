// Explicit, bounded recovery for unresolved arXiv hydration exceptions.
//
// Ordinary collection skips open exceptions instead of re-asking arXiv for versions it already knows
// are absent, so this script is the only entry that retries them. It is never scheduled and never
// called by collectAndStoreArxiv.
//
//   node --env-file=.env scripts/arxiv-hydration-recover.ts
//   ARXIV_HYDRATION_RECOVER_LIMIT=10 ARXIV_HYDRATION_RECOVER_MAX_ATTEMPTS=3 node --env-file=.env scripts/arxiv-hydration-recover.ts
//
// Only a successful refetch resolves an exception; a failure keeps it open and counts the attempt.
// The entry shares the collection job's durable gate, so it never runs next to a collection, never
// probes arXiv while the HTTP429 hold is active, and honours the collection switches.
import { closeDb } from "@aihot/backend/db";
import { refetchHydrationExceptions } from "@aihot/backend/arxiv/hydration";

const limit = Number(process.env.ARXIV_HYDRATION_RECOVER_LIMIT ?? "25");
const maxAttempts = Number(process.env.ARXIV_HYDRATION_RECOVER_MAX_ATTEMPTS ?? "5");

try {
  const result = await refetchHydrationExceptions({ limit, maxAttempts });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "disabled") {
    console.error("arXiv collection is switched off (COLLECT_ENABLED / ARXIV_NATIVE_COLLECT_ENABLED); nothing was refetched.");
    process.exitCode = 1;
  }
  // A failed attempt is counted and the exception stays open; a non-zero exit makes that visible to
  // whatever ran the entry instead of reporting a silent success.
  if (result.status === "failed") process.exitCode = 1;
} finally {
  // A thrown refetch (a lost lease, a rolled-back batch) must still release the pool: without the
  // finally the process would hang until the database drops the sockets.
  await closeDb();
}
