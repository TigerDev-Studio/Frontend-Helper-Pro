import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSpellRanges, findMisspellings } from '../src/spell.js';

test('finds common typo suggestions in markdown text', async () => {
  const misspellings = await findMisspellings('Teh component can recieve input.', 'markdown');

  assert.deepEqual(misspellings.map((misspelling) => misspelling.normalizedWord), ['teh', 'recieve']);
  assert.equal(misspellings[0].suggestions[0], 'the');
  assert.equal(misspellings[1].suggestions[0], 'receive');
});

test('ignores fenced markdown code blocks', async () => {
  const markdown = [
    'Correct text.',
    '```ts',
    'const message = "teh";',
    '```'
  ].join('\n');

  assert.equal((await findMisspellings(markdown, 'markdown')).length, 0);
});

test('checks html text and comments but not attributes', async () => {
  const html = '<div aria-label="recieve">Visible teh text<!-- widht comment --></div>';
  const misspellings = await findMisspellings(html, 'html');

  assert.deepEqual(misspellings.map((misspelling) => misspelling.normalizedWord), ['teh', 'widht']);
});

test('extracts strings and comments from code', async () => {
  const code = [
    '// recieve value',
    'const label = "widht";',
    'const ignoredIdentifier = recieveValue;'
  ].join('\n');
  const misspellings = await findMisspellings(code, 'typescript');

  assert.deepEqual(misspellings.map((misspelling) => misspelling.normalizedWord), ['recieve', 'widht']);
});

test('extracts vue script ranges through html parser', async () => {
  const vue = '<template><p>teh title</p></template><script>const msg = "recieve";</script>';
  const ranges = extractSpellRanges(vue, 'vue');
  const misspellings = await findMisspellings(vue, 'vue');

  assert.ok(ranges.length >= 2);
  assert.deepEqual(misspellings.map((misspelling) => misspelling.normalizedWord), ['teh', 'recieve']);
});

test('honors cspell ignore directives inside checked ranges', async () => {
  const markdown = [
    '<!-- cspell:ignore recieve -->',
    'The word recieve should be ignored here.',
    'But widht should still be reported.'
  ].join('\n');
  const misspellings = await findMisspellings(markdown, 'markdown');

  assert.deepEqual(misspellings.map((misspelling) => misspelling.normalizedWord), ['widht']);
});

test('honors workspace dictionary words', async () => {
  const misspellings = await findMisspellings('Use design tokens from Acmefront.', 'markdown', {
    userWords: ['Acmefront']
  });

  assert.equal(misspellings.length, 0);
});

test('honors cspell words directives inside checked ranges', async () => {
  const misspellings = await findMisspellings([
    '<!-- cspell:words Acmefront -->',
    'Use design tokens from Acmefront, but fix widht.'
  ].join('\n'), 'markdown');

  assert.deepEqual(misspellings.map((misspelling) => misspelling.normalizedWord), ['widht']);
});
