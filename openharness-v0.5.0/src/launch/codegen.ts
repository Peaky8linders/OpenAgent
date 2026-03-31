/**
 * Swift Code Generator — transforms an AppSpec into SwiftUI source files.
 *
 * Generates production-quality SwiftUI code with:
 * - SwiftData models
 * - NavigationStack-based navigation
 * - Adaptive color scheme support
 * - SF Symbols icons
 * - Proper MVVM structure
 *
 * All generated code passes through the sentinel pipeline before
 * being written to disk (no hardcoded credentials, no unsafe patterns).
 */
import type { AppSpec, EntitySpec, ScreenSpec, GeneratedFile, GeneratedProject, AppStoreMetadata } from './types.js';

/**
 * Generate a complete Xcode project from an AppSpec.
 */
export function generateProject(spec: AppSpec): GeneratedProject {
  const files: GeneratedFile[] = [];
  const projectName = spec.name.replace(/[^a-zA-Z0-9]/g, '');

  // App entry point
  files.push(generateAppFile(spec, projectName));

  // Data models (SwiftData)
  if (spec.dataModel.entities.length > 0) {
    files.push(generateModels(spec));
  }

  // Views for each screen
  for (const screen of spec.screens) {
    files.push(generateView(spec, screen, projectName));
  }

  // ContentView (root navigation)
  files.push(generateContentView(spec, projectName));

  // Package/project config
  files.push(generateInfoPlist(spec));

  // Default metadata
  const metadata = generateDefaultMetadata(spec);

  return {
    spec,
    files,
    xcodeProjectPath: `${projectName}/${projectName}.xcodeproj`,
    metadata,
  };
}

function generateAppFile(spec: AppSpec, projectName: string): GeneratedFile {
  const modelContainerLine = spec.dataModel.entities.length > 0
    ? `\n            .modelContainer(for: [${spec.dataModel.entities.map(e => `${e.name}.self`).join(', ')}])`
    : '';

  return {
    path: `${projectName}/${projectName}App.swift`,
    language: 'swift',
    content: `import SwiftUI
${spec.dataModel.persistence === 'swiftdata' ? 'import SwiftData' : ''}

@main
struct ${projectName}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()${modelContainerLine}
        }
    }
}
`,
  };
}

function generateModels(spec: AppSpec): GeneratedFile {
  const projectName = spec.name.replace(/[^a-zA-Z0-9]/g, '');
  const models = spec.dataModel.entities.map(entity => generateEntityModel(entity)).join('\n\n');

  return {
    path: `${projectName}/Models/Models.swift`,
    language: 'swift',
    content: `import Foundation
import SwiftData

${models}
`,
  };
}

function generateEntityModel(entity: EntitySpec): string {
  const safeName = sanitizeSwiftId(entity.name);
  const properties = entity.properties.map(prop => {
    const safePropName = sanitizeSwiftId(prop.name);
    const swiftType = mapType(prop.type, prop.optional);
    const defaultVal = prop.defaultValue ? ` = ${sanitizeDefault(prop.type, prop.defaultValue)}` : prop.optional ? ' = nil' : '';
    return `    var ${safePropName}: ${swiftType}${defaultVal}`;
  }).join('\n');

  const initParams = entity.properties.filter(p => !p.optional && !p.defaultValue).map(p => `${sanitizeSwiftId(p.name)}: ${mapType(p.type, false)}`).join(', ');
  const initBody = entity.properties.filter(p => !p.optional && !p.defaultValue).map(p => `        self.${sanitizeSwiftId(p.name)} = ${sanitizeSwiftId(p.name)}`).join('\n');

  return `@Model
final class ${safeName} {
${properties}

    init(${initParams}) {
${initBody}
    }
}`;
}

function generateView(spec: AppSpec, screen: ScreenSpec, projectName: string): GeneratedFile {
  const viewName = screen.name.replace(/\s+/g, '') + 'View';
  let body: string;

  switch (screen.type) {
    case 'list':
      body = generateListView(spec, screen);
      break;
    case 'detail':
      body = generateDetailView(spec, screen);
      break;
    case 'form':
      body = generateFormView(spec, screen);
      break;
    case 'settings':
      body = generateSettingsView(spec);
      break;
    default:
      body = generateGenericView(screen);
  }

  return {
    path: `${projectName}/Views/${viewName}.swift`,
    language: 'swift',
    content: `import SwiftUI
${spec.dataModel.persistence === 'swiftdata' ? 'import SwiftData' : ''}

struct ${viewName}: View {
${body}
}

#Preview {
    ${viewName}()${spec.dataModel.entities.length > 0 ? `\n        .modelContainer(for: [${spec.dataModel.entities.map(e => `${e.name}.self`).join(', ')}], inMemory: true)` : ''}
}
`,
  };
}

function generateListView(spec: AppSpec, _screen: ScreenSpec): string {
  const entity = spec.dataModel.entities[0];
  if (!entity) return generateGenericView(_screen);

  const titleProp = entity.properties.find(p => p.type === 'string' && !p.optional)?.name ?? 'id';

  return `    @Query private var items: [${entity.name}]
    @Environment(\\.modelContext) private var context
    @State private var showingAdd = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(items) { item in
                    NavigationLink {
                        ${entity.name}DetailView(item: item)
                    } label: {
                        Text(item.${titleProp})
                    }
                }
                .onDelete(perform: deleteItems)
            }
            .navigationTitle("${spec.name}")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { showingAdd = true }) {
                        Label("Add", systemImage: "plus")
                    }
                }
            }
            .sheet(isPresented: $showingAdd) {
                Add${entity.name}View()
            }
        }
    }

    private func deleteItems(at offsets: IndexSet) {
        for index in offsets {
            context.delete(items[index])
        }
    }`;
}

function generateDetailView(spec: AppSpec, _screen: ScreenSpec): string {
  const entity = spec.dataModel.entities[0];
  if (!entity) return `    var body: some View { Text("Detail") }`;

  const fields = entity.properties.map(p =>
    `                LabeledContent("${p.name.charAt(0).toUpperCase() + p.name.slice(1)}") { Text(String(describing: item.${p.name})) }`
  ).join('\n');

  return `    let item: ${entity.name}

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
${fields}
            }
            .padding()
        }
        .navigationTitle(item.${entity.properties.find(p => p.type === 'string')?.name ?? 'id'})
    }`;
}

function generateFormView(spec: AppSpec, _screen: ScreenSpec): string {
  const entity = spec.dataModel.entities[0];
  if (!entity) return `    var body: some View { Text("Add") }`;

  const stateVars = entity.properties
    .filter(p => p.type === 'string' || p.type === 'bool')
    .map(p => p.type === 'bool'
      ? `    @State private var ${p.name} = ${p.defaultValue ?? 'false'}`
      : `    @State private var ${p.name} = "${p.defaultValue ?? ''}"`)
    .join('\n');

  const formFields = entity.properties
    .filter(p => p.type === 'string')
    .map(p => `                TextField("${p.name.charAt(0).toUpperCase() + p.name.slice(1)}", text: $${p.name})`)
    .join('\n');

  return `    @Environment(\\.modelContext) private var context
    @Environment(\\.dismiss) private var dismiss
${stateVars}

    var body: some View {
        NavigationStack {
            Form {
                Section {
${formFields}
                }
            }
            .navigationTitle("Add ${entity.name}")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        save()
                        dismiss()
                    }
                }
            }
        }
    }

    private func save() {
        let item = ${entity.name}(${entity.properties.filter(p => !p.optional && !p.defaultValue && p.type === 'string').map(p => `${p.name}: ${p.name}`).join(', ')})
        context.insert(item)
    }`;
}

function generateSettingsView(spec: AppSpec): string {
  return `    @AppStorage("notifications") private var notificationsEnabled = true
    @AppStorage("appearance") private var appearance = "system"

    var body: some View {
        Form {
            Section("General") {
                Toggle("Notifications", isOn: $notificationsEnabled)
                Picker("Appearance", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
            }
            Section("About") {
                LabeledContent("Version", value: "1.0.0")
                LabeledContent("Developer", value: "Built with PrivateLaunch")
            }
        }
        .navigationTitle("Settings")
    }`;
}

function generateGenericView(screen: ScreenSpec): string {
  return `    var body: some View {
        Text("${screen.name}")
            .navigationTitle("${screen.name}")
    }`;
}

function generateContentView(spec: AppSpec, projectName: string): GeneratedFile {
  const mainScreen = spec.screens.find(s => s.type === 'list' || s.type === 'dashboard') ?? spec.screens[0];
  const mainViewName = mainScreen ? mainScreen.name.replace(/\s+/g, '') + 'View' : 'Text("Hello")';

  const hasSettings = spec.screens.some(s => s.type === 'settings');

  const tabView = hasSettings
    ? `    var body: some View {
        TabView {
            ${mainViewName}()
                .tabItem {
                    Label("${mainScreen?.name ?? 'Home'}", systemImage: "house")
                }
            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
        .tint(Color(hex: "${spec.designSystem.accentColor}"))
    }`
    : `    var body: some View {
        ${mainViewName}()
    }`;

  return {
    path: `${projectName}/ContentView.swift`,
    language: 'swift',
    content: `import SwiftUI

struct ContentView: View {
${tabView}
}

// MARK: - Color Extension
extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let scanner = Scanner(string: hex)
        var rgbValue: UInt64 = 0
        scanner.scanHexInt64(&rgbValue)
        let r = Double((rgbValue & 0xFF0000) >> 16) / 255.0
        let g = Double((rgbValue & 0x00FF00) >> 8) / 255.0
        let b = Double(rgbValue & 0x0000FF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}

#Preview {
    ContentView()${spec.dataModel.entities.length > 0 ? `\n        .modelContainer(for: [${spec.dataModel.entities.map(e => `${e.name}.self`).join(', ')}], inMemory: true)` : ''}
}
`,
  };
}

function generateInfoPlist(spec: AppSpec): GeneratedFile {
  const projectName = spec.name.replace(/[^a-zA-Z0-9]/g, '');
  return {
    path: `${projectName}/Info.plist`,
    language: 'plist',
    content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${spec.name}</string>
    <key>CFBundleIdentifier</key>
    <string>${spec.bundleId}</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>UILaunchScreen</key>
    <dict/>
</dict>
</plist>
`,
  };
}

function generateDefaultMetadata(spec: AppSpec): AppStoreMetadata {
  return {
    appName: spec.name,
    subtitle: spec.description.split('.')[0] ?? spec.name,
    description: spec.description,
    keywords: spec.features.map(f => f.name.toLowerCase()),
    category: 'productivity',
    privacyPolicyUrl: 'https://example.com/privacy',
    supportUrl: 'https://example.com/support',
    screenshots: { iphone67: [], iphone65: [], ipad129: [] },
    ageRating: '4+',
  };
}

// ─── Type Mapping Helpers ────────────────────────────────────────

const SWIFT_RESERVED = new Set([
  'class', 'struct', 'enum', 'protocol', 'func', 'var', 'let', 'import',
  'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break',
  'continue', 'default', 'do', 'try', 'catch', 'throw', 'guard', 'self',
  'Self', 'nil', 'true', 'false', 'as', 'is', 'in', 'where', 'typealias',
  'init', 'deinit', 'extension', 'subscript', 'operator', 'associatedtype',
  'static', 'override', 'private', 'public', 'internal', 'fileprivate', 'open',
]);

const VALID_DEFAULT_PATTERN = /^(?:"[^"\\]*"|true|false|-?\d+(?:\.\d+)?|Date\(\))$/;

/**
 * Sanitize a string for use as a Swift identifier.
 * Strips non-alphanumeric chars, ensures it starts with a letter,
 * and escapes Swift reserved words with backticks.
 */
function sanitizeSwiftId(name: string): string {
  // Remove anything that's not alphanumeric or underscore
  let clean = name.replace(/[^a-zA-Z0-9_]/g, '');
  // Must start with a letter or underscore
  if (clean.length === 0 || /^\d/.test(clean)) {
    clean = `_${clean}`;
  }
  // Escape reserved words
  if (SWIFT_RESERVED.has(clean)) {
    clean = `\`${clean}\``;
  }
  return clean;
}

/**
 * Validate and sanitize a default value for safe Swift interpolation.
 * Only allows string literals, booleans, numbers, and Date().
 */
function sanitizeDefault(type: string, value: string): string {
  const formatted = formatDefault(type, value);
  if (!VALID_DEFAULT_PATTERN.test(formatted)) {
    // Unsafe default — fall back to type-appropriate empty value
    switch (type) {
      case 'string': return '""';
      case 'bool': return 'false';
      case 'int': case 'double': return '0';
      case 'date': return 'Date()';
      default: return '""';
    }
  }
  return formatted;
}

function mapType(type: string, optional: boolean): string {
  const map: Record<string, string> = {
    string: 'String', int: 'Int', double: 'Double',
    bool: 'Bool', date: 'Date', data: 'Data',
  };
  const swift = map[type] ?? 'String';
  return optional ? `${swift}?` : swift;
}

function formatDefault(type: string, value: string): string {
  switch (type) {
    case 'string': return `"${value}"`;
    case 'bool': return value;
    case 'int': case 'double': return value;
    case 'date': return 'Date()';
    default: return `"${value}"`;
  }
}
