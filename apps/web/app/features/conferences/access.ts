import type { ConferenceSummary } from "@aihot/contracts/site";

// Editorial map for first-party notices that were verified by hand. Entries are deployment-local:
// key on the notice's verified official URL and update them as a conference publishes new access
// details. Never infer a conference website from an ordinary news article URL.
const verifiedNotices = {
  "https://nadc.china-vo.org/events/cvo2026/": {
    registrationUrl: "https://nadc.china-vo.org/events/cvo2026/myregister",
    registrationInfo: "在线注册，可现场缴费",
  },
  "https://panshi-forum.tashan.ac.cn/": {
    registrationUrl: "https://panshi-forum.tashan.ac.cn/register",
    registrationInfo: "在线注册，线下参会",
    submissionUrl: "https://panshi-forum.tashan.ac.cn/submit",
    submissionInfo: "在线投稿：学术报告提交 Word 摘要；创新实践提交介绍和链接或附件。",
    submissionCutoff: "2026-11-15 24:00（官网原文）",
  },
} satisfies Record<string, { registrationUrl: string; registrationInfo: string; submissionUrl?: string; submissionInfo?: string; submissionCutoff?: string }>;

type VerifiedAccess = { registrationUrl?: string; registrationInfo?: string; submissionUrl?: string; submissionInfo?: string; submissionCutoff?: string };

function webUrl(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function conferenceAccess(item: ConferenceSummary) {
  const official = webUrl(item.officialUrl);
  const notice = webUrl(item.notice?.url);
  const key = official ?? notice;
  const entry: VerifiedAccess | undefined = key && Object.hasOwn(verifiedNotices, key) ? verifiedNotices[key as keyof typeof verifiedNotices] : undefined;
  return {
    officialUrl: official ?? (entry ? key : null),
    registrationUrl: webUrl(item.registrationUrl) ?? entry?.registrationUrl ?? null,
    registrationInfo: entry?.registrationInfo ?? null,
    submissionUrl: entry?.submissionUrl ?? null,
    submissionInfo: entry?.submissionInfo ?? null,
    submissionCutoff: entry?.submissionCutoff ?? null,
  };
}
