/**
 * Spec Generator — transforms a natural language app description
 * into a structured AppSpec using a local LLM.
 *
 * This is the "Click 1" entry point. The user describes what they want,
 * and this module produces a complete specification that drives
 * code generation, build, and submission.
 *
 * Uses Apple FoundationModels-style guided generation:
 * prompt → structured JSON → validated AppSpec.
 */
import { randomUUID } from 'node:crypto';
import type { AppSpec, FeatureSpec, ScreenSpec, DataModelSpec, DesignSystemSpec, PropertySpec } from './types.js';

/**
 * LLM function for spec generation — injectable for any provider.
 * Takes a system prompt + user input, returns structured JSON string.
 */
export type SpecLLMFn = (systemPrompt: string, userInput: string) => Promise<string>;

const SPEC_SYSTEM_PROMPT = `You are an expert iOS app architect. Given a natural language app description,
produce a complete app specification as a JSON object.

The JSON must have this exact structure:
{
  "name": "App Name",
  "bundleId": "com.privatelaunch.appname",
  "description": "One paragraph description",
  "platforms": ["ios"],
  "features": [
    { "name": "Feature Name", "description": "What it does", "priority": "must", "screens": ["screen_id"] }
  ],
  "dataModel": {
    "entities": [
      { "name": "EntityName", "properties": [
        { "name": "propName", "type": "string", "optional": false }
      ]}
    ],
    "relationships": [],
    "persistence": "swiftdata"
  },
  "screens": [
    { "id": "screen_id", "name": "Screen Name", "type": "list", "components": ["NavigationStack", "List"], "navigatesTo": ["other_screen"] }
  ],
  "designSystem": {
    "colorScheme": "adaptive",
    "accentColor": "#007AFF",
    "fontStyle": "system",
    "iconStyle": "sf-symbols"
  }
}

Rules:
- Every app needs at least: a main list/dashboard screen, a detail screen, and a settings screen.
- Use SwiftData for persistence unless the app is trivially simple.
- Use SF Symbols for icons.
- Support adaptive (light+dark) color scheme by default.
- Keep feature count reasonable (3-7 for v1).
- Bundle ID format: com.privatelaunch.<lowercase-name>
- Respond with ONLY the JSON object. No markdown, no explanation.`;

/**
 * Generate an AppSpec from a natural language description.
 */
export async function generateSpec(
  description: string,
  llmFn: SpecLLMFn,
): Promise<AppSpec> {
  const raw = await llmFn(SPEC_SYSTEM_PROMPT, description);

  // Parse and validate
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new Error(`LLM returned invalid JSON for app spec: ${cleaned.substring(0, 200)}`);
  }

  return validateAndBuildSpec(parsed);
}

/**
 * Validate raw parsed JSON and build a typed AppSpec.
 */
function validateAndBuildSpec(raw: Record<string, unknown>): AppSpec {
  const name = requireString(raw, 'name');
  const bundleId = requireString(raw, 'bundleId');
  const description = requireString(raw, 'description');

  const validPlatforms = new Set(['ios', 'macos', 'watchos', 'visionos']);
  const validPriorities = new Set(['must', 'should', 'could']);
  const validScreenTypes = new Set(['list', 'detail', 'form', 'settings', 'dashboard', 'onboarding', 'tab']);
  const validPropTypes = new Set(['string', 'int', 'double', 'bool', 'date', 'data', 'enum']);
  const validPersistence = new Set(['swiftdata', 'coredata', 'userdefaults']);

  const platforms = ((raw.platforms as string[]) ?? ['ios']).filter(p => validPlatforms.has(p));
  if (platforms.length === 0) platforms.push('ios');

  const rawFeatures = (raw.features as Array<Record<string, unknown>>) ?? [];
  const features: FeatureSpec[] = rawFeatures.map(f => ({
    name: String(f.name ?? 'Feature'),
    description: String(f.description ?? ''),
    priority: validPriorities.has(String(f.priority)) ? String(f.priority) as FeatureSpec['priority'] : 'should',
    screens: Array.isArray(f.screens) ? f.screens.map(String) : [],
  }));

  const rawScreens = (raw.screens as Array<Record<string, unknown>>) ?? [];
  const screens: ScreenSpec[] = rawScreens.map(s => ({
    id: String(s.id ?? randomUUID()),
    name: String(s.name ?? 'Screen'),
    type: validScreenTypes.has(String(s.type)) ? String(s.type) as ScreenSpec['type'] : 'list',
    components: Array.isArray(s.components) ? s.components.map(String) : [],
    navigatesTo: Array.isArray(s.navigatesTo) ? s.navigatesTo.map(String) : [],
  }));

  const rawDataModel = raw.dataModel as Record<string, unknown> | undefined;
  const persistence = rawDataModel?.persistence
    ? (validPersistence.has(String(rawDataModel.persistence)) ? String(rawDataModel.persistence) as DataModelSpec['persistence'] : 'swiftdata')
    : 'userdefaults';
  const rawEntities = (rawDataModel?.entities as Array<Record<string, unknown>>) ?? [];
  const dataModel: DataModelSpec = {
    entities: rawEntities.map(e => ({
      name: String(e.name ?? 'Entity'),
      properties: (Array.isArray(e.properties) ? e.properties : []).map((p: Record<string, unknown>) => ({
        name: String(p.name ?? 'prop'),
        type: validPropTypes.has(String(p.type)) ? String(p.type) as PropertySpec['type'] : 'string',
        optional: Boolean(p.optional),
        defaultValue: p.defaultValue !== undefined ? String(p.defaultValue) : undefined,
        enumValues: Array.isArray(p.enumValues) ? p.enumValues.map(String) : undefined,
      })),
    })),
    relationships: [],
    persistence,
  };

  const designSystem = raw.designSystem as DesignSystemSpec | undefined;

  if (features.length === 0) {
    throw new Error('App spec must have at least one feature');
  }
  if (screens.length === 0) {
    throw new Error('App spec must have at least one screen');
  }

  return {
    id: randomUUID(),
    name,
    bundleId: sanitizeBundleId(bundleId),
    description,
    platforms: platforms as AppSpec['platforms'],
    features,
    dataModel: dataModel ?? { entities: [], relationships: [], persistence: 'userdefaults' },
    screens,
    designSystem: designSystem ?? {
      colorScheme: 'adaptive',
      accentColor: '#007AFF',
      fontStyle: 'system',
      iconStyle: 'sf-symbols',
    },
    createdAt: new Date().toISOString(),
  };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`App spec missing required string field: ${key}`);
  }
  return val;
}

function sanitizeBundleId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

/**
 * Mock spec generator for testing — produces a deterministic spec
 * without requiring an LLM.
 */
export function mockGenerateSpec(description: string): AppSpec {
  const name = description.split(/\s+/).slice(0, 3).join(' ');
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  return {
    id: randomUUID(),
    name,
    bundleId: `com.privatelaunch.${slug}`,
    description,
    platforms: ['ios'],
    features: [
      { name: 'Main List', description: 'Browse items', priority: 'must', screens: ['main_list'] },
      { name: 'Detail View', description: 'View item details', priority: 'must', screens: ['detail'] },
      { name: 'Add Item', description: 'Create new items', priority: 'must', screens: ['add_form'] },
    ],
    dataModel: {
      entities: [{
        name: 'Item',
        properties: [
          { name: 'title', type: 'string', optional: false },
          { name: 'notes', type: 'string', optional: true },
          { name: 'createdAt', type: 'date', optional: false },
          { name: 'isCompleted', type: 'bool', optional: false, defaultValue: 'false' },
        ],
      }],
      relationships: [],
      persistence: 'swiftdata',
    },
    screens: [
      { id: 'main_list', name: 'Items', type: 'list', components: ['NavigationStack', 'List', 'ForEach'], navigatesTo: ['detail', 'add_form'] },
      { id: 'detail', name: 'Item Detail', type: 'detail', components: ['ScrollView', 'VStack', 'Text'], navigatesTo: [] },
      { id: 'add_form', name: 'Add Item', type: 'form', components: ['Form', 'TextField', 'Button'], navigatesTo: [] },
      { id: 'settings', name: 'Settings', type: 'settings', components: ['Form', 'Toggle', 'Picker'], navigatesTo: [] },
    ],
    designSystem: {
      colorScheme: 'adaptive',
      accentColor: '#007AFF',
      fontStyle: 'system',
      iconStyle: 'sf-symbols',
    },
    createdAt: new Date().toISOString(),
  };
}
