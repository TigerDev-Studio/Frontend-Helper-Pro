import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import * as path from 'node:path';
import {
  findCssUnitAtOffset,
  findFirstCssUnitInRange,
  getUnitConversions,
  parseCssUnitValue,
  type CssUnit,
  type CssUnitMatch,
  type UnitConversionOptions
} from './cssUnits.js';
import {
  estimateLocalPackageSize,
  findImportReferences,
  formatImportCost,
  getPackageSpec,
  type ImportCostSize,
  type PackageManifest
} from './importCost.js';
import { findEditedTagAtOffset, findMatchingTag } from './tagMatcher.js';
import { findMisspellings, getSuggestions, normalizeWord } from './spell.js';

const ALL_LANGUAGE_IDS = [
  'html',
  'angular-html',
  'xml',
  'css',
  'scss',
  'sass',
  'less',
  'markdown',
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
  'vue'
];

const CSS_UNIT_LANGUAGE_IDS = [
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'angular-html',
  'vue',
  'javascriptreact',
  'typescriptreact'
];

const IMPORT_COST_LANGUAGE_IDS = [
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
  'vue'
];

const SPELL_SOURCE = 'Frontend Helper Pro';
const SPELL_CODE = 'spelling';

interface PackageContext {
  manifest: PackageManifest;
  directory: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const spellChecker = new SpellCheckerController();
  const importCost = new ImportCostController();

  context.subscriptions.push(
    new AutoRenameController(),
    spellChecker,
    importCost,
    vscode.languages.registerCodeActionsProvider(
      ALL_LANGUAGE_IDS.map((language) => ({ language })),
      new SpellCodeActionProvider(spellChecker),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.languages.registerCodeActionsProvider(
      ALL_LANGUAGE_IDS.map((language) => ({ language })),
      new CssUnitCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite] }
    ),
    vscode.languages.registerCompletionItemProvider(
      CSS_UNIT_LANGUAGE_IDS.map((language) => ({ language })),
      new CssUnitCompletionProvider(),
      'x',
      'm',
      'p',
      'w'
    ),
    vscode.commands.registerCommand('frontend-helper-pro.convertCssUnit', convertCssUnitCommand),
    vscode.commands.registerCommand('frontend-helper-pro.restartSpellCheck', () => spellChecker.validateAll()),
    vscode.commands.registerCommand('frontend-helper-pro.addWordToDictionary', (word: string) => spellChecker.addWordToDictionary(word))
  );
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions automatically.
}

class AutoRenameController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly documentTexts = new Map<string, string>();
  private applyingEdit = false;

  constructor() {
    for (const document of vscode.workspace.textDocuments) {
      this.documentTexts.set(document.uri.toString(), document.getText());
    }

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.documentTexts.set(document.uri.toString(), document.getText());
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.documentTexts.delete(document.uri.toString());
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        void this.onDidChangeTextDocument(event);
      })
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): Promise<void> {
    const documentKey = event.document.uri.toString();
    const previousText = this.documentTexts.get(documentKey);
    const currentText = event.document.getText();
    this.documentTexts.set(documentKey, currentText);

    if (this.applyingEdit || !previousText || event.contentChanges.length !== 1 || !isAutoRenameEnabled(event.document)) {
      return;
    }

    const change = event.contentChanges[0];
    const previousOffsets = new Set([
      change.rangeOffset,
      change.rangeOffset + change.rangeLength,
      change.rangeOffset + change.rangeLength - 1
    ]);
    const currentOffsets = new Set([
      change.rangeOffset + change.text.length,
      change.rangeOffset + change.text.length - 1,
      change.rangeOffset
    ]);

    let previousTag = undefined;
    for (const offset of previousOffsets) {
      previousTag = findEditedTagAtOffset(previousText, offset);
      if (previousTag) {
        break;
      }
    }

    let editedTag = undefined;
    for (const offset of currentOffsets) {
      editedTag = findEditedTagAtOffset(currentText, offset);
      if (editedTag) {
        break;
      }
    }

    if (!previousTag || !editedTag || editedTag.selfClosing || previousTag.type !== editedTag.type) {
      return;
    }

    const matchingTag = findMatchingTag(previousText, previousTag);
    if (!matchingTag || matchingTag.name === editedTag.name) {
      return;
    }

    if (rangesOverlap(matchingTag.nameStart, matchingTag.nameEnd, change.rangeOffset, change.rangeOffset + change.rangeLength)) {
      return;
    }

    const targetNameStart = mapOffsetThroughChange(matchingTag.nameStart, change.rangeOffset, change.rangeLength, change.text.length);
    const targetNameEnd = mapOffsetThroughChange(matchingTag.nameEnd, change.rangeOffset, change.rangeLength, change.text.length);
    if (targetNameStart === undefined || targetNameEnd === undefined || currentText.slice(targetNameStart, targetNameEnd) === editedTag.name) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      event.document.uri,
      new vscode.Range(event.document.positionAt(targetNameStart), event.document.positionAt(targetNameEnd)),
      editedTag.name
    );

    this.applyingEdit = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.applyingEdit = false;
    }
  }
}

class SpellCheckerController implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('frontend-helper-pro.spelling');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.disposables.push(
      this.diagnostics,
      vscode.workspace.onDidOpenTextDocument((document) => this.scheduleValidation(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.scheduleValidation(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.clearDocument(document)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('frontendHelperPro.spellCheck')
          || event.affectsConfiguration('cSpell')
          || event.affectsConfiguration('cspell')
        ) {
          this.validateAll();
        }
      })
    );

    this.validateAll();
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  validateAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.scheduleValidation(document);
    }
  }

  async addWordToDictionary(word: string): Promise<void> {
    const normalizedWord = normalizeWord(word);
    if (!normalizedWord) {
      return;
    }

    const config = vscode.workspace.getConfiguration('frontendHelperPro.spellCheck');
    const current = config.get<string[]>('dictionary', []);
    if (current.map(normalizeWord).includes(normalizedWord)) {
      return;
    }

    const next = [...current, normalizedWord].sort((left, right) => left.localeCompare(right));
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config.update('dictionary', next, target);
    this.validateAll();
  }

  private scheduleValidation(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.validateDocument(document);
    }, 250);
    this.timers.set(key, timer);
  }

  private async validateDocument(document: vscode.TextDocument): Promise<void> {
    if (!isSpellCheckEnabled(document)) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const version = document.version;
    const config = vscode.workspace.getConfiguration('frontendHelperPro.spellCheck', document.uri);
    const misspellings = await findMisspellings(document.getText(), document.languageId, {
      userWords: config.get<string[]>('dictionary', []),
      ignoreWords: config.get<string[]>('ignoreWords', []),
      flagWords: config.get<string[]>('flagWords', []),
      locale: config.get<string>('locale', 'en'),
      maxDiagnostics: config.get<number>('maxDiagnostics', 200),
      numSuggestions: config.get<number>('numSuggestions', 4),
      minWordLength: config.get<number>('minWordLength', 4)
    });

    if (document.version !== version || !isSpellCheckEnabled(document)) {
      return;
    }

    const diagnostics = misspellings.map((misspelling) => {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(document.positionAt(misspelling.start), document.positionAt(misspelling.end)),
        misspelling.message ?? `Possible spelling mistake: "${misspelling.word}"`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = SPELL_SOURCE;
      diagnostic.code = SPELL_CODE;
      return diagnostic;
    });

    this.diagnostics.set(document.uri, diagnostics);
  }

  private clearDocument(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.diagnostics.delete(document.uri);
  }
}

class SpellCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly spellChecker: SpellCheckerController) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): Promise<vscode.CodeAction[]> {
    const spellingDiagnostics = context.diagnostics.filter((diagnostic) => {
      return diagnostic.source === SPELL_SOURCE && diagnostic.code === SPELL_CODE;
    });

    if (!spellingDiagnostics.length) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];
    const config = vscode.workspace.getConfiguration('frontendHelperPro.spellCheck', document.uri);
    const suggestionOptions = {
      userWords: config.get<string[]>('dictionary', []),
      ignoreWords: config.get<string[]>('ignoreWords', []),
      flagWords: config.get<string[]>('flagWords', []),
      locale: config.get<string>('locale', 'en'),
      numSuggestions: config.get<number>('numSuggestions', 4),
      minWordLength: config.get<number>('minWordLength', 4)
    };

    for (const diagnostic of spellingDiagnostics) {
      const word = document.getText(diagnostic.range);
      const suggestions = await getSuggestions(word, document.languageId, suggestionOptions);

      for (const [index, suggestion] of suggestions.entries()) {
        const action = new vscode.CodeAction(`Replace with "${suggestion}"`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = index === 0;
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, preserveWordCase(word, suggestion));
        actions.push(action);
      }

      const addWord = new vscode.CodeAction(`Add "${normalizeWord(word)}" to workspace dictionary`, vscode.CodeActionKind.QuickFix);
      addWord.diagnostics = [diagnostic];
      addWord.command = {
        command: 'frontend-helper-pro.addWordToDictionary',
        title: 'Add word to dictionary',
        arguments: [word]
      };
      actions.push(addWord);
    }

    return actions;
  }
}

class CssUnitCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.ProviderResult<vscode.CodeAction[]> {
    if (!isCssUnitEnabled(document)) {
      return [];
    }

    const match = getCssUnitMatch(document, range);
    if (!match) {
      return [];
    }

    const options = getCssUnitOptions(document.uri);
    return getUnitConversions(match, options).map((conversion) => {
      const action = new vscode.CodeAction(`Convert to ${conversion.replacement}`, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(match.start), document.positionAt(match.end)),
        conversion.replacement
      );
      return action;
    });
  }
}

class CssUnitCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (!isCssUnitCompletionEnabled(document)) {
      return [];
    }

    const match = findCssUnitAtOffset(document.getText(), document.offsetAt(position));
    if (!match) {
      return [];
    }

    const targetUnits = getCssUnitCompletionTargetUnits(document.uri, match.unit);
    const conversions = getUnitConversions(match, getCssUnitOptions(document.uri))
      .filter((conversion) => targetUnits.includes(conversion.unit));

    return conversions.map((conversion, index) => {
      const item = new vscode.CompletionItem(conversion.replacement, vscode.CompletionItemKind.Value);
      item.detail = `${match.text} -> ${conversion.replacement}`;
      item.documentation = `Convert ${match.text} to ${conversion.unit}.`;
      item.filterText = `${match.text} ${conversion.replacement} ${conversion.unit}`;
      item.insertText = conversion.replacement;
      item.range = new vscode.Range(document.positionAt(match.start), document.positionAt(match.end));
      item.sortText = `0${index}`;
      return item;
    });
  }
}

class ImportCostController implements vscode.Disposable {
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 1rem',
      color: new vscode.ThemeColor('terminal.ansiGreen'),
      fontStyle: 'normal'
    }
  });
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly sizeCache = new Map<string, Promise<ImportCostSize | undefined>>();
  private readonly manifestCache = new Map<string, Promise<PackageContext | undefined>>();

  constructor() {
    this.disposables.push(
      this.decorationType,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.scheduleUpdate(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.scheduleUpdate(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.uri.toString() === event.document.uri.toString()) {
            this.scheduleUpdate(editor);
          }
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('frontendHelperPro.importCost')) {
          this.refreshVisibleEditors();
        }
      })
    );

    this.refreshVisibleEditors();
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private refreshVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.scheduleUpdate(editor);
    }
  }

  private scheduleUpdate(editor: vscode.TextEditor): void {
    const key = editor.document.uri.toString();
    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.updateEditor(editor);
    }, 350);
    this.timers.set(key, timer);
  }

  private async updateEditor(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    if (!isImportCostEnabled(document)) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const config = vscode.workspace.getConfiguration('frontendHelperPro.importCost', document.uri);
    const maxImports = config.get<number>('maxImports', 25);
    const showGzip = config.get<boolean>('showGzip', true);
    const timeoutMs = config.get<number>('timeoutMs', 6000);
    const version = document.version;
    const references = findImportReferences(document.getText()).slice(0, maxImports);
    if (!references.length) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const packageContext = await this.getPackageContext(document.uri);
    const lineLabels = new Map<number, string[]>();
    const lineHoverMessages = new Map<number, vscode.MarkdownString[]>();

    await Promise.all(references.map(async (reference) => {
      const packageSpec = getPackageSpec(reference.packageName, packageContext?.manifest);
      const size = await this.getImportSize(packageSpec, reference.packageName, packageContext?.directory, timeoutMs);
      if (!size) {
        return;
      }

      const label = formatImportCost(size, showGzip);
      const hover = new vscode.MarkdownString(undefined, true);
      hover.appendMarkdown(`**${reference.packageName}** import cost\n\n`);
      hover.appendMarkdown(`- Package: \`${size.name}${size.version ? `@${size.version}` : ''}\`\n`);
      hover.appendMarkdown(`- Minified: \`${formatImportCost({ size: size.size }, false)}\`\n`);
      if (size.gzip !== undefined) {
        hover.appendMarkdown(`- Gzip: \`${formatImportCost({ size: size.gzip }, false)}\`\n`);
      }
      if (size.dependencyCount !== undefined) {
        hover.appendMarkdown(`- Dependencies: \`${size.dependencyCount}\`\n`);
      }
      if (size.source === 'local') {
        hover.appendMarkdown('\n_Local estimate from installed package entry file._\n');
      }

      lineLabels.set(reference.line, [...(lineLabels.get(reference.line) ?? []), label]);
      lineHoverMessages.set(reference.line, [...(lineHoverMessages.get(reference.line) ?? []), hover]);
    }));

    if (document.version !== version || !isImportCostEnabled(document)) {
      return;
    }

    const decorations: vscode.DecorationOptions[] = [...lineLabels.entries()].map(([line, labels]) => {
      const lineEnd = document.lineAt(line).range.end;
      return {
        range: new vscode.Range(lineEnd, lineEnd),
        hoverMessage: lineHoverMessages.get(line),
        renderOptions: {
          after: {
            contentText: `  ${labels.join(', ')}`
          }
        }
      };
    });

    editor.setDecorations(this.decorationType, decorations);
  }

  private getImportSize(packageSpec: string, packageName: string, packageDirectory: string | undefined, timeoutMs: number): Promise<ImportCostSize | undefined> {
    const cacheKey = `${packageSpec}|${packageDirectory ?? ''}`;
    const cached = this.sizeCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const request = fetchBundlephobiaSize(packageSpec, timeoutMs)
      .catch(() => packageDirectory ? estimateLocalPackageSize(packageDirectory, packageName) : undefined);
    this.sizeCache.set(cacheKey, request);
    return request;
  }

  private getPackageContext(uri: vscode.Uri): Promise<PackageContext | undefined> {
    if (uri.scheme !== 'file') {
      return Promise.resolve(undefined);
    }

    const startDirectory = path.dirname(uri.fsPath);
    const cached = this.manifestCache.get(startDirectory);
    if (cached) {
      return cached;
    }

    const request = findNearestPackageContext(startDirectory).catch(() => undefined);
    this.manifestCache.set(startDirectory, request);
    return request;
  }
}

async function convertCssUnitCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCssUnitEnabled(editor.document)) {
    return;
  }

  const match = getCssUnitMatch(editor.document, editor.selection);
  if (!match) {
    void vscode.window.showInformationMessage('Place the cursor on a px, rem, rpx, or vw value to convert it.');
    return;
  }

  const conversions = getUnitConversions(match, getCssUnitOptions(editor.document.uri));
  const pick = await vscode.window.showQuickPick(
    conversions.map((conversion) => ({
      label: conversion.replacement,
      description: `${match.text} to ${conversion.unit}`,
      conversion
    })),
    { placeHolder: `Convert ${match.text} to...` }
  );

  if (!pick) {
    return;
  }

  await editor.edit((editBuilder) => {
    editBuilder.replace(
      new vscode.Range(editor.document.positionAt(match.start), editor.document.positionAt(match.end)),
      pick.conversion.replacement
    );
  });
}

function getCssUnitMatch(document: vscode.TextDocument, range: vscode.Range | vscode.Selection): CssUnitMatch | undefined {
  const text = document.getText();
  if (!range.isEmpty) {
    const selected = document.getText(range);
    const parsed = parseCssUnitValue(selected);
    if (parsed) {
      const start = document.offsetAt(range.start);
      return {
        ...parsed,
        start,
        end: start + selected.length
      };
    }

    return findFirstCssUnitInRange(text, document.offsetAt(range.start), document.offsetAt(range.end));
  }

  const offset = document.offsetAt(range.start);
  return findCssUnitAtOffset(text, offset) ?? findCssUnitAtOffset(text, Math.max(0, offset - 1));
}

function getCssUnitOptions(scope: vscode.Uri): UnitConversionOptions {
  const config = vscode.workspace.getConfiguration('frontendHelperPro.cssUnit', scope);
  return {
    baseFontSize: config.get<number>('baseFontSize', 16),
    viewportWidth: config.get<number>('viewportWidth', 375),
    rpxDesignWidth: config.get<number>('rpxDesignWidth', 750),
    precision: config.get<number>('precision', 4)
  };
}

function getCssUnitCompletionTargetUnits(scope: vscode.Uri, sourceUnit: CssUnit): CssUnit[] {
  const config = vscode.workspace.getConfiguration('frontendHelperPro.cssUnit.completion', scope);
  const configuredUnits = config.get<string[]>('targetUnits', ['rem', 'rpx', 'vw']);
  const validUnits = new Set<CssUnit>(['px', 'rem', 'rpx', 'vw']);
  const targetUnits = configuredUnits.filter((unit): unit is CssUnit => validUnits.has(unit as CssUnit) && unit !== sourceUnit);

  return targetUnits.length ? targetUnits : [...validUnits].filter((unit) => unit !== sourceUnit);
}

function isAutoRenameEnabled(document: vscode.TextDocument): boolean {
  const config = vscode.workspace.getConfiguration('frontendHelperPro.autoRename', document.uri);
  return config.get<boolean>('enabled', true) && config.get<string[]>('languages', []).includes(document.languageId);
}

function isSpellCheckEnabled(document: vscode.TextDocument): boolean {
  const config = vscode.workspace.getConfiguration('frontendHelperPro.spellCheck', document.uri);
  return config.get<boolean>('enabled', true) && config.get<string[]>('languages', []).includes(document.languageId);
}

function isCssUnitEnabled(document: vscode.TextDocument): boolean {
  const config = vscode.workspace.getConfiguration('frontendHelperPro.cssUnit', document.uri);
  return config.get<boolean>('enabled', true) && config.get<string[]>('languages', []).includes(document.languageId);
}

function isCssUnitCompletionEnabled(document: vscode.TextDocument): boolean {
  if (!isCssUnitEnabled(document)) {
    return false;
  }

  const config = vscode.workspace.getConfiguration('frontendHelperPro.cssUnit.completion', document.uri);
  return config.get<boolean>('enabled', true);
}

function isImportCostEnabled(document: vscode.TextDocument): boolean {
  const config = vscode.workspace.getConfiguration('frontendHelperPro.importCost', document.uri);
  return config.get<boolean>('enabled', true) && config.get<string[]>('languages', []).includes(document.languageId);
}

async function findNearestPackageContext(startDirectory: string): Promise<PackageContext | undefined> {
  let currentDirectory = startDirectory;

  while (true) {
    const manifestPath = path.join(currentDirectory, 'package.json');
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      return {
        manifest: JSON.parse(raw) as PackageManifest,
        directory: currentDirectory
      };
    } catch {
      // Continue walking up until the filesystem root.
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function fetchBundlephobiaSize(packageSpec: string, timeoutMs: number): Promise<ImportCostSize> {
  return new Promise((resolve, reject) => {
    const url = new URL('https://bundlephobia.com/api/size');
    url.searchParams.set('package', packageSpec);

    const request = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Frontend-Helper-Pro'
      },
      timeout: timeoutMs
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Bundlephobia returned ${response.statusCode ?? 'unknown status'}`));
          return;
        }

        const data = JSON.parse(body) as {
          name?: string;
          version?: string;
          size?: number;
          gzip?: number;
          dependencyCount?: number;
          error?: string;
        };
        if (data.error || typeof data.size !== 'number') {
          reject(new Error(data.error ?? 'Bundlephobia response did not include a size'));
          return;
        }

        resolve({
          packageSpec,
          name: data.name ?? packageSpec,
          version: data.version,
          size: data.size,
          gzip: data.gzip,
          dependencyCount: data.dependencyCount,
          source: 'bundlephobia'
        });
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Bundlephobia request timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  });
}

function mapOffsetThroughChange(offset: number, changeStart: number, oldLength: number, newLength: number): number | undefined {
  if (offset <= changeStart) {
    return offset;
  }

  const changeEnd = changeStart + oldLength;
  if (offset >= changeEnd) {
    return offset + newLength - oldLength;
  }

  return undefined;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function preserveWordCase(original: string, replacement: string): string {
  if (original.toUpperCase() === original) {
    return replacement.toUpperCase();
  }

  if (original[0]?.toUpperCase() === original[0]) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }

  return replacement;
}
