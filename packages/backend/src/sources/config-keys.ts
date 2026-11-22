// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";

// Rules applied in collect.ts to every kind read through collectSource.
const PUBLISHER = ["publisherRole", "publisherUrlPrefixes"];
const COLLECTED = [...PUBLISHER, "cardImageAllowed", "cardImageRequiresCredit", "_aihot", "allowUrlPrefixes", "allowUrlRegex", "denyUrlPrefixes", "ingestNoiseFilter", "itemUrlPrefixRewrite", "sortByPublishedAt", "detail", "fetchPublicContent", "contentScope"];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "summaryIsBody", "preserveUrlFragment", "allowCategories", "denyCategories", "sharedPrefilter"],
  web_list: [
    ...COLLECTED, "url", "baseUrl", "parseMode", "adapter", "cacheToleranceSeconds", "linksStartLine", "preserveUrlFragment",
    "itemSelector", "linkSelector", "titleSelector", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset",
    "sharedPrefilter", "supplementaryUrl", "supplementaryItemSelector",
  ],
  json_list: [
    ...COLLECTED, "url", "mode", "method", "headers", "bodyJson", "jsonKey", "windowVar", "itemsPath", "itemsObjectValues",
    "titlePaths", "summaryPaths", "summaryIsBody", "authorPaths", "publishedAtPath", "publishedAtUnit", "externalIdPath",
    "urlTemplate", "urlTemplateFallback", "rawDropKeys", "requireBoolean", "minNumeric",
  ],
  // X accounts are mostly read in shards, which apply only these.
  x_search: [...PUBLISHER, "_aihot", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType"],
  mp_account: [...PUBLISHER, "wxid", "ghid", "nickname"],
  external: [...PUBLISHER],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  _aihot: ["initialBackfillLimit", "initialBackfillMonths", "initialUrlAllowlist", "initialNotBefore"],
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches"],
  itemUrlPrefixRewrite: ["from", "to"],
  requireBoolean: ["path", "equals"],
  minNumeric: ["path", "min"],
  detail: [
    "maxFetches", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset", "publishedAtAuthoritative", "preserveListingDate", "upgradeDatePrecision",
    "titleSelector", "titleRegex", "titleAuthoritative", "summarySelector",
  ],
};

const VALUES: Record<string, string[]> = {
  publisherRole: ["organization", "person"],
  adapter: ["mimo_home", "anthropic_science"],
  parseMode: ["html", "markdown", "docusaurus_changelog"],
  contentScope: ["astro", "ai4s"],
};

/** A first-import URL allowlist entry: an http(s) address without credentials. */
function isAllowlistUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password; } catch { return false; }
}

/** The config entries a source of this kind would ignore or cannot run, e.g. ["adapter=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if ((key === "cardImageAllowed" || key === "cardImageRequiresCredit") && typeof value !== "boolean") out.push(key);
    else if (key === "publisherUrlPrefixes" && (!Array.isArray(value) || !value.every((v) => {
      if (typeof v !== "string") return false;
      try { const u = new URL(v); return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
    }))) out.push(key);
    else if (VALUES[key] && !VALUES[key]!.includes(String(value))) out.push(`${key}=${String(value)}`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
        else if (key === "_aihot" && sub === "initialUrlAllowlist" && (!Array.isArray(subValue) || !subValue.every(isAllowlistUrl))) out.push(`${key}.${sub}`);
        else if (key === "_aihot" && sub === "initialNotBefore" && (typeof subValue !== "string" || Number.isNaN(Date.parse(subValue)))) out.push(`${key}.${sub}`);
      }
    }
  }
  return out;
}

export class UnsupportedConfig extends Error {
  readonly statusCode = 400;
}

/** Refuses a config with entries its kind does not implement (admin create, edit and preview). */
export function assertSupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): void {
  const bad = unsupportedConfig(kind, config);
  if (bad.length) throw new UnsupportedConfig(`不支持的配置项：${bad.join("、")}`);
}
