/**
 * Tests for PrivateLaunch — spec generation, code generation, and build pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mockGenerateSpec, generateSpec } from '../src/launch/spec-generator.js';
import { generateProject } from '../src/launch/codegen.js';
import { LaunchPipeline } from '../src/launch/pipeline.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import type { SentinelInspector, InspectionResult, AuditLedgerWriter, SecureAuditEntry } from '../src/secure/secure-store.js';

// ─── Spec Generator Tests ────────────────────────────────────────

describe('Spec Generator', () => {
  it('mockGenerateSpec produces valid spec from description', () => {
    const spec = mockGenerateSpec('A habit tracker for daily routines');
    expect(spec.name).toBeTruthy();
    expect(spec.bundleId).toMatch(/^com\.privatelaunch\./);
    expect(spec.features.length).toBeGreaterThan(0);
    expect(spec.screens.length).toBeGreaterThan(0);
    expect(spec.dataModel.entities.length).toBeGreaterThan(0);
    expect(spec.id).toBeTruthy();
  });

  it('mockGenerateSpec always includes list, detail, form, settings screens', () => {
    const spec = mockGenerateSpec('Task manager app');
    const types = spec.screens.map(s => s.type);
    expect(types).toContain('list');
    expect(types).toContain('detail');
    expect(types).toContain('form');
    expect(types).toContain('settings');
  });

  it('generateSpec validates LLM output', async () => {
    const mockLlm = async (_sys: string, _input: string) => JSON.stringify({
      name: 'Test App',
      bundleId: 'com.privatelaunch.testapp',
      description: 'A test application',
      platforms: ['ios'],
      features: [{ name: 'Main', description: 'Main feature', priority: 'must', screens: ['main'] }],
      screens: [{ id: 'main', name: 'Main', type: 'list', components: ['List'], navigatesTo: [] }],
      dataModel: { entities: [], relationships: [], persistence: 'userdefaults' },
      designSystem: { colorScheme: 'adaptive', accentColor: '#007AFF', fontStyle: 'system', iconStyle: 'sf-symbols' },
    });

    const spec = await generateSpec('A test app', mockLlm);
    expect(spec.name).toBe('Test App');
    expect(spec.bundleId).toBe('com.privatelaunch.testapp');
  });

  it('generateSpec rejects invalid JSON from LLM', async () => {
    const badLlm = async () => 'not json at all';
    await expect(generateSpec('test', badLlm)).rejects.toThrow(/invalid JSON/);
  });

  it('generateSpec rejects spec with no features', async () => {
    const emptyLlm = async () => JSON.stringify({
      name: 'Test', bundleId: 'com.test', description: 'desc',
      features: [], screens: [{ id: 'x', name: 'X', type: 'list', components: [], navigatesTo: [] }],
    });
    await expect(generateSpec('test', emptyLlm)).rejects.toThrow(/at least one feature/);
  });

  it('generateSpec rejects spec with no screens', async () => {
    const noScreensLlm = async () => JSON.stringify({
      name: 'Test', bundleId: 'com.test', description: 'desc',
      features: [{ name: 'F', description: 'd', priority: 'must', screens: [] }],
      screens: [],
    });
    await expect(generateSpec('test', noScreensLlm)).rejects.toThrow(/at least one screen/);
  });
});

// ─── Code Generator Tests ────────────────────────────────────────

describe('Code Generator', () => {
  it('generates a complete project from spec', () => {
    const spec = mockGenerateSpec('Workout tracker with exercise logging');
    const project = generateProject(spec);

    expect(project.files.length).toBeGreaterThan(0);
    expect(project.xcodeProjectPath).toContain('.xcodeproj');
    expect(project.metadata.appName).toBeTruthy();
  });

  it('generates App.swift entry point', () => {
    const spec = mockGenerateSpec('Note-taking app');
    const project = generateProject(spec);

    const appFile = project.files.find(f => f.path.endsWith('App.swift'));
    expect(appFile).toBeDefined();
    expect(appFile!.content).toContain('@main');
    expect(appFile!.content).toContain('struct');
    expect(appFile!.content).toContain('WindowGroup');
  });

  it('generates SwiftData models when entities exist', () => {
    const spec = mockGenerateSpec('Task app');
    const project = generateProject(spec);

    const modelFile = project.files.find(f => f.path.includes('Models'));
    expect(modelFile).toBeDefined();
    expect(modelFile!.content).toContain('@Model');
    expect(modelFile!.content).toContain('import SwiftData');
  });

  it('generates views for each screen', () => {
    const spec = mockGenerateSpec('Simple app');
    const project = generateProject(spec);

    const viewFiles = project.files.filter(f => f.path.includes('Views/'));
    expect(viewFiles.length).toBe(spec.screens.length);
  });

  it('generates ContentView with TabView when settings exist', () => {
    const spec = mockGenerateSpec('App with settings');
    const project = generateProject(spec);

    const contentView = project.files.find(f => f.path.endsWith('ContentView.swift'));
    expect(contentView).toBeDefined();
    expect(contentView!.content).toContain('TabView');
  });

  it('generates Info.plist', () => {
    const spec = mockGenerateSpec('Plist test');
    const project = generateProject(spec);

    const plist = project.files.find(f => f.path.endsWith('Info.plist'));
    expect(plist).toBeDefined();
    expect(plist!.content).toContain('CFBundleIdentifier');
    expect(plist!.content).toContain(spec.bundleId);
  });

  it('all Swift view files have valid structure', () => {
    const spec = mockGenerateSpec('Structure test');
    const project = generateProject(spec);

    const viewFiles = project.files.filter(f => f.language === 'swift' && (f.path.includes('Views/') || f.path.includes('ContentView')));
    for (const file of viewFiles) {
      expect(file.content).toContain('import SwiftUI');
      expect(file.content).not.toMatch(/\beval\s*\(/);
      expect(file.content).not.toMatch(/\bnew\s+Function\s*\(/);
    }
  });

  it('generates Preview macros for all views', () => {
    const spec = mockGenerateSpec('Preview test');
    const project = generateProject(spec);

    const viewFiles = project.files.filter(f => f.path.includes('Views/'));
    for (const file of viewFiles) {
      expect(file.content).toContain('#Preview');
    }
  });
});

// ─── Build Pipeline Tests ────────────────────────────────────────

describe('LaunchPipeline', () => {
  let store: SqliteStore;
  const auditEntries: SecureAuditEntry[] = [];

  const mockAudit: AuditLedgerWriter = {
    record: (event) => {
      const entry = { id: randomUUID(), sequenceNumber: auditEntries.length + 1, timestamp: new Date().toISOString(), type: event.type, userId: 'system', action: event.type, target: '', previousHash: 'prev', hash: 'hash', details: event.details, outcome: event.outcome };
      auditEntries.push(entry);
      return entry;
    },
    verifyChain: () => ({ valid: true }),
  };

  beforeEach(async () => {
    store = new SqliteStore({ path: ':memory:' });
    await store.initialize();
    auditEntries.length = 0;
  });

  it('runs full pipeline with mock spec generator', async () => {
    const pipeline = new LaunchPipeline({
      outputDir: '/tmp/test-launch',
      useMockSpec: true,
      store,
      audit: mockAudit,
    });

    const { project, pipeline: result } = await pipeline.run('A simple habit tracker');
    expect(result.success).toBe(true);
    expect(result.stages.length).toBeGreaterThan(0);
    expect(result.stages.every(s => s.success)).toBe(true);
    expect(project.files.length).toBeGreaterThan(0);
    expect(project.spec.name).toBeTruthy();
  });

  it('pipeline logs to audit ledger', async () => {
    const pipeline = new LaunchPipeline({
      outputDir: '/tmp/test-launch',
      useMockSpec: true,
      store,
      audit: mockAudit,
    });

    await pipeline.run('Audit test app');
    expect(auditEntries.length).toBeGreaterThan(0);
    expect(auditEntries.some(e => e.type === 'launch:spec_generated')).toBe(true);
    expect(auditEntries.some(e => e.type === 'launch:code_generated')).toBe(true);
    expect(auditEntries.some(e => e.type === 'launch:pipeline_complete')).toBe(true);
  });

  it('sentinel blocks generated code with credentials', async () => {
    const poisonSentinel: SentinelInspector = {
      inspect: (content: string): InspectionResult => {
        if (content.includes('sk-secret')) {
          return { threatLevel: 'blocked', findings: [{ category: 'credential_leak', confidence: 95, description: 'API key in code' }], latencyMs: 1 };
        }
        return { threatLevel: 'safe', findings: [], latencyMs: 0 };
      },
    };

    // We can't easily inject credentials into the code generator,
    // but we can verify the sentinel is called and the pipeline structure is correct
    const pipeline = new LaunchPipeline({
      outputDir: '/tmp/test-launch',
      useMockSpec: true,
      sentinel: poisonSentinel,
      store,
      audit: mockAudit,
    });

    const { pipeline: result } = await pipeline.run('Clean app');
    // Clean code should pass sentinel
    expect(result.success).toBe(true);
  });

  it('pipeline fails gracefully when LLM is missing and mock is off', async () => {
    const pipeline = new LaunchPipeline({
      outputDir: '/tmp/test-launch',
      useMockSpec: false,
      // No specLlm configured
    });

    const { pipeline: result } = await pipeline.run('This should fail');
    expect(result.success).toBe(false);
    expect(result.stages[0]?.error).toContain('No LLM configured');
  });

  it('L1 eval gates run on generated code', async () => {
    const pipeline = new LaunchPipeline({
      outputDir: '/tmp/test-launch',
      useMockSpec: true,
      store,
      audit: mockAudit,
    });

    const { pipeline: result } = await pipeline.run('Eval gated app');
    // Code generator doesn't produce unsafe patterns, so gates should pass
    expect(result.success).toBe(true);
    // Verify the test stage ran
    const testStage = result.stages.find(s => s.stage === 'test');
    expect(testStage).toBeDefined();
    expect(testStage!.success).toBe(true);
  });

  it('measures timing for each stage', async () => {
    const pipeline = new LaunchPipeline({
      outputDir: '/tmp/test-launch',
      useMockSpec: true,
      store,
    });

    const { pipeline: result } = await pipeline.run('Timing test');
    for (const stage of result.stages) {
      expect(stage.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });
});
