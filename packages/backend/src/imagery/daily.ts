import { ensureImagery } from './service.ts';

type Environment = Partial<Pick<NodeJS.ProcessEnv, 'IMAGERY_ENABLED' | 'IMAGERY_DAILY_ENABLED' | 'COLLECT_ENABLED'>>;

export function imageryDailyEnabled(env: Environment = process.env): boolean {
  return env.IMAGERY_ENABLED === 'true' && env.IMAGERY_DAILY_ENABLED === 'true' && env.COLLECT_ENABLED === 'true';
}

/** One current UTC date per invocation; service owns persistence, claims and stage retries. */
export async function runImageryDaily(options: {
  now?: Date;
  env?: Environment;
  ensureImpl?: (date: string) => Promise<unknown>;
} = {}) {
  if (!imageryDailyEnabled(options.env)) return { skipped: true };
  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const imagery = await (options.ensureImpl ?? ensureImagery)(date);
  return { date, available: imagery != null };
}
