// 天文图文元数据的中文翻译：标题与解说，忠实原文，产出归入 imagery_* 收据，由调用方持久化后完成。
import { z } from "zod";
import { chatJson } from "../providers/llm.ts";
import { modelFor } from "../editorial/models.ts";
import { sha256 } from "../lib/ids.ts";

const PROMPT_VERSION = "imagery-translate-v1";

const SYSTEM = `你是严谨的天文内容译者。把给出的英文天文图文标题与解说忠实地翻译成简体中文：只做翻译，不添加、不省略、不改写任何事实；保留所有数字与单位（必要时换算成通行的中文写法）；天体名用通行中文译名，人名与机构名有通行译名就用译名，没有则保留原文。只返回 JSON，字段为 titleZh 和 explanationZh。`;

const outputSchema = z.object({
  titleZh: z.string().trim().min(1).max(300),
  explanationZh: z.string().trim().min(1).max(8000),
});

/** 与 chatJson 兼容的调用签名，测试里注入假实现。 */
type ChatJsonLike = (opts: {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: typeof outputSchema;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<{ data: z.infer<typeof outputSchema>; receiptId: number }>;

export async function translateImagery(
  metadata: { source: string; sourceDate: string; titleEn: string; explanationEn: string },
  options: { model?: string; enabled?: boolean; chatImpl?: ChatJsonLike } = {},
): Promise<{ titleZh: string; explanationZh: string; receiptId: number } | null> {
  const enabled = options.enabled ?? process.env.MODEL_CALLS_ENABLED === "true";
  if (!enabled) return null;
  const model = options.model ?? (await modelFor("translate"));
  const chat: ChatJsonLike = options.chatImpl ?? chatJson;
  const result = await chat({
    model,
    purpose: "imagery_translate",
    subject: `imagery:${metadata.source}:${metadata.sourceDate}@${sha256(JSON.stringify({ titleEn: metadata.titleEn, explanationEn: metadata.explanationEn }))}`,
    promptVersion: PROMPT_VERSION,
    system: SYSTEM,
    user: JSON.stringify({ titleEn: metadata.titleEn, explanationEn: metadata.explanationEn }),
    schema: outputSchema,
    temperature: 0.2,
    maxTokens: 4000,
    timeoutMs: 60_000,
  });
  const parsed = outputSchema.parse(result.data);
  return { titleZh: parsed.titleZh, explanationZh: parsed.explanationZh, receiptId: result.receiptId };
}
