import {
  getDefaultBundledSettingsAsync,
  mergeSettings,
  suggestionsForWord,
  validateText,
  type CSpellUserSettings,
  type ValidationIssue
} from 'cspell-lib';

export interface TextRange {
  start: number;
  end: number;
}

export interface Misspelling {
  word: string;
  normalizedWord: string;
  start: number;
  end: number;
  suggestions: string[];
  message?: string;
}

export interface SpellOptions {
  userWords?: string[];
  ignoreWords?: string[];
  flagWords?: string[];
  locale?: string;
  maxDiagnostics?: number;
  numSuggestions?: number;
  minWordLength?: number;
}

interface CSpellDirectives {
  ignoreWords: string[];
  words: string[];
}

const DEFAULT_FRONTEND_WORDS = [
  'aem',
  'ajax',
  'angular',
  'aria',
  'babel',
  'bem',
  'css',
  'dom',
  'eslint',
  'figma',
  'frontend',
  'github',
  'graphql',
  'html',
  'http',
  'https',
  'javascript',
  'json',
  'jsx',
  'less',
  'localhost',
  'markdown',
  'mdx',
  'monorepo',
  'npm',
  'pnpm',
  'prettier',
  'px',
  'rem',
  'responsive',
  'rpx',
  'sass',
  'scss',
  'svg',
  'tailwind',
  'tsx',
  'typescript',
  'uri',
  'url',
  'vite',
  'vscode',
  'vue',
  'webpack',
  'webview',
  'vw',
  'yaml'
];

const DEFAULT_FLAG_WORDS = [
  'adress->address',
  'alredy->already',
  'becuase->because',
  'calender->calendar',
  'coment->comment',
  'componant->component',
  'componants->components',
  'definately->definitely',
  'enviroment->environment',
  'heigth->height',
  'occured->occurred',
  'recieve->receive',
  'recieved->received',
  'seperate->separate',
  'sucess->success',
  'teh->the',
  'tempalte->template',
  'thier->their',
  'untill->until',
  'widht->width'
];

const DEFAULT_DICTIONARIES = [
  'en_us',
  'softwareTerms',
  'html',
  'css',
  'typescript'
];

const DEFAULT_SPELL_OPTIONS = {
  maxDiagnostics: 200,
  minWordLength: 4,
  numSuggestions: 4
};

let bundledSettingsPromise: Promise<CSpellUserSettings> | undefined;

export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/^'+|'+$/g, '');
}

export async function findMisspellings(text: string, languageId: string, options: SpellOptions = {}): Promise<Misspelling[]> {
  const ranges = extractSpellRanges(text, languageId);
  if (!ranges.length) {
    return [];
  }

  const spellableText = maskTextOutsideRanges(text, ranges);
  const directives = extractCSpellDirectives(spellableText);
  const settings = await createCSpellSettings(languageId, {
    ...options,
    userWords: [...(options.userWords ?? []), ...directives.words],
    ignoreWords: [...(options.ignoreWords ?? []), ...directives.ignoreWords]
  });
  const issues = await validateText(spellableText, settings, {
    generateSuggestions: true,
    numSuggestions: options.numSuggestions ?? DEFAULT_SPELL_OPTIONS.numSuggestions,
    validateDirectives: true
  });

  return issues
    .filter((issue) => isIssueInRanges(issue, ranges))
    .slice(0, options.maxDiagnostics ?? DEFAULT_SPELL_OPTIONS.maxDiagnostics)
    .map(issueToMisspelling);
}

export async function getSuggestions(word: string, languageId = 'plaintext', options: SpellOptions = {}): Promise<string[]> {
  const settings = await createCSpellSettings(languageId, options);
  const result = await suggestionsForWord(word, {
    languageId,
    locale: options.locale ?? 'en',
    numSuggestions: options.numSuggestions ?? DEFAULT_SPELL_OPTIONS.numSuggestions
  }, settings);

  return uniqueSuggestions(result.suggestions.map((suggestion) => suggestion.wordAdjustedToMatchCase ?? suggestion.word));
}

export function extractSpellRanges(text: string, languageId: string): TextRange[] {
  if (languageId === 'markdown') {
    return extractMarkdownRanges(text);
  }

  if (languageId === 'html' || languageId === 'angular-html' || languageId === 'xml' || languageId === 'vue') {
    return extractHtmlRanges(text);
  }

  return extractCodeCommentAndStringRanges(text, allowsLineComments(languageId));
}

function extractMarkdownRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let inFence = false;
  let offset = 0;

  for (const line of text.split(/(\n)/)) {
    if (line === '\n') {
      offset += line.length;
      continue;
    }

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      offset += line.length;
      continue;
    }

    if (!inFence) {
      ranges.push({ start: offset, end: offset + line.length });
    }

    offset += line.length;
  }

  return ranges;
}

function extractHtmlRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const tagStart = text.indexOf('<', cursor);
    if (tagStart === -1) {
      addTextRange(ranges, text, cursor, text.length);
      break;
    }

    addTextRange(ranges, text, cursor, tagStart);

    if (text.startsWith('<!--', tagStart)) {
      const commentEnd = text.indexOf('-->', tagStart + 4);
      const end = commentEnd === -1 ? text.length : commentEnd;
      ranges.push({ start: tagStart + 4, end });
      cursor = commentEnd === -1 ? text.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(text, tagStart);
    if (tagEnd === -1) {
      break;
    }

    const tagName = getOpeningTagName(text.slice(tagStart, tagEnd + 1));
    if (tagName === 'script' || tagName === 'style') {
      const closingStart = text.toLowerCase().indexOf(`</${tagName}`, tagEnd + 1);
      const blockEnd = closingStart === -1 ? text.length : closingStart;
      const blockText = text.slice(tagEnd + 1, blockEnd);
      const blockRanges = tagName === 'script'
        ? extractCodeCommentAndStringRanges(blockText, true)
        : extractCodeCommentAndStringRanges(blockText, false);
      ranges.push(...blockRanges.map((range) => ({
        start: range.start + tagEnd + 1,
        end: range.end + tagEnd + 1
      })));

      if (closingStart === -1) {
        cursor = text.length;
      } else {
        const closingEnd = findTagEnd(text, closingStart);
        cursor = closingEnd === -1 ? text.length : closingEnd + 1;
      }
      continue;
    }

    cursor = tagEnd + 1;
  }

  return ranges;
}

function extractCodeCommentAndStringRanges(text: string, allowLineComments = true): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (allowLineComments && char === '/' && next === '/') {
      const start = index + 2;
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      ranges.push({ start, end });
      index = end;
      continue;
    }

    if (char === '/' && next === '*') {
      const start = index + 2;
      const close = text.indexOf('*/', start);
      const end = close === -1 ? text.length : close;
      ranges.push({ start, end });
      index = close === -1 ? text.length : close + 2;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const start = index + 1;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          break;
        }
        index += 1;
      }
      ranges.push({ start, end: Math.min(index, text.length) });
      index += 1;
      continue;
    }

    index += 1;
  }

  return ranges;
}

async function createCSpellSettings(languageId: string, options: SpellOptions): Promise<CSpellUserSettings> {
  const bundledSettings = await getBundledSettings();
  const extensionSettings: CSpellUserSettings = {
    language: options.locale ?? 'en',
    languageId: normalizeLanguageId(languageId),
    dictionaries: DEFAULT_DICTIONARIES,
    words: uniqueWords([...DEFAULT_FRONTEND_WORDS, ...(options.userWords ?? [])]),
    ignoreWords: uniqueWords(options.ignoreWords ?? []),
    flagWords: [...DEFAULT_FLAG_WORDS, ...(options.flagWords ?? [])],
    allowCompoundWords: true,
    minWordLength: options.minWordLength ?? DEFAULT_SPELL_OPTIONS.minWordLength
  };

  return mergeSettings(bundledSettings, extensionSettings);
}

function getBundledSettings(): Promise<CSpellUserSettings> {
  bundledSettingsPromise ??= getDefaultBundledSettingsAsync();
  return bundledSettingsPromise;
}

function issueToMisspelling(issue: ValidationIssue): Misspelling {
  const word = issue.text;
  const start = issue.offset;
  const end = start + (issue.length ?? word.length);
  const suggestions = uniqueSuggestions([
    ...(issue.suggestionsEx ?? []).map((suggestion) => suggestion.wordAdjustedToMatchCase ?? suggestion.word),
    ...(issue.suggestions ?? [])
  ]);

  return {
    word,
    normalizedWord: normalizeWord(word),
    start,
    end,
    suggestions,
    message: issue.message
  };
}

function isIssueInRanges(issue: ValidationIssue, ranges: TextRange[]): boolean {
  const start = issue.offset;
  const end = start + (issue.length ?? issue.text.length);
  return ranges.some((range) => start >= range.start && end <= range.end);
}

function maskTextOutsideRanges(text: string, ranges: TextRange[]): string {
  let output = '';
  let cursor = 0;

  for (const range of ranges) {
    output += maskText(text.slice(cursor, range.start));
    output += text.slice(range.start, range.end);
    cursor = range.end;
  }

  output += maskText(text.slice(cursor));
  return output;
}

function maskText(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

function extractCSpellDirectives(text: string): CSpellDirectives {
  const directives: CSpellDirectives = {
    ignoreWords: [],
    words: []
  };

  const directivePattern = /\bcspell:(ignore|words)\s+([^\r\n]*)/gi;
  for (const match of text.matchAll(directivePattern)) {
    const kind = match[1].toLowerCase();
    const words = extractDirectiveWords(match[2]);
    if (kind === 'ignore') {
      directives.ignoreWords.push(...words);
    } else {
      directives.words.push(...words);
    }
  }

  return directives;
}

function extractDirectiveWords(text: string): string[] {
  return text
    .replace(/-->|\/\/|\/\*|\*\//g, ' ')
    .split(/[\s,;]+/)
    .map((word) => word.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''))
    .filter((word) => /^[A-Za-z][A-Za-z'-]*$/.test(word));
}

function addTextRange(ranges: TextRange[], text: string, start: number, end: number): void {
  if (start >= end) {
    return;
  }

  if (/[A-Za-z]/.test(text.slice(start, end))) {
    ranges.push({ start, end });
  }
}

function getOpeningTagName(tag: string): string | undefined {
  const match = /^<\s*([A-Za-z][A-Za-z0-9:._-]*)\b/.exec(tag);
  return match?.[1].toLowerCase();
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

function allowsLineComments(languageId: string): boolean {
  return languageId !== 'css';
}

function normalizeLanguageId(languageId: string): string {
  if (languageId === 'angular-html') {
    return 'html';
  }

  if (languageId === 'javascriptreact') {
    return 'javascript';
  }

  if (languageId === 'typescriptreact') {
    return 'typescript';
  }

  return languageId;
}

function uniqueWords(words: string[]): string[] {
  return [...new Set(words.map(normalizeWord).filter(Boolean))];
}

function uniqueSuggestions(words: string[]): string[] {
  const seen = new Set<string>();
  const suggestions: string[] = [];

  for (const word of words) {
    const normalizedWord = normalizeWord(word);
    if (!normalizedWord || seen.has(normalizedWord)) {
      continue;
    }

    seen.add(normalizedWord);
    suggestions.push(word);
  }

  return suggestions;
}
