-- Academic conferences discovered from ordinary ingestion: one row per event, plus the notices that
-- announced it. The event is a separate identity from the articles that report it — a conference is
-- never a second copy of a notice, and several notices (a call for abstracts, then a programme, then a
-- venue change) point at one event without duplicating it.
--
-- Why two tables: 会议身份（会名/届次/会期，用于去重、改期、人工修正）与通知身份（具体文章 revision、
-- 原文证据）是两件事。一条通知只能属于一个会议（conference_notices.article_id 唯一），一个会议可以有
-- 多条通知。把两者合成一张表会让"同会多通知"必须复制会名日期，或让"一条通知改判"删掉整个会议。
--
-- Fields an automatic projection may update are overwritten by a later notice (a postponement changes the
-- dates); fields a human set are listed in manual_fields and are never overwritten or cleared by the
-- pipeline. version is the CAS token for those manual corrections.
--
-- Rollback (see deployment-plan.md §2): additive only. Reverting the code leaves both tables unread; they
-- can stay. Dropping them loses the discovery record but no existing article, publication, analysis,
-- receipt, override or ledger entry.
CREATE TABLE conferences (
  id bigserial PRIMARY KEY,
  -- 规范化的身份串：会名规范化 | 届次规范化 | 开幕日。唯一约束就是去重的最后一道闸门。
  identity_key text NOT NULL UNIQUE,
  name text NOT NULL,
  name_norm text NOT NULL,
  edition text,
  start_date date,
  end_date date,
  -- 只有原文写明时才填；没有证据就是 null（不假定会场或北京时区）。
  timezone text,
  city text,
  venue text,
  online boolean,
  organizer text,
  official_url text,
  registration_url text,
  -- [{kind, date, quote}]：date-only，不把未知时刻假设成午夜。
  deadlines jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 展示方向：通知文章所属栏目的并集。它只决定在哪个栏目可见，不授予新闻精选或跨列权限。
  domain text NOT NULL DEFAULT 'astro' CHECK (domain IN ('astro', 'ai4s', 'both')),
  -- 人工状态：改期/取消只能由人工写明，普通时钟状态不得覆盖。
  schedule_status text NOT NULL DEFAULT 'scheduled' CHECK (schedule_status IN ('scheduled', 'cancelled', 'postponed')),
  -- 人工设定过的字段名数组：自动投影跳过它们。
  manual_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 同会名 + 同开幕日 / 同届次 的身份查找（改期后 identity_key 不变，靠这两列收敛）。
CREATE INDEX conferences_name_norm_idx ON conferences (name_norm, start_date);

CREATE TABLE conference_notices (
  conference_id bigint NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  -- 投影时的文章 revision：修订改判时据此撤回。
  revision integer NOT NULL,
  content_scope text NOT NULL CHECK (content_scope IN ('astro', 'ai4s')),
  -- 判定为通知的原文逐字片段。
  evidence text NOT NULL,
  deadlines jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conference_id, article_id)
);
-- 一条通知只属于一个会议：一篇文章不会被算进两个会议。
CREATE UNIQUE INDEX conference_notices_article_idx ON conference_notices (article_id);
