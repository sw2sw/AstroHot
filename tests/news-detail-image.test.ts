// Offline projection/detail integration: no DB or provider requests.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mock,test} from 'node:test';
registerHooks({resolve(s,c,next){const m=/^@aihot\/(backend|contracts|industry)\/(.+)$/.exec(s);if(m)return next(new URL(`../${m[1]==='industry'?'industry':`packages/${m[1]}/src`}/${m[2]}.ts`,import.meta.url).href,c);return next(s,c);}});
process.env.MODEL_CALLS_ENABLED='false';process.env.COLLECT_ENABLED='false';process.env.AIHOT_CREDENTIALS_DIR='/nonexistent';process.env.IMG_PROXY_SIGN_SECRET='offline-news-detail-test';
const url='https://example.org/first.jpg';
let row:any={id:'lead',title:'新闻',original_title:null,summary:'摘要',reason:null,category:null,tags:[],score:62,selected:true,channel:'news',url:'https://example.org/news',published_at:null,discovered_at:new Date('2026-10-06'),timeline_at:new Date('2026-10-06'),seat:true,visibility:'public',body_mode:'summary',indexable:false,fact_id:null,source_name:'Observatory',source_mode:'editorial',x_post:null,author:null,language:'en',story_public_id:null,story_title:null,zh_text:null,quoted_zh:null,topics:[],body_html:null,body_text:null,body_status:'pending',tr_html:null,tr_complete:false,card_image_allowed:true,card_image_requires_credit:true,media:[{kind:'image',url,alt:'恒星形成',width:2000,height:1000}],image_review:{url,approved:true,category:'related',credit:'NASA, ESA',depiction:'artist_concept',attributionUrl:'https://example.org/image'}};
const sql:any=Object.assign(async(strings:any,...values:any[])=>{const q=strings.join('?');return q.includes('WHERE p.article_id =')?[row]:[];},{json:(v:any)=>v});
mock.module(new URL('../packages/backend/src/db.ts',import.meta.url).href,{namedExports:{sql}});
const {loadItemDetail}=await import('../packages/backend/src/publication/detail.ts');
const {reviewedThumbnail,toFeedItemSummary}=await import('../packages/backend/src/publication/items.ts');
test('card and detail expose same reviewed image, larger signed detail renditions and exact credit without full text',async()=>{
 const card=toFeedItemSummary(row).thumbnail; const detail=await loadItemDetail(row.id);assert.equal(detail.kind,'found');if(detail.kind!=='found')return;
 const img=detail.item.newsImage;assert.ok(img&&card);assert.equal(new URL(img.url,'https://local').searchParams.get('u'),url);assert.notEqual(img.srcSet,card.srcSet);assert.equal((img as any).credit,card.credit);assert.equal((img as any).caption,card.caption);assert.equal(detail.item.body,null);
});
test('both views fail closed for missing permission, uncertain or mismatched review and missing credit',async()=>{
 const base=row;for(const patch of [{card_image_allowed:false},{image_review:null},{image_review:{...base.image_review,approved:false}},{image_review:{...base.image_review,category:'uncertain'}},{image_review:{...base.image_review,url:'https://example.org/stale.jpg'}},{image_review:{...base.image_review,credit:null}},{media:[]}]){row={...base,...patch};assert.equal(toFeedItemSummary(row).thumbnail,null);const d=await loadItemDetail(row.id);assert.equal(d.kind,'found');if(d.kind==='found')assert.equal(d.item.newsImage,null);}row=base;
});
const esaArticle='https://www.esa.int/Science_Exploration/Space_Science/Mars_Express/Mars_Express_keeps_an_eye_on_curious_cloud';
const esaCandidate='https://www.esa.int/var/esa/storage/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated_article.jpg';
const esaCanonical='https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated.jpg';
const esaPage='https://www.esa.int/ESA_Multimedia/Images/2018/10/Elongated_cloud_on_Mars_annotated';
const standardUrl='https://www.esa.int/ESA_Multimedia/Terms_and_conditions_of_use_of_images_and_videos_available_on_the_esa_website';
const pngStorage='https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2022/05/solar_orbiter_at_perihelion_27_march_2022/24071526-1-eng-GB/Solar_Orbiter_at_perihelion_27_March_2022';
test('ESA PNG card and detail use verified original with exact credit, and reject stale JPG evidence',async()=>{
 const base=row;const candidate=pngStorage+'_card_full.png';
 row={...base,url:'https://www.esa.int/Science_Exploration/Space_Science/Solar_Orbiter/Solar_Orbiter_tracks_origin_of_mysterious_magnetic_switchbacks',media:[{kind:'image',url:candidate}],image_review:{url:candidate,approved:true,category:'related',status:'approved',reason:'Related solar observation',rightsStatus:'verified',credit:'ESA & NASA/Solar Orbiter/EUI Team',license:'ESA Standard Licence',licenseUrl:standardUrl,attributionUrl:'https://www.esa.int/ESA_Multimedia/Images/2022/05/Solar_Orbiter_at_perihelion_27_March_2022',canonicalUrl:pngStorage+'.png'}};
 try{
  const card=reviewedThumbnail(row);assert.ok(card);assert.equal(new URL(card.url,'https://local').searchParams.get('u'),pngStorage+'.png');
  const detail=await loadItemDetail(row.id);assert.equal(detail.kind,'found');if(detail.kind==='found'){assert.ok(detail.item.newsImage);assert.equal(new URL(detail.item.newsImage.url,'https://local').searchParams.get('u'),pngStorage+'.png');assert.equal(detail.item.newsImage.credit,row.image_review.credit);}
  for(const patch of [{canonicalUrl:pngStorage+'.jpg'},{rightsStatus:'unverified'},{credit:''},{approved:false},{license:'CC BY-SA 3.0 IGO',licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0/igo/'}])assert.equal(reviewedThumbnail({...row,image_review:{...row.image_review,...patch}}),null);
 }finally{row=base;}
});
const esaReview={url:esaCandidate,approved:true,category:'related',status:'approved',reason:'2018年火星云层背景观测图，与正文相关',rightsStatus:'verified',credit:'ESA/GCP/UPV/EHU Bilbao',license:'ESA Standard Licence',licenseUrl:standardUrl,attributionUrl:esaPage,canonicalUrl:esaCanonical};
test('ESA public reader fails closed for unverified rights even with approved suitability and exact credit',()=>{
 const esa={...row,url:esaArticle,source_name:'ESA Space Science',media:[{kind:'image',url:esaCandidate}],image_review:{...esaReview,rightsStatus:'unverified'}};
 assert.equal(reviewedThumbnail(esa),null);
});
test('ESA card and detail proxy verified canonical image while binding original first-image identity',async()=>{
 const base=row;row={...base,url:esaArticle,source_name:'ESA Space Science',media:[{kind:'image',url:esaCandidate}],image_review:esaReview};
 try{const card=reviewedThumbnail(row);assert.ok(card);assert.equal(new URL(card.url,'https://local').searchParams.get('u'),esaCanonical);
 const d=await loadItemDetail(row.id);assert.equal(d.kind,'found');if(d.kind==='found'){assert.ok(d.item.newsImage);assert.equal(new URL(d.item.newsImage.url,'https://local').searchParams.get('u'),esaCanonical);assert.equal((d.item.newsImage as any).credit,esaReview.credit);}
 assert.equal(reviewedThumbnail({...row,media:[{kind:'image',url:'https://example.org/other.jpg'}]}),null);
 }finally{row=base;}
});
for(const patch of [{reason:undefined},{reason:''},{status:'missing'},{status:undefined},{credit:''},{credit:'Getty Images'},{license:'CC BY-SA 3.0 IGO',licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0/igo/'},{rightsStatus:undefined},{licenseUrl:'https://evil.org/licence'},{license:'Unknown'},{canonicalUrl:'https://evil.org/image.jpg'},{canonicalUrl:esaCanonical.replace('17836422','999999')},{attributionUrl:esaPage.replace('annotated','other')}])test(`ESA reader rejects absent or mismatched persisted evidence: ${JSON.stringify(patch)}`,()=>{
 const esa={...row,url:esaArticle,media:[{kind:'image',url:esaCandidate}],image_review:{...esaReview,...patch}};
 assert.equal(reviewedThumbnail(esa),null);
});
test('summary-only detail also uses separate approved image permission without exposing body',async()=>{const base=row;row={...base,visibility:'summary-only'};try{const d=await loadItemDetail(row.id);assert.equal(d.kind,'found');if(d.kind==='found'){assert.ok(d.item.newsImage);assert.equal(d.item.body,null);}}finally{row=base;}});
