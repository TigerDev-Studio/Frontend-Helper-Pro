import assert from 'node:assert/strict';
import test from 'node:test';
import { findEditedTagAtOffset, findMatchingTag, parseTagTokens } from '../src/tagMatcher.js';

test('finds the closing pair for an opening tag', () => {
  const text = '<div><span>Hello</span></div>';
  const tag = findEditedTagAtOffset(text, 2);
  const match = tag ? findMatchingTag(text, tag) : undefined;

  assert.equal(tag?.name, 'div');
  assert.equal(match?.name, 'div');
  assert.equal(match?.type, 'closing');
});

test('finds the opening pair for a closing tag', () => {
  const text = '<section><article>Text</article></section>';
  const closingOffset = text.lastIndexOf('section') + 1;
  const tag = findEditedTagAtOffset(text, closingOffset);
  const match = tag ? findMatchingTag(text, tag) : undefined;

  assert.equal(tag?.type, 'closing');
  assert.equal(match?.type, 'opening');
  assert.equal(match?.name, 'section');
});

test('respects nesting of same-name tags', () => {
  const text = '<div><div>Inner</div></div>';
  const tokens = parseTagTokens(text);
  const outer = tokens[0];
  const inner = tokens[1];

  assert.equal(findMatchingTag(text, outer)?.start, text.lastIndexOf('</div>'));
  assert.equal(findMatchingTag(text, inner)?.start, text.indexOf('</div>'));
});

test('ignores self-closing tags', () => {
  const text = '<img src="x"><Icon />';
  const tokens = parseTagTokens(text);

  assert.equal(tokens[0].selfClosing, false);
  assert.equal(tokens[1].selfClosing, true);
  assert.equal(findMatchingTag(text, tokens[0]), undefined);
});
