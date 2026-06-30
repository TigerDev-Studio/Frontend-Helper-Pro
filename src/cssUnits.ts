export type CssUnit = 'px' | 'rem' | 'rpx' | 'vw';

export interface UnitConversionOptions {
  baseFontSize: number;
  viewportWidth: number;
  rpxDesignWidth: number;
  precision: number;
}

export interface CssUnitMatch {
  value: number;
  unit: CssUnit;
  start: number;
  end: number;
  text: string;
}

export interface CssUnitConversion {
  unit: CssUnit;
  value: number;
  replacement: string;
}

const CSS_UNIT_PATTERN = /(-?(?:\d+|\d*\.\d+))(px|rem|rpx|vw)\b/g;
const UNITS: CssUnit[] = ['px', 'rem', 'rpx', 'vw'];

export function parseCssUnitValue(text: string): Omit<CssUnitMatch, 'start' | 'end'> | undefined {
  const match = /^(-?(?:\d+|\d*\.\d+))(px|rem|rpx|vw)$/i.exec(text.trim());
  if (!match) {
    return undefined;
  }

  const unit = match[2].toLowerCase() as CssUnit;
  return {
    value: Number(match[1]),
    unit,
    text: match[0]
  };
}

export function findCssUnitAtOffset(text: string, offset: number): CssUnitMatch | undefined {
  CSS_UNIT_PATTERN.lastIndex = 0;
  const safeOffset = Math.max(0, Math.min(text.length, offset));

  for (const match of text.matchAll(CSS_UNIT_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (safeOffset >= start && safeOffset <= end) {
      return {
        value: Number(match[1]),
        unit: match[2].toLowerCase() as CssUnit,
        start,
        end,
        text: match[0]
      };
    }
  }

  return undefined;
}

export function findFirstCssUnitInRange(text: string, startOffset: number, endOffset: number): CssUnitMatch | undefined {
  CSS_UNIT_PATTERN.lastIndex = 0;
  const startRange = Math.max(0, Math.min(startOffset, endOffset));
  const endRange = Math.min(text.length, Math.max(startOffset, endOffset));

  for (const match of text.matchAll(CSS_UNIT_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start < endRange && end > startRange) {
      return {
        value: Number(match[1]),
        unit: match[2].toLowerCase() as CssUnit,
        start,
        end,
        text: match[0]
      };
    }
  }

  return undefined;
}

export function convertCssUnit(value: number, from: CssUnit, to: CssUnit, options: UnitConversionOptions): number {
  if (from === to) {
    return value;
  }

  const px = toPx(value, from, options);
  return fromPx(px, to, options);
}

export function getUnitConversions(match: Pick<CssUnitMatch, 'value' | 'unit'>, options: UnitConversionOptions): CssUnitConversion[] {
  return UNITS
    .filter((unit) => unit !== match.unit)
    .map((unit) => {
      const value = convertCssUnit(match.value, match.unit, unit, options);
      return {
        unit,
        value,
        replacement: `${formatNumber(value, options.precision)}${unit}`
      };
    });
}

export function formatNumber(value: number, precision: number): string {
  const fixed = value.toFixed(Math.max(0, precision));
  return fixed.replace(/\.?0+$/, '');
}

function toPx(value: number, unit: CssUnit, options: UnitConversionOptions): number {
  switch (unit) {
    case 'px':
      return value;
    case 'rem':
      return value * options.baseFontSize;
    case 'rpx':
      return (value * options.viewportWidth) / options.rpxDesignWidth;
    case 'vw':
      return (value * options.viewportWidth) / 100;
  }
}

function fromPx(value: number, unit: CssUnit, options: UnitConversionOptions): number {
  switch (unit) {
    case 'px':
      return value;
    case 'rem':
      return value / options.baseFontSize;
    case 'rpx':
      return (value * options.rpxDesignWidth) / options.viewportWidth;
    case 'vw':
      return (value / options.viewportWidth) * 100;
  }
}
