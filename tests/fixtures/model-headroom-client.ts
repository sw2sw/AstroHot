import { acquireModelPermit } from '../../packages/backend/src/providers/model-limit.ts';
import { providerPacing } from '../../packages/backend/src/providers/provider-pacing.ts';
import { closeDb } from '../../packages/backend/src/db.ts';
const provider = providerPacing(new URL(process.argv[2]!))!;
provider.intervalMs = 0; // Test only: exercise simultaneous pool claims without a ten-second delay.
const tokens: string[] = [];
for (let i = 0; i < 6; i++) {
  try { tokens.push(await acquireModelPermit('worker-model-'+i, String(i), {provider, waitMs:100})); } catch {}
}
console.log(JSON.stringify(tokens));
await closeDb();
