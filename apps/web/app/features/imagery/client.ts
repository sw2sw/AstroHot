import type {ImageryViewItem} from './types.ts';
type Result = {item:ImageryViewItem|null;status:string};
export async function lookupImagery(date:string,fetchImpl:typeof fetch=fetch, timing:{now?:()=>number;sleep?:(ms:number)=>Promise<void>}={}):Promise<Result> {
  const now=timing.now ?? (()=>performance.now());
  const deadline=now()+100_000;
  const signal=AbortSignal.timeout(100_000);
  const sleep=timing.sleep ?? ((ms:number)=>new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  }));
  const read=async(path:string):Promise<Result>=>{
    const response=await fetchImpl(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal});
    if(!response.ok)throw Error('暂时无法查询天文影像');
    const value=await response.json();
    if(!value || !['ready','pending','unavailable'].includes(value.status))throw Error('暂时无法查询天文影像');
    return {item:value.item ?? null,status:value.status};
  };
  let result=await read('/api/imagery/lookup');
  for(let polls=0;result.status==='pending' && polls<33 && now()+3000<deadline && !signal.aborted;polls++) {
    try {
      await sleep(3000);
      if(now()>=deadline || signal.aborted)break;
      const next=await read('/api/imagery/status');
      result={...next,item:next.item ?? result.item};
    } catch {return result;} // Keep cached original content on deadline or transient polling failure.
  }
  return result;
}
