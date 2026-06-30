export type TagTokenType = 'opening' | 'closing';

export interface TagToken {
  name: string;
  normalizedName: string;
  type: TagTokenType;
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
  selfClosing: boolean;
}

const TAG_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9:._-]*/;
export function findEditedTagAtOffset(text: string, offset: number): TagToken | undefined {
  const safeOffset = Math.max(0, Math.min(text.length, offset));
  const start = findTagStart(text, safeOffset);
  if (start === -1) {
    return undefined;
  }

  const end = findTagEnd(text, start);
  if (end === -1 || safeOffset > end) {
    return undefined;
  }

  const token = parseTagAt(text, start, end + 1);
  if (!token) {
    return undefined;
  }

  if (safeOffset >= token.nameStart - 1 && safeOffset <= token.nameEnd + 1) {
    return token;
  }

  return undefined;
}

export function findMatchingTag(text: string, editedTag: TagToken): TagToken | undefined {
  if (editedTag.selfClosing) {
    return undefined;
  }

  const tokens = parseTagTokens(text);
  const editedIndex = tokens.findIndex((token) => token.start === editedTag.start && token.end === editedTag.end);
  if (editedIndex === -1) {
    return undefined;
  }

  const current = tokens[editedIndex];
  if (current.type === 'opening') {
    return findClosingToken(tokens, editedIndex, current.normalizedName);
  }

  return findOpeningToken(tokens, editedIndex, current.normalizedName);
}

export function parseTagTokens(text: string): TagToken[] {
  const tokens: TagToken[] = [];
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf('<', index);
    if (start === -1) {
      break;
    }

    if (isIgnoredTagStart(text, start)) {
      const ignoredEnd = findIgnoredTagEnd(text, start);
      index = ignoredEnd === -1 ? text.length : ignoredEnd + 1;
      continue;
    }

    const end = findTagEnd(text, start);
    if (end === -1) {
      break;
    }

    const token = parseTagAt(text, start, end + 1);
    if (token) {
      tokens.push(token);
    }

    index = end + 1;
  }

  return tokens;
}

function findClosingToken(tokens: TagToken[], editedIndex: number, normalizedName: string): TagToken | undefined {
  let depth = 0;
  for (let index = editedIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.normalizedName !== normalizedName || token.selfClosing) {
      continue;
    }

    if (token.type === 'opening') {
      depth += 1;
      continue;
    }

    if (depth === 0) {
      return token;
    }

    depth -= 1;
  }

  return undefined;
}

function findOpeningToken(tokens: TagToken[], editedIndex: number, normalizedName: string): TagToken | undefined {
  let depth = 0;
  for (let index = editedIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.normalizedName !== normalizedName || token.selfClosing) {
      continue;
    }

    if (token.type === 'closing') {
      depth += 1;
      continue;
    }

    if (depth === 0) {
      return token;
    }

    depth -= 1;
  }

  return undefined;
}

function parseTagAt(text: string, start: number, endExclusive: number): TagToken | undefined {
  if (text[start] !== '<') {
    return undefined;
  }

  let cursor = start + 1;
  let type: TagTokenType = 'opening';
  if (text[cursor] === '/') {
    type = 'closing';
    cursor += 1;
  }

  while (/\s/.test(text[cursor] ?? '')) {
    cursor += 1;
  }

  const nameMatch = TAG_NAME_PATTERN.exec(text.slice(cursor, endExclusive));
  if (!nameMatch) {
    return undefined;
  }

  const name = nameMatch[0];
  const nameStart = cursor;
  const nameEnd = cursor + name.length;
  const rawTag = text.slice(start, endExclusive);
  const normalizedName = name.toLowerCase();
  const selfClosing = type === 'opening' && /\/\s*>$/.test(rawTag);

  return {
    name,
    normalizedName,
    type,
    start,
    end: endExclusive,
    nameStart,
    nameEnd,
    selfClosing
  };
}

function findTagStart(text: string, offset: number): number {
  for (let index = Math.min(offset, text.length - 1); index >= 0; index -= 1) {
    const char = text[index];
    if (char === '>') {
      return -1;
    }
    if (char === '<') {
      return index;
    }
  }

  return -1;
}

function findTagEnd(text: string, start: number): number {
  let quote: string | undefined;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '>') {
      return index;
    }
  }

  return -1;
}

function isIgnoredTagStart(text: string, start: number): boolean {
  return text.startsWith('<!--', start)
    || text.startsWith('<!', start)
    || text.startsWith('<?', start);
}

function findIgnoredTagEnd(text: string, start: number): number {
  if (text.startsWith('<!--', start)) {
    const commentEnd = text.indexOf('-->', start + 4);
    return commentEnd === -1 ? -1 : commentEnd + 2;
  }

  return text.indexOf('>', start + 1);
}
