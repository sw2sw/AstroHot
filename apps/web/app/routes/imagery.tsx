import {useRef,useState} from 'react';
import {Link,useLoaderData} from 'react-router';
import {apiGet,edgeTtl} from '../lib/api.server';
import {pageMeta} from '../lib/seo';
import type {Screen} from '../components/shell/screens';
import {PhoneBar} from '../components/shell/PhoneBar';
import {ImageryCard} from '../features/imagery/ImageryCard';
import {ImageryDialog} from '../features/imagery/ImageryDialog';
import {ImageryRights} from '../features/imagery/ImageryRights';
import {ImageryMediaNote} from '../features/imagery/ImageryMediaNote';
import {birthdayOutcome,imagerySynopsis,mediaPlaceholder,safeImageUrl,translationLabel,videoMediaNote} from '../features/imagery/view';
import {BirthdayLookup} from '../features/imagery/BirthdayLookup';
import {lookupImagery} from '../features/imagery/client';
import type {ImageryViewItem} from '../features/imagery/types';
export const handle:Screen={tab:'me',name:'天文影像'};
export async function loader({request}:{request:Request}) {
 const before=new URL(request.url).searchParams.get('before');
 try {const feed=await apiGet<{items:ImageryViewItem[]}>(`/api/imagery/items?limit=12${before?`&before=${encodeURIComponent(before)}`:''}`,{signal:request.signal});return {items:feed.items,available:true};}
 catch {return {items:[] as ImageryViewItem[],available:false};}
}
export function meta(){return pageMeta({title:'天文影像 · 生日宇宙',path:'/imagery',description:'NASA APOD 天文影像原文、中文翻译与按日期查询的公共档案。'});}
export function headers(){return edgeTtl(60);}
export default function ImageryPage(){
 const {items,available}=useLoaderData<typeof loader>();
 const [selected,setSelected]=useState<{item:ImageryViewItem;kind:'birthday'|'archive'}|null>(null);
 const [notice,setNotice]=useState('');
 const queryOpener=useRef<HTMLElement|null>(null);
 const hero=items[0];
 const heroImage=hero ? safeImageUrl(hero) : null;
 return <main className="mx-auto w-full max-w-7xl space-y-8 pb-12">
  <PhoneBar back={{to:'/',label:'精选'}} title="天文影像"/>
  <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4 pt-3">
   <div><h1 data-page-title="" className="text-3xl font-semibold text-ink">天文影像</h1></div>
   <a href="#birthday-title" className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-medium text-accent hover:bg-bg-sunk">生日宇宙 ↓</a>
  </header>
  {hero && <section aria-labelledby="today-title" className="card overflow-hidden">
   <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3"><h2 id="today-title" className="text-sm font-semibold text-ink">最新影像</h2><p className="num text-xs text-ink-4">{hero.sourceDate} · NASA APOD</p></div>
   <div className="grid lg:grid-cols-[1.7fr_1fr]">
    <button type="button" aria-label={`查看详情：${hero.titleZh?.trim() || hero.titleEn}`} onClick={()=>setSelected({item:hero,kind:'archive'})} className="flex w-full items-center justify-center bg-black/95 focus-visible:outline-2 focus-visible:outline-accent">
     {heroImage ? <img src={heroImage} alt={hero.altEn ?? hero.titleEn} className="max-h-[58vh] w-full object-contain lg:min-h-96" fetchPriority="high"/> : <p className="p-12 text-sm text-white/70">{videoMediaNote(hero) ? "预览暂不可用" : mediaPlaceholder(hero)}</p>}
    </button>
    <div className="flex min-w-0 flex-col justify-center gap-5 p-5 sm:p-7 [overflow-wrap:anywhere]">
     <div className="space-y-2"><h3 className="text-2xl font-semibold leading-tight text-ink sm:text-3xl">{hero.translationStatus==='ready' && hero.titleZh?.trim() ? hero.titleZh : hero.titleEn}</h3>{hero.titleZh?.trim() && <p lang="en" className="text-sm text-ink-3">{hero.titleEn}</p>}<p className="text-xs text-ink-4">{translationLabel(hero)}</p></div>
     <p className="text-sm leading-7 text-ink-2">{imagerySynopsis(hero)}</p>
     <ImageryMediaNote item={hero}/>
     <button type="button" onClick={()=>setSelected({item:hero,kind:'archive'})} className="min-h-11 self-start rounded-full bg-accent px-5 text-sm font-medium text-accent-contrast hover:bg-accent-ink">查看详情 →</button>
     <div className="border-t border-line pt-3 text-xs text-ink-4"><ImageryRights item={hero}/></div>
    </div>
   </div>
  </section>}
  <section aria-labelledby="birthday-title" onFocusCapture={event=>{if(event.target instanceof HTMLElement) queryOpener.current=event.target;}} className="rounded-card border border-line bg-bg-sunk p-5 sm:p-6">
   <div className="grid items-center gap-5 lg:grid-cols-[1fr_1.8fr]">
    <div className="space-y-2"><h2 id="birthday-title" className="text-xl font-semibold text-ink">生日宇宙</h2><p className="text-sm leading-6 text-ink-3">选一个属于你的日子，看看那天的宇宙。</p></div>
    <div><BirthdayLookup onLookup={async(date)=>{

     setSelected(null);setNotice('');
     const outcome=birthdayOutcome(await lookupImagery(date));
     setNotice(outcome.notice);
     if(outcome.item) setSelected({item:outcome.item,kind:'birthday'});
    }}/>{notice && <p role="status" className="mt-2 text-sm text-ink-3">{notice}</p>}</div>
   </div>
   <p className="mt-3 text-xs leading-5 text-ink-4">日期仅用于本次查询，不建立生日资料，不写入链接或浏览器存储。首次准备影像可能需要片刻。</p>
  </section>
  <section aria-labelledby="archive-title" className="space-y-4">
   <div className="flex items-baseline justify-between border-b border-line pb-3"><h2 id="archive-title" className="text-xl font-semibold text-ink">影像档案</h2><span className="text-xs text-ink-4">按原始发布日期收录</span></div>
   {!available && <p role="status" className="card p-5">影像暂时不可用；新闻与论文仍可正常阅读。</p>}
   {available && items.length===0 && <p className="card p-5">暂无影像存档。可先按日期查询，或稍后再来看看。</p>}
   <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{items.map(item=><ImageryCard key={`${item.source}:${item.sourceDate}`} item={item} onOpen={()=>setSelected({item,kind:'archive'})}/>)}</div>
   {items.length===12 && <Link className="inline-block min-h-11 text-accent hover:underline" to={`/imagery?before=${items.at(-1)!.sourceDate}`}>更早的影像 →</Link>}
  </section>
  <p className="border-t border-line pt-4 text-xs leading-6 text-ink-4">影像与说明版权归原作者；中文为 AI 翻译，以英文原文为准。仅供私人研究演示，不提供壁纸授权。</p>
  {selected && <ImageryDialog key={`${selected.kind}:${selected.item.sourceDate}`} item={selected.item} kind={selected.kind} returnFocusTo={selected.kind==='birthday' ? queryOpener.current : undefined} onClose={()=>setSelected(null)}/>}
 </main>;
}
