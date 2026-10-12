import { z } from "zod";

const ImageSuitabilitySchema = z.object({
  approved: z.boolean(),
  category: z.enum(["related", "ad", "logo", "avatar", "decorative", "unrelated", "uncertain"]),
  reason: z.string().trim().min(1).max(400),
  depiction: z.enum(["observation", "artist_concept", "diagram", "uncertain"]).optional(),
});
export type ImageReview = z.infer<typeof ImageSuitabilitySchema> & {
  status: "missing" | "invalid" | "approved" | "image-rejected" | "no-vision" | "download-failed" | "provider-rejected" | "rights-unverified";
  suitabilityStatus?: "approved";
  rightsStatus?: "verified" | "unverified";
  license?: string; licenseUrl?: string; canonicalUrl?: string;
  url: string; credit?: string; caption?: string; attributionUrl?: string;
};

/** Validate the image independently: keep valid text, never request a paid repair. */
export function reviewFirstImage(url: string, value: unknown): ImageReview {
  const parsed = ImageSuitabilitySchema.safeParse(value);
  if (!parsed.success) return {
    url, status: value === undefined ? "missing" : "invalid", approved: false, category: "uncertain",
    reason: value === undefined ? "首图审核未完成：缺少 imageSuitability；保留文本，不自动重试" : "首图审核未完成：imageSuitability 格式无效；保留文本，不自动重试",
  };
  const approved = parsed.data.approved && parsed.data.category === "related";
  return { ...parsed.data, url, approved, status: approved ? "approved" : "image-rejected" };
}
