// Synthetic showcase data: a handful of demo rows so a blank database can render a populated
// homepage, topic pages and the imagery card for screenshots and manual UI checks.
//
// Everything here is written by this project. Titles carry an explicit demo marker, summaries say
// they are synthetic, and the imagery illustration is a geometric placeholder drawn by this project
// (`database/demo/imagery/`) — never a third-party photograph, a real APOD item or a real report.
// No model is called and no upstream source is fetched.
//
//   node --env-file=.env scripts/demo-showcase.ts           # insert (idempotent)
//   node --env-file=.env scripts/demo-showcase.ts --clean   # remove exactly these rows
//
// The imagery card additionally needs IMAGERY_ENABLED=true; the other rows show up either way.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const SOURCE_ID = "demo-showcase";
/** sha256 of the shipped placeholder PNG; also its filename under the data directory's `imagery/`. */
const IMAGERY_KEY = "419698e8eef07c12d0931f87ef7ca9d3675c95e28f472028112824078936ba70";
const IMAGERY_FILE = path.join(REPO_ROOT, "database/demo/imagery", IMAGERY_KEY);

interface DemoItem {
  id: string;
  title: string;
  original: string;
  summary: string;
  reason: string;
  category: string;
  tags: string[];
  hoursAgo: number;
  score: number;
}

// Tags are the industry pack's own topic tags, so the rows also land on real topic pages:
// 系外行星 → /topics/exoplanets, 望远镜/巡天 → /topics/missions, 黑洞 → /topics/black-holes.
const ITEMS: DemoItem[] = [
  {
    id: "demo-news-0001",
    title: "【演示数据】示例条目：某巡天项目公布合成演示成果",
    original: "[Demo data] Synthetic example: a survey project publishes a demo result",
    summary: "这是一条合成演示条目，用于展示首页与主题页的版式；它不代表任何真实机构、任务或研究成果。",
    reason: "合成演示：说明该条目为何会进入精选，仅用于界面展示。",
    category: "planets-solar-system",
    tags: ["系外行星"],
    hoursAgo: 3,
    score: 72,
  },
  {
    id: "demo-news-0002",
    title: "【演示数据】示例条目：合成行星大气模型的参数讨论",
    original: "[Demo data] Synthetic example: parameter discussion for a demo planetary-atmosphere model",
    summary: "合成演示摘要：本条用于填充主题页列表，文字由本项目自行编写，不引用任何真实论文或报道。",
    reason: "合成演示：仅用于界面展示，不代表真实筛选结论。",
    category: "planets-solar-system",
    tags: ["系外行星"],
    hoursAgo: 8,
    score: 66,
  },
  {
    id: "demo-news-0003",
    title: "【演示数据】示例条目：合成望远镜的调试进展说明",
    original: "[Demo data] Synthetic example: commissioning note for a demo telescope",
    summary: "合成演示摘要：用于展示「望远镜、任务与数据」分类下的卡片样式。",
    reason: "合成演示：仅用于界面展示，不代表真实工程进展。",
    category: "observatories-data",
    tags: ["望远镜", "巡天"],
    hoursAgo: 14,
    score: 64,
  },
  {
    id: "demo-news-0004",
    title: "【演示数据】示例条目：合成致密天体观测的方法学笔记",
    original: "[Demo data] Synthetic example: a method note on demo compact-object observations",
    summary: "合成演示摘要：用于展示「恒星、黑洞与暂现源」分类下的卡片样式。",
    reason: "合成演示：仅用于界面展示，不代表真实观测结论。",
    category: "stars-transients",
    tags: ["黑洞"],
    hoursAgo: 20,
    score: 63,
  },
  {
    id: "demo-news-0005",
    title: "【演示数据】示例条目：合成图像发布的版式占位说明",
    original: "[Demo data] Synthetic example: layout placeholder note for a demo image release",
    summary: "合成演示摘要：用于展示「图像与科普」分类下的卡片样式，不含任何真实图片。",
    reason: "合成演示：仅用于界面展示，不代表真实图像发布。",
    category: "outreach-images",
    tags: ["图像发布", "科普"],
    hoursAgo: 26,
    score: 61,
  },
];

const clean = process.argv.includes("--clean");

if (clean) {
  await sql`DELETE FROM publications WHERE article_id LIKE 'demo-news-%'`;
  await sql`DELETE FROM articles WHERE id LIKE 'demo-news-%' AND source_id = ${SOURCE_ID}`;
  await sql`DELETE FROM imagery_archive WHERE source = 'nasa-apod' AND local_path = ${IMAGERY_KEY}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE_ID}`;
  console.log("demo showcase data removed");
} else {
  if (!existsSync(IMAGERY_FILE)) throw new Error(`placeholder image missing: ${IMAGERY_FILE}`);

  // Disabled and never fetched: the row exists only so the demo publications have a source to join.
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, first_party, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, health)
    VALUES (${SOURCE_ID}, '合成演示来源', 'rss', ${sql.json({ url: "https://example.invalid/demo-showcase.xml", note: "synthetic demo source; never fetched" } as never)},
            'T2', false, 'editorial', 1440, ${["演示数据"]}, false, false, false, 'paused')
    ON CONFLICT (id) DO NOTHING`;

  for (const it of ITEMS) {
    const url = `https://example.invalid/demo/${it.id}`;
    await sql`
      INSERT INTO articles (id, source_id, identity_key, url, title, language, discovered_at, timeline_at, body_status, excerpt)
      VALUES (${it.id}, ${SOURCE_ID}, ${it.id}, ${url}, ${it.title}, 'zh',
              now() - make_interval(hours => ${it.hoursAgo}), now() - make_interval(hours => ${it.hoursAgo}), 'none', ${it.summary})
      ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO publications (article_id, revision, visibility, eligible, selected, title, original_title, summary, reason,
        category, tags, score, source_id, channel, first_party, url, published_at, discovered_at, timeline_at, backfill,
        selected_ready_at, visible_after, body_mode, syndicate, indexable, search_text, sort_at, seat, selection_candidate)
      VALUES (${it.id}, 1, 'public', true, true, ${it.title}, ${it.original}, ${it.summary}, ${it.reason},
        ${it.category}, ${it.tags}, ${it.score}, ${SOURCE_ID}, 'news', false, ${url},
        now() - make_interval(hours => ${it.hoursAgo}), now() - make_interval(hours => ${it.hoursAgo}), now() - make_interval(hours => ${it.hoursAgo}), false,
        now() - make_interval(hours => ${it.hoursAgo}), now() - interval '1 minute', 'summary', false, false, ${`${it.title} ${it.summary}`},
        now() - make_interval(hours => ${it.hoursAgo}), true, false)
      ON CONFLICT (article_id) DO NOTHING`;
  }

  // One archive row whose media is a locally-served placeholder. translation_status is 'ready' so the
  // card shows the Chinese title, mirroring the normal "media and translation both landed" state.
  await sql`
    INSERT INTO imagery_archive (source, source_date, metadata, content_hash, title_zh, explanation_zh, local_path, content_type, translation_status, media_status)
    SELECT 'nasa-apod', d::date,
      jsonb_build_object(
        'source', 'nasa-apod',
        'sourceDate', to_char(d, 'YYYY-MM-DD'),
        'sourceId', 'demo-synthetic-placeholder',
        'titleEn', '[Demo data] Author-made geometric placeholder (not an APOD image)',
        'explanationEn', 'Synthetic demo record written for this release: the illustration is a geometric placeholder drawn by this project, not a NASA APOD image and not a translation of one.',
        'credit', 'Synthetic demo placeholder drawn by this project',
        'copyright', NULL,
        'sourceUrl', 'https://example.invalid/demo/imagery',
        'mediaType', 'image',
        'imageUrl', NULL,
        'mediaUrl', NULL,
        'altEn', 'Abstract concentric rings drawn for the demo; not a real astronomical photograph.'
      ),
      ${IMAGERY_KEY}, '【演示数据】自制几何占位图（非 NASA 影像）',
      '合成演示：这是本项目自制的几何占位图与自写说明，用于展示影像卡与详情版式，不是 NASA APOD 的真实影像或译文。',
      ${IMAGERY_KEY}, 'image/png', 'ready', 'ready'
    FROM (SELECT (current_date - 1) AS d) x
    ON CONFLICT (source, source_date) DO NOTHING`;

  // The media route reads <AIHOT_DATA_DIR>/imagery/<key>, so the file must exist there too.
  const directory = path.join(config.dataDir, "imagery");
  mkdirSync(directory, { recursive: true });
  copyFileSync(IMAGERY_FILE, path.join(directory, IMAGERY_KEY));
  console.log(`demo showcase data ready: ${ITEMS.length} publications, imagery ${IMAGERY_KEY} -> ${directory}`);
}

await closeDb();
