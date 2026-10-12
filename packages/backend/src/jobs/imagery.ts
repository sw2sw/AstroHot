import type { PgBoss } from 'pg-boss';
import { ensureImagery } from '../imagery/service.ts';
import { QUEUES, work } from './queue.ts';

export async function registerImageryJobs(boss: PgBoss, deps: {
  work?: typeof work<"imagery.apod">;
  ensure?: (date:string)=>Promise<unknown>;
} = {}) {
  await (deps.work ?? work)(boss, QUEUES.imageryApod, {localConcurrency:1,pollingIntervalSeconds:2}, async ({date}) => {
    return (deps.ensure ?? ensureImagery)(date);
  });
}
