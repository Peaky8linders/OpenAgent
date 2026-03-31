/**
 * Pre-Compressor — reduces redundant content before summarization.
 *
 * Production would use LLMLingua-2 (ONNX). This prototype uses
 * heuristic-based compression: removes tool-use boilerplate, repeated
 * whitespace, common filler patterns, and duplicate lines.
 */

/** Patterns that add no information for summarization */
const BOILERPLATE_PATTERNS: RegExp[] = [
  // Tool use formatting boilerplate — match single-line tags only to avoid
  // greedy cross-line consumption between two tool blocks
  /^<tool_(?:use|result)>.*<\/tool_(?:use|result)>$/gm,
  // Multi-line tool blocks: match opening tag through closing tag per block
  // Uses a structural approach: find <tool_use> then non-greedily match to
  // the NEXT </tool_use> or </tool_result> on its own line
  /^<tool_(?:use|result)>\n(?:(?!<\/tool_(?:use|result)>).)*\n<\/tool_(?:use|result)>$/gms,
  // Repeated blank lines
  /\n{3,}/g,
  // Common filler phrases
  /\b(?:um+|uh+|hmm+|okay so|well basically|you know what I mean)\b/gi,
  // Repeated whitespace
  /[ \t]{2,}/g,
  // ASCII art / decorative lines
  /^[-=~*#]{5,}$/gm,
];

/** Remove exact duplicate lines (keeping first occurrence) */
function deduplicateLines(text: string): string {
  const lines = text.split('\n');
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(line);
    }
  }
  return result.join('\n');
}

export interface CompressionResult {
  compressed: string;
  originalLength: number;
  compressedLength: number;
  compressionRatio: number;
}

/**
 * Compress text by removing boilerplate and redundancy.
 * Returns both compressed text and metrics.
 *
 * The compressed version is used ONLY as summarization input.
 * The original is always preserved in the immutable store.
 */
export function preCompress(text: string): CompressionResult {
  const originalLength = text.length;

  let result = text;

  // Apply boilerplate removal
  for (const pattern of BOILERPLATE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      // For multi-line tool blocks, keep a one-line marker
      if (match.includes('tool_use') || match.includes('tool_result')) {
        return '[tool interaction]';
      }
      // For blank lines, collapse to double newline
      if (/^\n+$/.test(match)) {
        return '\n\n';
      }
      // For whitespace, collapse to single space
      if (/^[ \t]+$/.test(match)) {
        return ' ';
      }
      return '';
    });
  }

  // Deduplicate exact-match lines
  result = deduplicateLines(result);

  // Trim
  result = result.trim();

  const compressedLength = result.length;

  return {
    compressed: result,
    originalLength,
    compressedLength,
    compressionRatio: originalLength > 0 ? originalLength / Math.max(compressedLength, 1) : 1,
  };
}
