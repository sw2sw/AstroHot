// One bounded read of the candidate journal feeds through the site's own RSS reader, for the
// implementation review of the "journal summary intro" work: what the real bytes parse to (RDF vs
// RSS 2.0), which items the configured filters keep or drop, how much of each item's text the feed
// itself gives, the source's own date precision, and what kind of item each entry is.
//
// It writes nothing, calls no model and touches no source row: it only reads public feeds.
//   DATABASE_URL=postgres://…/_test node scripts/journal-feed-probe.ts [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { contentKindOf, datePrecisionOf } from "@aihot/backend/content/coverage";
import { fetchRss } from "@aihot/backend/sources/rss";
import { noiseFiltered } from "@aihot/backend/sources/collect";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";

const outFile = process.argv[2];
const pack = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as {
  sources: Array<Partial<SourceRow> & { id: string; config: Record<string, unknown> }>;
};
const candidates = pack.sources.filter((s) => s.id.startsWith("rss-journal-"));

const tally = <T extends string>(values: T[]) =>
  values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

const report: Array<Record<string, unknown>> = [];
for (const entry of candidates) {
  const source = {
    id: entry.id, name: entry.name ?? entry.id, kind: "rss", config: entry.config,
    tier: entry.tier ?? "T2", participation_mode: entry.participation_mode ?? "editorial",
    first_party: false, interval_minutes: 1440, enabled: false, cursor: null, fail_count: 0,
  } as unknown as SourceRow;
  const feedUrl = String(entry.config.feedUrl);
  try {
    const read = await fetchRss(source, { force: true });
    const kept = read.candidates.filter((c) => !noiseFiltered(c, source));
    const dropped = read.candidates.filter((c) => noiseFiltered(c, source));
    const shape = (c: Candidate) => ({
      title: c.title,
      contentKind: contentKindOf(c.url, c.categories ?? []),
      coverage: c.coverage ?? null,
      datePrecision: (c.raw as { datePrecision?: string } | undefined)?.datePrecision ?? null,
      categories: c.categories ?? [],
    });
    const rawPrecision = (c: Candidate) => (c.raw as { datePrecision?: string } | undefined)?.datePrecision ?? "instant";
    report.push({
      id: entry.id,
      feedUrl,
      status: "ok",
      found: read.candidates.length,
      kept: kept.length,
      droppedByConfig: dropped.length,
      droppedExamples: dropped.slice(0, 3).map(shape),
      keptExamples: kept.slice(0, 4).map(shape),
      coverage: tally(kept.map((c) => c.coverage ?? "none")),
      bodyStatus: tally(kept.map((c) => c.bodyStatus ?? "none")),
      datePrecision: tally(read.candidates.map(rawPrecision)),
      contentKind: tally(kept.map((c) => contentKindOf(c.url, c.categories ?? []))),
      withOfficialAbstract: kept.filter((c) => c.coverage === "official_abstract").length,
      withBodyText: kept.filter((c) => c.bodyText).length,
      dayPrecisionTitles: read.candidates.filter((c) => rawPrecision(c) === "day").slice(0, 3).map((c) => c.title),
    });
  } catch (error) {
    report.push({ id: entry.id, feedUrl, status: "failed", error: String(error instanceof Error ? error.message : error).slice(0, 200) });
  }
  console.log(JSON.stringify(report[report.length - 1]));
}

if (outFile) writeFileSync(outFile, `${JSON.stringify({ checkedAt: new Date().toISOString(), report }, null, 2)}\n`);
await closeDb();
