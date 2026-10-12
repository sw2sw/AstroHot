import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.env.COLLECT_ENABLED = 'false';
process.env.MODEL_CALLS_ENABLED = 'false';

test('source icon cron is not registered with collection disabled', async () => {
  const { SCHEDULES } = await import('../apps/worker/src/schedules.ts');
  assert.equal(SCHEDULES.some(s => s.name === 'sources.icons'), false);
});

test('disabled icon refresh returns before any database or external fetch', () => {
  const code = `import {refreshSourceIcons} from './packages/backend/src/sources/icons.ts';
    import {closeDb} from './packages/backend/src/db.ts';
    try { console.log(JSON.stringify(await refreshSourceIcons())); } finally {await closeDb();}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, COLLECT_ENABLED: 'false', DATABASE_URL: 'postgres://disabled@127.0.0.1:1/astrohot_disabled_test' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {xAvatars: 0, checked: 0, found: 0, skipped: 'collection_disabled'});
});

test('disabled sources are not automatically checked for icons', {skip: process.env.ICON_POLICY_INTEGRATION !== 'true'}, async () => {
  assert.ok(process.env.DATABASE_URL?.endsWith('/astrohot_icon_test'), 'use the dedicated empty integration database');
  const {sql, closeDb} = await import('../packages/backend/src/db.ts');
  const {refreshSourceIcons} = await import('../packages/backend/src/sources/icons.ts');
  try {
    await sql`INSERT INTO sources (id,name,kind,config,tier,first_party,participation_mode,interval_minutes,tags,site_fulltext,syndicate_fulltext,enabled,health)
      VALUES ('qa-disabled-icon-safety','Synthetic disabled source','rss','{}','T2',false,'editorial',1440,'{}',false,false,false,'paused')`;
    process.env.COLLECT_ENABLED = 'true';
    const result = await refreshSourceIcons();
    assert.equal(result.checked, 0);
  } finally {
    process.env.COLLECT_ENABLED = 'false';
    await sql`DELETE FROM sources WHERE id='qa-disabled-icon-safety'`;
    await closeDb();
  }
});
