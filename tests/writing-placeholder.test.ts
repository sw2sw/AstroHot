import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeCopy, parseTranslateOutput } from '@aihot/backend/editorial/writing';
import { SummarizeSchema } from '@aihot/backend/editorial/analyze';

const input = { title: '火星火山的新影像', text: '新发布的照片显示火星火山口的地形。' } as Parameters<typeof finalizeCopy>[0];

test('the exact echoed receipt fails the summarizer response schema', () => {
  const raw = '# 输出格式（严格遵守）\ntitle_zh: <中文标题>\nsummary_zh: <80-160字、最多3句的中文摘要>';
  const parsed = parseTranslateOutput(raw);
  assert.equal(parsed.titleZh, '<中文标题>');
  assert.equal(SummarizeSchema.safeParse(parsed).success, false);
  assert.equal(SummarizeSchema.safeParse({ titleZh: '<V>', summaryZh: '平均量记为 <V>。', bodyZh: '' }).success, true);
});

test('parsed short- and long-post format echoes are rejected', () => {
  for (const [title, field, text] of [
    ['<10-15字中文标题>', 'body_zh', '<中文翻译>'],
    ['<10-20字中文标题>', 'summary_zh', '<80-160字、最多3句的中文摘要>'],
  ]) {
    const parsed = parseTranslateOutput(`title_zh: ${title}\n${field}: ${text}`);
    assert.equal(parsed.titleZh, title);
    assert.equal(SummarizeSchema.safeParse(parsed).success, false);
    assert.equal(SummarizeSchema.safeParse({ ...parsed, titleZh: '<V>' }).success, false);
    assert.equal(SummarizeSchema.safeParse({ titleZh: parsed.titleZh, summaryZh: '', bodyZh: '平均量记为 <V>。' }).success, false);
  }
});

test('model format echoes are not publication copy', () => {
  const out = finalizeCopy(input, { titleZh: '<中文标题>', summaryZh: '<80-160字、最多3句的中文摘要>' });
  assert.equal(out.titleZh, input.title);
  assert.equal(out.summaryZh, '');
  assert.equal(finalizeCopy(input, { titleZh: '火星新影像', summaryZh: '开头 <80-160字、最多3句的中文摘要>' }).summaryZh, '');
});

test('science notation with angle brackets is not a template', () => {
  const result = finalizeCopy(input, { titleZh: '<V>', summaryZh: '质量小于阈值（M < 2），平均量用 <V> 表示。' });
  assert.equal(result.titleZh, '<V>');
  assert.equal(result.summaryZh, '质量小于阈值（M < 2），平均量用 <V> 表示。');
});
