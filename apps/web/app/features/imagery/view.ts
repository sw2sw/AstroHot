import type { ImageryViewItem } from "./types.ts";

// The API only serves cached imagery at this exact address shape; remote hosts, protocol-relative,
// data:, traversal, query strings and wrong length/charset never reach an <img>.
const MEDIA_IMAGE_PATTERN = /^\/api\/imagery\/media\/[0-9a-f]{64}$/;

/** Local media URL that may be rendered, or null when the entry must not show an <img>. */
export function safeImageUrl(
  item: Pick<ImageryViewItem, "mediaType" | "mediaStatus" | "imageUrl">,
): string | null {
  if (item.mediaType !== "image" || item.mediaStatus !== "ready") return null;
  return item.imageUrl !== null && !/[\r\n]/.test(item.imageUrl) && MEDIA_IMAGE_PATTERN.test(item.imageUrl) ? item.imageUrl : null;
}

/** NASA sometimes labels a featured-video still as an image; incidental video mentions are not evidence. */
export function videoMediaNote(item: ImageryViewItem): string | null {
  if (item.source !== "nasa-apod") return null;
  const explicitVideo = /(?:^|[.!?]\s+)\s*(?:Explanation:\s*)?the\s+featured\s+video\b/i.test(item.explanationEn);
  let embeddedVideo = false;
  if (item.mediaType === "iframe" && item.mediaUrl) {
    try {
      const media = new URL(item.mediaUrl);
      embeddedVideo = media.protocol === "https:" && (/(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com)$/.test(media.hostname) || /\.(?:mp4|webm|m4v|mov)$/i.test(media.pathname));
    } catch { /* An unknown embed is not evidence of video. */ }
  }
  if (item.mediaType !== "video" && !explicitVideo && !embeddedVideo) return null;
  return safeImageUrl(item) ? "视频截图，原视频请看 " : "本期为视频，原视频请看 ";
}

/** Only absolute https URLs without embedded credentials may link to the original source. */
export function safeSourceUrl(sourceUrl: string): string | null {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
    return sourceUrl;
  } catch {
    return null;
  }
}

/**
 * Status line for the Chinese translation. "AI 翻译" appears only when Chinese text actually
 * exists; a ready status without text, a pending run or a failure all fall back to honest labels.
 */
export function translationLabel(
  item: Pick<ImageryViewItem, "translationStatus" | "titleZh" | "explanationZh">,
): string {
  if (item.translationStatus === "ready" && (Boolean(item.titleZh?.trim()) || Boolean(item.explanationZh?.trim()))) {
    return "AI 翻译";
  }
  return item.translationStatus === "failed" ? "中文翻译暂不可用" : "中文翻译待完成";
}

/** 首页短介绍不代替详情全文；中文未完成时保留英文。 */
export function imagerySynopsis(item: Pick<ImageryViewItem, "translationStatus" | "explanationZh" | "explanationEn">): string {
  const text = (item.translationStatus === "ready" && item.explanationZh?.trim() ? item.explanationZh : item.explanationEn).trim().replace(/\s+/g, " ");
  const chars = Array.from(text);
  return chars.length > 120 ? chars.slice(0, 119).join("") + "…" : text;
}

export function birthdayOutcome(result: {item: ImageryViewItem | null; status: string}) {
  return {item: result.item, notice: result.item
    ? result.status === "pending" ? "英文内容已就绪，图片或中文说明仍在准备。" : ""
    : result.status === "pending" ? "这一天的影像正在准备，请稍后重试。" : "暂未找到这一天的影像，请稍后重试。"};
}

/** Compact note for entries without a renderable image; video and iframe entries stay unembedded. */
export function mediaPlaceholder(item: Pick<ImageryViewItem, "mediaType">): string {
  return item.mediaType === "image" ? "图片暂不可用" : "视频或互动内容，请到原文查看";
}
