import {useState} from "react";
import type { ImageryViewItem } from "./types.ts";
import { MathText } from "../../components/MathText.tsx";
import { ImageryRights } from "./ImageryRights.tsx";
import { ImageryMediaNote } from "./ImageryMediaNote.tsx";
import { mediaPlaceholder, safeImageUrl, safeSourceUrl, translationLabel, videoMediaNote } from "./view.ts";

export function ImageryDetail({item}: {item: ImageryViewItem}) {
 const imageUrl = safeImageUrl(item);
 const sourceHref = safeSourceUrl(item.sourceUrl);
 const chineseReady = item.translationStatus === "ready" && Boolean(item.explanationZh?.trim());
 const [language,setLanguage] = useState<"zh"|"en"|"both">(chineseReady ? "zh" : "en");
 return <article className="min-w-0 [overflow-wrap:anywhere]">
  {imageUrl ? <img src={imageUrl} alt={item.altEn ?? item.titleEn} className="max-h-[70vh] w-full bg-bg-sunk object-contain"/> : <p className="bg-bg-sunk p-8 text-center text-ink-4">{videoMediaNote(item) ? "预览暂不可用" : mediaPlaceholder(item)}</p>}
  <ImageryMediaNote item={item} centered/>
  <div className="mx-auto max-w-4xl space-y-5 px-5 py-6 sm:px-8">
   <p className="num text-sm text-ink-4">{item.sourceDate} · {item.source === "nasa-apod" ? "NASA APOD" : item.source} · {translationLabel(item)}</p>
   <header className="space-y-2">
    <h2 className="text-2xl font-semibold text-ink"><MathText text={item.translationStatus === "ready" && item.titleZh?.trim() ? item.titleZh : item.titleEn} /></h2>
    {item.titleZh?.trim() && <p lang="en" className="text-lg text-ink-3"><MathText text={item.titleEn} /></p>}
   </header>
   {chineseReady && <div aria-label="阅读语言" className="flex gap-2">{([["zh","中文"],["en","English"],["both","双语"]] as const).map(([value,label]) => <button key={value} type="button" onClick={()=>setLanguage(value)} aria-pressed={language===value} className="min-h-11 rounded-full border border-line px-4 text-sm text-ink-2 aria-pressed:bg-accent aria-pressed:text-accent-contrast">{label}</button>)}</div>}
   {!chineseReady && <p role="status" className="text-sm text-ink-3">中文说明尚未完成，先阅读英文原文。</p>}
   {chineseReady && <section lang="zh-CN" hidden={language === "en"} className="space-y-3 border-t border-line pt-5">
    <p className="text-xs text-ink-4">中文 · AI 翻译，以英文原文为准</p>
    <div className="whitespace-pre-wrap text-base leading-8 text-ink-2"><MathText text={item.explanationZh ?? ""} /></div>
   </section>}
   <section lang="en" hidden={chineseReady && language === "zh"} className="space-y-3 border-t border-line pt-5">
    <p className="text-xs text-ink-4">ENGLISH · 原文</p>
    <div className="whitespace-pre-wrap text-base leading-8 text-ink-2"><MathText text={item.explanationEn} /></div>
   </section>
   <footer className="space-y-4 border-t border-line pt-5 text-sm text-ink-4">
    <ImageryRights item={item}/>
    {sourceHref && !videoMediaNote(item) && <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="inline-block min-h-11 text-accent hover:underline">NASA 原文 ↗</a>}
   </footer>
  </div>
 </article>;
}
