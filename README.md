# Frontend Helper Pro

All-in-one VS Code extension for frontend developers.

Publisher: [TigerDev1991](https://marketplace.visualstudio.com/publishers/TigerDev1991)

## Features

- Auto rename paired HTML/XML/JSX tags while editing either the opening or closing tag.
- CSpell-backed spell check for comments, strings, Markdown, and HTML text with Quick Fix suggestions.
- Convert CSS units between `px`, `rem`, `rpx`, and `vw`.
- Type CSS values like `16px` and accept a suggestion such as `1rem`, `32rpx`, or `4.2667vw`.
- Show inline import cost annotations for JavaScript, TypeScript, React, and Vue package imports.
- Quick Fix support for spelling and unit conversion.
- Works with HTML, CSS, SCSS, Sass, Less, React, Angular templates, Vue, XML, and Markdown.

Perfect for frontend, AEM, React, Angular, and Vue developers.

## Commands

- `Frontend Helper Pro: Convert CSS Unit`
- `Frontend Helper Pro: Restart Spell Check`

## Settings

- `frontendHelperPro.autoRename.enabled`
- `frontendHelperPro.autoRename.languages`
- `frontendHelperPro.spellCheck.enabled`
- `frontendHelperPro.spellCheck.dictionary`
- `frontendHelperPro.spellCheck.ignoreWords`
- `frontendHelperPro.spellCheck.flagWords`
- `frontendHelperPro.spellCheck.locale`
- `frontendHelperPro.spellCheck.numSuggestions`
- `frontendHelperPro.spellCheck.minWordLength`
- `frontendHelperPro.cssUnit.baseFontSize`
- `frontendHelperPro.cssUnit.viewportWidth`
- `frontendHelperPro.cssUnit.rpxDesignWidth`
- `frontendHelperPro.cssUnit.precision`
- `frontendHelperPro.cssUnit.completion.enabled`
- `frontendHelperPro.cssUnit.completion.targetUnits`
- `frontendHelperPro.importCost.enabled`
- `frontendHelperPro.importCost.languages`
- `frontendHelperPro.importCost.showGzip`
- `frontendHelperPro.importCost.maxImports`
- `frontendHelperPro.importCost.timeoutMs`

## Development

```sh
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch an Extension Development Host.

## Import Cost Notes

Import cost annotations are inspired by [wix/import-cost](https://github.com/wix/import-cost). The extension scans package imports such as:

```ts
import React from 'react';
import { debounce } from 'lodash-es';
```

It then shows inline minified and gzip sizes using package-size data:

```ts
import React from 'react';  4.6k (gzipped: 1.9k)
```

Relative imports and Node built-ins are ignored. If a package is not available from the remote size service, the extension falls back to an installed `node_modules` package entry file when possible, which helps with private scoped packages.

## Spell Check Notes

The spell checker uses CSpell dictionaries for English, frontend terms, HTML, CSS, and TypeScript. It supports workspace dictionary words and common in-document directives such as:

```md
<!-- cspell:ignore projectword -->
<!-- cspell:words Acmefront -->
```
