// Read-only view of the operational failures recorded in ops_error_events.
//
//   node --env-file=.env scripts/ops-errors.ts --since 2026-10-01T00:00:00Z --until 2026-10-09T00:00:00Z
//   node --env-file=.env scripts/ops-errors.ts --since 2026-10-09T00:00:00Z --format markdown --stage arxiv.collect
//   node --env-file=.env scripts/ops-errors.ts --since 2026-10-09T00:00:00Z --limit 20 --offset 20
//
// It only ever reads. No collection, analysis, recovery, digest or receipt is triggered, no claim,
// retry counter, budget or pause is modified, and no original response or provider answer is printed.
// An empty window means "nothing was recorded here" — it does NOT mean the whole system is healthy.
import { closeDb } from "@aihot/backend/db";
import { queryOpsErrors, renderOpsErrorReport } from "@aihot/backend/operations/error-report";
import { sanitizeOpsMessage } from "@aihot/backend/operations/error-events";

function isoUtc(value: string, label: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error(`${label} must be an ISO-8601 instant`);
  return new Date(at).toISOString();
}

function intArg(value: string, label: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return parsed;
}

const argv = process.argv.slice(2);
const now = new Date();
let since: string | undefined;
let until: string | undefined;
let stage: string | null = null;
let format: "json" | "markdown" = "json";
let limit = 100;
let offset = 0;

try {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Unknown flags FAIL loudly: a mistyped filter silently widening the query is worse than an
    // aborted lookup.
    if (!["--since", "--until", "--stage", "--format", "--limit", "--offset"].includes(arg)) {
      throw new Error(`unknown argument: ${arg} (supported: --since --until --stage --format --limit --offset)`);
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    i += 1;
    if (arg === "--since") since = isoUtc(value, "--since");
    else if (arg === "--until") until = isoUtc(value, "--until");
    else if (arg === "--stage") stage = value;
    else if (arg === "--limit") limit = intArg(value, "--limit", 1);
    else if (arg === "--offset") offset = intArg(value, "--offset", 0);
    else if (arg === "--format") {
      if (value !== "json" && value !== "markdown") throw new Error("--format must be json or markdown");
      format = value;
    }
  }
  const report = await queryOpsErrors({
    since: since ?? new Date(now.getTime() - 24 * 3600_000).toISOString(),
    until: until ?? now.toISOString(),
    stage,
    limit,
    offset,
  });
  console.log(format === "markdown" ? renderOpsErrorReport(report) : JSON.stringify(report, null, 2));
} catch (error) {
  // Even the error path honors the redaction rules: a driver message can carry a DSN.
  console.error(`ops-errors: ${sanitizeOpsMessage(String(error instanceof Error ? error.message : error))}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
