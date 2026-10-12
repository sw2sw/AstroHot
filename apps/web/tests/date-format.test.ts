import test from 'node:test';
import assert from 'node:assert/strict';
import { monthDayYear, monthDayYearTime } from '../app/lib/format.ts';

test('invalid calendar dates do not fabricate a visible date', () => {
  assert.equal(monthDayYear('2025-02-29'), '—');
});

test('date-only inputs retain date-only precision', () => {
  assert.equal(monthDayYearTime('2025-07-11'), '2025年7月11日');
});

test('missing and invalid timestamps render the empty marker', () => {
  for (const value of ['', 'not-a-date', undefined, null]) {
    assert.equal(monthDayYearTime(value as string), '—');
  }
});

test('same month/day in different years remains distinguishable', () => {
  assert.equal(monthDayYear('2025-07-11'), '2025年7月11日');
  assert.equal(monthDayYear('2026-07-11'), '2026年7月11日');
});

test('Beijing conversion preserves the year boundary', () => {
  assert.equal(monthDayYearTime('2025-12-31T15:59:00Z'), '2025年12月31日 23:59');
  assert.equal(monthDayYearTime('2025-12-31T16:00:00Z'), '2026年1月1日 00:00');
});

test('valid leap days remain visible', () => {
  assert.equal(monthDayYear('2024-02-29'), '2024年2月29日');
});
