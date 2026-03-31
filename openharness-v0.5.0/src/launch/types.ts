/**
 * PrivateLaunch Types
 *
 * Data models for the app generation pipeline:
 * Description → Spec → Code → Build → Submit
 */

// ─── App Specification ──────────────────────────────────────────

export interface AppSpec {
  readonly id: string;
  readonly name: string;
  readonly bundleId: string;
  readonly description: string;
  readonly platforms: ('ios' | 'macos' | 'watchos' | 'visionos')[];
  readonly features: FeatureSpec[];
  readonly dataModel: DataModelSpec;
  readonly screens: ScreenSpec[];
  readonly designSystem: DesignSystemSpec;
  readonly createdAt: string;
}

export interface FeatureSpec {
  readonly name: string;
  readonly description: string;
  readonly priority: 'must' | 'should' | 'could';
  readonly screens: string[]; // screen IDs that implement this feature
}

export interface DataModelSpec {
  readonly entities: EntitySpec[];
  readonly relationships: RelationshipSpec[];
  readonly persistence: 'swiftdata' | 'coredata' | 'userdefaults';
}

export interface EntitySpec {
  readonly name: string;
  readonly properties: PropertySpec[];
}

export interface PropertySpec {
  readonly name: string;
  readonly type: 'string' | 'int' | 'double' | 'bool' | 'date' | 'data' | 'enum';
  readonly optional: boolean;
  readonly defaultValue?: string;
  readonly enumValues?: string[];
}

export interface RelationshipSpec {
  readonly from: string;
  readonly to: string;
  readonly type: 'oneToOne' | 'oneToMany' | 'manyToMany';
  readonly name: string;
}

export interface ScreenSpec {
  readonly id: string;
  readonly name: string;
  readonly type: 'list' | 'detail' | 'form' | 'settings' | 'dashboard' | 'onboarding' | 'tab';
  readonly components: string[];
  readonly navigatesTo: string[];
}

export interface DesignSystemSpec {
  readonly colorScheme: 'adaptive' | 'light' | 'dark';
  readonly accentColor: string;
  readonly fontStyle: 'system' | 'rounded' | 'serif';
  readonly iconStyle: 'sf-symbols' | 'custom';
}

// ─── Build Pipeline ─────────────────────────────────────────────

export type PipelineStage =
  | 'spec_generation'
  | 'code_generation'
  | 'sentinel_check'
  | 'project_setup'
  | 'build'
  | 'test'
  | 'preview_capture'
  | 'icon_generation'
  | 'metadata_generation'
  | 'archive'
  | 'signing'
  | 'upload';

export interface StageResult {
  readonly stage: PipelineStage;
  readonly success: boolean;
  readonly durationMs: number;
  readonly output?: string;
  readonly error?: string;
  readonly artifacts?: string[]; // file paths produced
}

export interface PipelineResult {
  readonly appId: string;
  readonly stages: StageResult[];
  readonly success: boolean;
  readonly totalMs: number;
  readonly ipaPath?: string;
  readonly appStoreUrl?: string;
}

// ─── Xcode MCP Interface ────────────────────────────────────────

export interface XcodeMCPCapabilities {
  readonly canSearchDocs: boolean;
  readonly canExploreFiles: boolean;
  readonly canUpdateProjectSettings: boolean;
  readonly canCapturePreview: boolean;
  readonly canBuild: boolean;
  readonly canRunTests: boolean;
}

export interface XcodeMCPRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface XcodeMCPResponse {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

// ─── App Store Metadata ─────────────────────────────────────────

export interface AppStoreMetadata {
  readonly appName: string;
  readonly subtitle: string;
  readonly description: string;
  readonly keywords: string[];
  readonly category: AppStoreCategory;
  readonly secondaryCategory?: AppStoreCategory;
  readonly privacyPolicyUrl: string;
  readonly supportUrl: string;
  readonly marketingUrl?: string;
  readonly screenshots: ScreenshotSet;
  readonly ageRating: AgeRating;
}

export type AppStoreCategory =
  | 'productivity' | 'health-fitness' | 'finance' | 'education'
  | 'lifestyle' | 'utilities' | 'business' | 'social-networking'
  | 'entertainment' | 'photo-video' | 'food-drink' | 'travel'
  | 'news' | 'weather' | 'reference' | 'developer-tools';

export interface ScreenshotSet {
  readonly iphone67: string[];   // 6.7" (iPhone 16 Pro Max)
  readonly iphone65: string[];   // 6.5" (iPhone 15 Plus)
  readonly ipad129: string[];    // 12.9" iPad Pro
}

export type AgeRating = '4+' | '9+' | '12+' | '17+';

// ─── Code Generation ────────────────────────────────────────────

export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
  readonly language: 'swift' | 'json' | 'plist' | 'xcconfig' | 'markdown';
}

export interface GeneratedProject {
  readonly spec: AppSpec;
  readonly files: GeneratedFile[];
  readonly xcodeProjectPath: string;
  readonly metadata: AppStoreMetadata;
}
