import { describe, it, expect } from 'vitest';
import { detectPii, redactPii } from '../src/ingestion/pii-detector.js';

describe('PII Detector', () => {
  describe('email detection', () => {
    it('detects standard emails', () => {
      const results = detectPii('Contact us at user@example.com for help');
      const emails = results.filter((r) => r.type === 'email');
      expect(emails).toHaveLength(1);
      expect(emails[0].confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('detects emails with subdomains', () => {
      const results = detectPii('Send to admin@mail.corp.example.co.uk');
      expect(results.filter((r) => r.type === 'email')).toHaveLength(1);
    });

    it('does not false-positive on @mentions', () => {
      // @mentions without TLD should not match
      const results = detectPii('Hey @user check this out');
      expect(results.filter((r) => r.type === 'email')).toHaveLength(0);
    });
  });

  describe('SSN detection', () => {
    it('detects SSN format', () => {
      const results = detectPii('My SSN is 123-45-6789');
      const ssns = results.filter((r) => r.type === 'ssn');
      expect(ssns).toHaveLength(1);
    });

    it('does not match phone-like numbers', () => {
      const results = detectPii('Call 555-123-4567');
      const ssns = results.filter((r) => r.type === 'ssn');
      expect(ssns).toHaveLength(0);
    });
  });

  describe('API key detection', () => {
    it('detects OpenAI-style keys', () => {
      const results = detectPii('Use sk-abcdefghijklmnopqrstuvwxyz1234567890');
      const keys = results.filter((r) => r.type === 'api_key');
      expect(keys).toHaveLength(1);
    });

    it('detects GitHub tokens', () => {
      const results = detectPii('Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890');
      const keys = results.filter((r) => r.type === 'api_key');
      expect(keys).toHaveLength(1);
    });
  });

  describe('AWS key detection', () => {
    it('detects AKIA keys', () => {
      const results = detectPii('aws_access_key = AKIAIOSFODNN7EXAMPLE');
      const keys = results.filter((r) => r.type === 'aws_key');
      expect(keys).toHaveLength(1);
    });
  });

  describe('JWT detection', () => {
    it('detects JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const results = detectPii(`Bearer ${jwt}`);
      const jwts = results.filter((r) => r.type === 'jwt');
      expect(jwts).toHaveLength(1);
    });
  });

  describe('IP address detection', () => {
    it('detects IPv4 addresses', () => {
      const results = detectPii('Server at 192.168.1.100 is down');
      const ips = results.filter((r) => r.type === 'ip_address');
      expect(ips).toHaveLength(1);
    });

    it('rejects invalid IPs', () => {
      const results = detectPii('Version 999.999.999.999 is out');
      const ips = results.filter((r) => r.type === 'ip_address');
      expect(ips).toHaveLength(0);
    });
  });

  describe('no false positives', () => {
    it('clean text produces no detections', () => {
      const results = detectPii('The quick brown fox jumps over the lazy dog');
      expect(results).toHaveLength(0);
    });

    it('code snippets do not trigger PII', () => {
      const results = detectPii('const x = arr.map(item => item.value)');
      const emails = results.filter((r) => r.type === 'email');
      expect(emails).toHaveLength(0);
    });
  });

  describe('redaction', () => {
    it('redacts detected PII', () => {
      const text = 'Contact user@example.com or call 123-45-6789';
      const annotations = detectPii(text);
      const redacted = redactPii(text, annotations);

      expect(redacted).toContain('[REDACTED:email]');
      expect(redacted).not.toContain('user@example.com');
    });

    it('handles empty annotations', () => {
      const text = 'No PII here';
      expect(redactPii(text, [])).toBe(text);
    });

    it('handles multiple adjacent PII items', () => {
      const text = 'user@a.com user@b.com';
      const annotations = detectPii(text);
      const redacted = redactPii(text, annotations);
      expect(redacted).not.toContain('user@a.com');
      expect(redacted).not.toContain('user@b.com');
    });
  });
});
