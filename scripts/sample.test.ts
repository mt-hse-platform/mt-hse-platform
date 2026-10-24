import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTemplateContent } from '../packages/engines/src/template/shape.ts';
import { validateTemplate } from '../packages/engines/src/template/validate.ts';

test('the sample template shipped for first-time import is accepted and publishable', () => {
  const json = JSON.parse(readFileSync(new URL('../docs/sample-template-batching-plant.json', import.meta.url), 'utf8')) as unknown;
  assert.equal(isTemplateContent(json), true);
  if (isTemplateContent(json)) assert.deepEqual(validateTemplate(json), []);
});
