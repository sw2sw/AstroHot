export type ImageryViewItem = {
  source: string;
  sourceDate: string;
  titleEn: string;
  titleZh: string | null;
  explanationEn: string;
  explanationZh: string | null;
  credit: string;
  copyright: string | null;
  creditLinks?: {label: string; url: string}[];
  copyrightLinks?: {label: string; url: string}[];
  sourceUrl: string;
  mediaType: "image" | "video" | "iframe";
  imageUrl: string | null;
  mediaUrl: string | null;
  altEn: string | null;
  translationStatus: "pending" | "ready" | "failed";
  mediaStatus: "pending" | "ready" | "failed" | "not_applicable";
};
