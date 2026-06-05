import { describe, expect, test } from 'bun:test';
import { extractionStampForPage } from '../src/commands/extract.ts';

describe('extract --stale watermark stamp', () => {
  test('stamps at least the extractor version timestamp', () => {
    expect(extractionStampForPage(
      new Date('2026-01-01T00:00:00.000Z'),
      '2026-06-01T00:00:00.000Z',
    )).toBe('2026-06-01T00:00:00.001Z');
  });

  test('keeps newer page updated_at to preserve concurrent-edit staleness', () => {
    expect(extractionStampForPage(
      new Date('2026-06-02T00:00:00.000Z'),
      '2026-06-01T00:00:00.000Z',
    )).toBe('2026-06-02T00:00:00.001Z');
  });
});
