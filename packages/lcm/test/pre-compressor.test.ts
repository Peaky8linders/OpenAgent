import { describe, it, expect } from 'vitest';
import { preCompress } from '../src/ingestion/pre-compressor.js';

describe('Pre-Compressor', () => {
  it('compresses repeated blank lines', () => {
    const input = 'Line 1\n\n\n\n\nLine 2';
    const result = preCompress(input);
    expect(result.compressed).toBe('Line 1\n\nLine 2');
    expect(result.compressionRatio).toBeGreaterThan(1);
  });

  it('compresses repeated whitespace', () => {
    const input = 'Hello     world    test';
    const result = preCompress(input);
    expect(result.compressed).toBe('Hello world test');
  });

  it('removes duplicate lines', () => {
    const input = 'Line A\nLine B\nLine A\nLine C\nLine B';
    const result = preCompress(input);
    expect(result.compressed).toBe('Line A\nLine B\nLine C');
  });

  it('preserves blank lines between unique content', () => {
    const input = 'Paragraph 1\n\nParagraph 2';
    const result = preCompress(input);
    expect(result.compressed).toBe('Paragraph 1\n\nParagraph 2');
  });

  it('handles empty input', () => {
    const result = preCompress('');
    expect(result.compressed).toBe('');
    expect(result.compressionRatio).toBe(1);
  });

  it('returns ratio 1 for incompressible text', () => {
    const input = 'Unique content here';
    const result = preCompress(input);
    expect(result.compressionRatio).toBeGreaterThanOrEqual(1);
  });

  it('removes decorative ASCII lines', () => {
    const input = 'Header\n==========\nContent\n----------\nFooter';
    const result = preCompress(input);
    expect(result.compressed).not.toContain('==========');
    expect(result.compressed).not.toContain('----------');
    expect(result.compressed).toContain('Header');
    expect(result.compressed).toContain('Content');
  });

  it('reports accurate metrics', () => {
    const input = 'A\n\n\n\n\nB\n\n\n\n\nC';
    const result = preCompress(input);
    expect(result.originalLength).toBe(input.length);
    expect(result.compressedLength).toBeLessThan(result.originalLength);
    expect(result.compressionRatio).toBe(result.originalLength / result.compressedLength);
  });
});
