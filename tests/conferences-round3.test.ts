// The round-3 review findings, pinned where they broke: the year a date is allowed to use, and the
// moment a notice's claim is treated as having been made.
//
// C1 a notice's own publication year was used to fill in a date the text left without a year. A
//    December notice for a meeting "on 12 January" then became a meeting that ended eleven months ago,
//    while the year it probably meant was thrown away. The publication year is not evidence of when
//    the meeting is; only a year the notice writes for this event is.
// C2 the "statement time" of a correction was `greatest(publication, notice.updated_at)`, and the
//    notice row is refreshed by every projection. A correction analysed late — or projected twice —
//    therefore outranked a genuinely newer statement. Ordering now uses the revision's own record,
//    which is written once and never moves.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { projectConference } from "@aihot/backend/content/conferences";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadConferenceHub } from "@aihot/backend/publication/conferences";
import { conferenceIdentityKey, type GroundedConference } from "@aihot/backend/editorial/conference";

const T = tag();
const SRC = `test-round3-${T}`;
/** A fixed reading instant, the same one the other conference files use. */
const NOW = new Date("2026-11-17T04:00:00Z");
let n = 0;

type Notice = { articleId: string; url: string; name: string; edition: string; conferenceId: number };

type Seed = {
  name: string;
  edition?: string | null;
  start: string;
  end?: string | null;
  deadline: string;
  /** The source's own publication time. */
  publishedAt: string;
};

const conference = (s: { name: string; edition: string | null; start: string; end?: string | null; deadline: string }, articleId: string): GroundedConference => ({
  name: s.name, edition: s.edition ?? null, startDate: s.start, endDate: s.end ?? s.start, timezone: null,
  city: null, venue: null, online: false, organizer: null, officialUrl: null, registrationUrl: null,
  deadlines: [{ kind: "registration", date: s.deadline, quote: `报名截止${s.deadline}` }],
  evidence: `${s.name}现开放报名`, nameNorm: s.name.toLowerCase(),
  identityKey: conferenceIdentityKey({ name: s.name, edition: s.edition ?? null, startDate: s.start }, articleId),
});

/** One notice: the material a source reported, published, and its first projection. */
async function seedNotice(s: Seed): Promise<Notice> {
  n += 1;
  const url = `https://example.org/round3-${T}-${n}`;
  const body = `${s.name}现开放报名，报名截止${s.deadline}。`;
  const { articleId } = await upsertMaterial({
    sourceId: SRC, url, title: `会议通知 ${n}`, bodyText: body, bodyStatus: "ok", coverage: "full_text",
    via: "ingest", contentScope: "astro", publishedAt: new Date(s.publishedAt),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'outreach-images', ${["学术会议"]}, ${`会议通知 ${n}`}, ${body}, false, ${sql.json({ scope: "single" } as never)})`;
  await publishArticle(articleId);
  const conferenceId = await sql.begin((tx) => projectConference(tx, {
    articleId, revision: 1, contentScope: "astro", conference: conference({ ...s, edition: s.edition ?? null }, articleId),
  }));
  return { articleId, url, name: s.name, edition: s.edition ?? "", conferenceId: conferenceId! };
}

/**
 * A new revision of the same notice, as the source would report it, with the time that revision really
 * appeared — which is not the time this test happens to run, and is what the ordering must follow.
 */
async function reviseNotice(notice: Notice, s: { deadline: string; statedAt: string; start: string; end?: string | null }): Promise<number> {
  const body = `${notice.name}现开放报名，报名截止${s.deadline}（已更新）。`;
  await upsertMaterial({
    sourceId: SRC, url: notice.url, title: "会议通知（更新）", bodyText: body, bodyStatus: "ok",
    coverage: "full_text", via: "ingest", contentScope: "astro",
  });
  const [{ revision }] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${notice.articleId}`;
  // `article_revisions` is written once per revision and never refreshed — unlike the notice row, whose
  // updated_at every projection moves. This is the statement's own time.
  await sql`UPDATE article_revisions SET created_at = ${new Date(s.statedAt)}
             WHERE article_id = ${notice.articleId} AND revision = ${revision}`;
  await sql`UPDATE articles SET source_updated_at = NULL WHERE id = ${notice.articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, selected, output)
            VALUES (${notice.articleId}, ${revision}, 'rule', 'pass', 'outreach-images', ${["学术会议"]}, ${"会议通知（更新）"}, ${body}, false, ${sql.json({ scope: "single" } as never)})`;
  await publishArticle(notice.articleId);
  return revision!;
}

/** The projection step, which in production runs whenever that article's analysis finishes. */
async function projectNotice(notice: Notice, s: { deadline: string; start: string; end?: string | null }): Promise<void> {
  const [{ revision }] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${notice.articleId}`;
  await sql.begin((tx) => projectConference(tx, {
    articleId: notice.articleId, revision: revision!, contentScope: "astro",
    conference: conference({ ...s, name: notice.name, edition: notice.edition || null }, notice.articleId),
  }));
}

const storedDeadlines = async (id: number) =>
  (await sql<{ deadlines: Array<{ kind: string; date: string | null }> }[]>`SELECT deadlines FROM conferences WHERE id = ${id}`)[0]!.deadlines;
const hubDeadlines = async (id: number) =>
  (await loadConferenceHub({ scope: "all", now: NOW })).items.find((c) => c.id === id)!.deadlines;
const noticeRow = async (articleId: string) =>
  (await sql<{ updated_at: Date }[]>`SELECT updated_at FROM conference_notices WHERE article_id = ${articleId}`)[0]!;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SRC}, '会议三轮复审源', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(closeDb);

// —— C2: the statement's own time decides, not when we happened to process it ——————————————————

test("C2 a correction analysed late cannot outrank a statement made after it", async () => {
  const a = await seedNotice({
    name: "第12届时序证据研讨会", edition: "第12届", start: "2027-04-01", deadline: "2027-01-10",
    publishedAt: "2026-11-10T02:00:00Z",
  });
  // The correction itself appeared on 16 November.
  await reviseNotice(a, { deadline: "2027-02-01", statedAt: "2026-11-16T02:00:00Z", start: "2027-04-01" });
  // A newer notice, published on the 17th, states a later deadline.
  const b = await seedNotice({
    name: "第12届时序证据研讨会", edition: "第12届", start: "2027-04-01", deadline: "2027-03-01",
    publishedAt: "2026-11-17T02:00:00Z",
  });
  assert.equal(b.conferenceId, a.conferenceId, "the same event, not a second row");
  // Only now does the late analysis project the 16 November correction — after the newer statement.
  await projectNotice(a, { deadline: "2027-02-01", start: "2027-04-01" });

  assert.deepEqual((await storedDeadlines(a.conferenceId)).map((d) => [d.kind, d.date]), [["registration", "2027-03-01"]],
    "the statement from the 17th still wins, because handling the 16 November revision late is not a new claim");
  assert.deepEqual((await hubDeadlines(a.conferenceId)).map((d) => [d.kind, d.date]), [["registration", "2027-03-01"]]);
});

test("C2 re-projecting the same revision does not promote it", async () => {
  const a = await seedNotice({
    name: "第13届时序证据研讨会", edition: "第13届", start: "2027-05-01", deadline: "2027-01-10",
    publishedAt: "2026-11-10T02:00:00Z",
  });
  await reviseNotice(a, { deadline: "2027-02-01", statedAt: "2026-11-16T02:00:00Z", start: "2027-05-01" });
  await projectNotice(a, { deadline: "2027-02-01", start: "2027-05-01" });
  await seedNotice({
    name: "第13届时序证据研讨会", edition: "第13届", start: "2027-05-01", deadline: "2027-03-01",
    publishedAt: "2026-11-17T02:00:00Z",
  });

  const before = (await noticeRow(a.articleId)).updated_at;
  // A replay of the same revision: the notice row is rewritten, so its updated_at moves…
  await new Promise((resolve) => setTimeout(resolve, 15));
  await projectNotice(a, { deadline: "2027-02-01", start: "2027-05-01" });
  const after = (await noticeRow(a.articleId)).updated_at;
  assert.ok(after > before, "the notice row itself was refreshed — which is exactly why it cannot order claims");
  // …and the claim still does not move, because the revision it belongs to did not change.
  assert.deepEqual((await storedDeadlines(a.conferenceId)).map((d) => d.date), ["2027-03-01"]);
  assert.deepEqual((await hubDeadlines(a.conferenceId)).map((d) => d.date), ["2027-03-01"]);
});

test("C2 a genuinely newer revision does take over", async () => {
  const a = await seedNotice({
    name: "第14届时序证据研讨会", edition: "第14届", start: "2027-06-01", deadline: "2027-01-10",
    publishedAt: "2026-11-10T02:00:00Z",
  });
  await seedNotice({
    name: "第14届时序证据研讨会", edition: "第14届", start: "2027-06-01", deadline: "2027-03-01",
    publishedAt: "2026-11-17T02:00:00Z",
  });
  assert.deepEqual((await storedDeadlines(a.conferenceId)).map((d) => d.date), ["2027-03-01"], "the 17 November notice leads");
  // A revision the source reports on the 18th is a newer statement, and it wins.
  await reviseNotice(a, { deadline: "2027-04-01", statedAt: "2026-11-18T02:00:00Z", start: "2027-06-01" });
  await projectNotice(a, { deadline: "2027-04-01", start: "2027-06-01" });
  assert.deepEqual((await storedDeadlines(a.conferenceId)).map((d) => d.date), ["2027-04-01"]);
  assert.deepEqual((await hubDeadlines(a.conferenceId)).map((d) => d.date), ["2027-04-01"]);
});
