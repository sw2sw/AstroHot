import type { ImageryItem } from '@aihot/contracts/imagery';
import { getImagery, imageryMediaAvailable } from './store.ts';
import { validateApodDate } from './date.ts';
import { enqueue, QUEUES } from '../jobs/queue.ts';

export function imageryJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IMAGERY_ENABLED === 'true' && env.COLLECT_ENABLED === 'true';
}
export const imageryReady = (item: ImageryItem | null) => !!item && item.translationStatus === 'ready' && ['ready','not_applicable'].includes(item.mediaStatus);

/** Reader path: only read public archive rows and enqueue durable work. No upstream or model calls. */
export async function requestImagery(date: string, deps: {
  get?: typeof getImagery;
  enqueue?: typeof enqueue;
  enabled?: boolean;
} = {}): Promise<{item:ImageryItem|null;status:'ready'|'pending'|'unavailable'}> {
  validateApodDate(date);
  let item = await (deps.get ?? getImagery)('nasa-apod', date);
  if (item?.mediaStatus === 'ready' && !await imageryMediaAvailable(item)) {
    // Do not advertise a broken image or mutate the archive from the reader path.
    item = {...item,mediaStatus:'pending',imageUrl:null};
  }
  if (imageryReady(item)) return {item,status:'ready'};
  if (!(deps.enabled ?? imageryJobsEnabled())) return {item,status:item ? 'pending':'unavailable'};
  await (deps.enqueue ?? enqueue)(QUEUES.imageryApod, {date}, {singletonKey:`nasa-apod:${date}`});
  return {item,status:'pending'};
}
