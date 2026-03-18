/**
 * PII Detector — regex-based detection for common PII patterns.
 *
 * Production would use Microsoft Presidio or similar NLP-based system.
 * This prototype uses high-confidence regex patterns with low false-positive rates.
 */
import type { PiiAnnotation, PiiType } from '../types/index.js';

interface PiiPattern {
  type: PiiType;
  regex: RegExp;
  confidence: number;
}

const PII_PATTERNS: PiiPattern[] = [
  {
    type: 'email',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    confidence: 0.95,
  },
  {
    type: 'phone',
    // US phone: (xxx) xxx-xxxx, xxx-xxx-xxxx, +1xxxxxxxxxx
    regex: /(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    confidence: 0.7,
  },
  {
    type: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: 0.9,
  },
  {
    type: 'credit_card',
    // Luhn-checkable 13-19 digit numbers with optional separators
    regex: /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g,
    confidence: 0.75,
  },
  {
    type: 'api_key',
    // Common API key patterns: sk-xxx, AKIA..., ghp_, xox[bpas]-
    regex: /\b(?:sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|xox[bpas]-[a-zA-Z0-9-]+)\b/g,
    confidence: 0.95,
  },
  {
    type: 'aws_key',
    regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
    confidence: 0.95,
  },
  {
    type: 'ip_address',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    confidence: 0.6,
  },
  {
    type: 'jwt',
    regex: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    confidence: 0.95,
  },
];

export function detectPii(text: string): PiiAnnotation[] {
  const annotations: PiiAnnotation[] = [];

  for (const pattern of PII_PATTERNS) {
    // Reset regex state for global patterns
    pattern.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      annotations.push({
        type: pattern.type,
        start: match.index,
        end: match.index + match[0].length,
        confidence: pattern.confidence,
      });
    }
  }

  // Sort by position
  annotations.sort((a, b) => a.start - b.start);
  return annotations;
}

/**
 * Redact PII in text, replacing detected spans with [REDACTED:<type>]
 */
export function redactPii(text: string, annotations: PiiAnnotation[]): string {
  if (annotations.length === 0) return text;

  // Process from end to start to preserve indices
  const sorted = [...annotations].sort((a, b) => b.start - a.start);
  let result = text;
  for (const ann of sorted) {
    const replacement = `[REDACTED:${ann.type}]`;
    result = result.slice(0, ann.start) + replacement + result.slice(ann.end);
  }
  return result;
}
