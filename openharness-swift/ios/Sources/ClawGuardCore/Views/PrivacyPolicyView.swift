import SwiftUI

// MARK: - Privacy Policy & AI Transparency Disclosure
// Required by Apple App Store Review Guidelines 2026:
// - Section 5.1.1: Privacy policies must be accessible in-app
// - Section 5.1.2(i): AI data sharing must be disclosed
// - AI transparency: users must know when AI is used

public struct PrivacyPolicyView: View {
    @Environment(\.dismiss) private var dismiss

    public init() {}

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    aiTransparencySection
                    dataCollectionSection
                    sentinelDisclosureSection
                    dataStorageSection
                    thirdPartySection
                    dataRetentionSection
                    userRightsSection
                    contactSection
                }
                .padding()
            }
            .navigationTitle("Privacy Policy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: - AI Transparency (Guideline 5.1.2(i))

    private var aiTransparencySection: some View {
        PolicySection(
            icon: "cpu",
            title: "AI Transparency Disclosure",
            content: """
            ClawGuard connects to AI coding agents running on your OpenClaw \
            or NemoClaw gateway. Messages you send are processed by the AI \
            model configured on your gateway (e.g., NVIDIA Nemotron, Claude, \
            or other models).

            Your messages are sent to YOUR gateway — not to our servers. \
            ClawGuard does not operate any AI models itself. The AI processing \
            happens entirely on the gateway you configure.

            AI-generated responses are clearly labeled as coming from the \
            "assistant" role in the chat interface.
            """
        )
    }

    // MARK: - Data Collection

    private var dataCollectionSection: some View {
        PolicySection(
            icon: "doc.text.magnifyingglass",
            title: "What Data We Inspect",
            content: """
            ClawGuard's Sentinel security pipeline inspects message content \
            locally on your device for:

            • Prompt injection attempts (7 detection patterns)
            • Credential leaks (API keys, passwords, tokens — 6 patterns)
            • Personal health information / PII (SSN, credit cards, MRN — 3 patterns)

            This inspection happens entirely on-device. No message content is \
            sent to ClawGuard servers. Inspection results (threat level, \
            latency) are logged locally in the audit chain.
            """
        )
    }

    // MARK: - Sentinel Disclosure

    private var sentinelDisclosureSection: some View {
        PolicySection(
            icon: "shield.checkered",
            title: "Sentinel Content Inspection",
            content: """
            Every message you send and receive passes through the Sentinel \
            pipeline before being displayed or transmitted. This is a \
            security feature that protects you from:

            • Sending credentials accidentally (e.g., pasting an API key)
            • Receiving prompt injection attacks from compromised gateways
            • Exposing PII/PHI (Social Security numbers, credit cards)

            Messages flagged as "blocked" are not sent to your gateway. \
            You can disable PHI detection or suspicious content blocking \
            in Settings, but injection and credential detection cannot be \
            disabled as they protect your security.
            """
        )
    }

    // MARK: - Data Storage

    private var dataStorageSection: some View {
        PolicySection(
            icon: "lock.shield",
            title: "How Data Is Stored",
            content: """
            • Connection credentials: Encrypted in iOS Keychain \
            (kSecAttrAccessibleWhenUnlockedThisDeviceOnly). Never leaves \
            your device.

            • Audit log: Stored locally with SHA-256 hash chaining for \
            tamper detection. Each entry chains to the previous entry, \
            creating an immutable security record.

            • Chat messages: Stored in-memory only. Messages are lost \
            when you close the app. No messages are persisted to disk \
            or synced to any server.

            • No analytics, crash reporting, or telemetry data is \
            collected or transmitted.
            """
        )
    }

    // MARK: - Third Party

    private var thirdPartySection: some View {
        PolicySection(
            icon: "arrow.triangle.branch",
            title: "Third-Party Data Sharing",
            content: """
            ClawGuard does NOT share any data with third parties.

            Messages are sent only to the gateway you explicitly configure. \
            No data is sent to Apple, NVIDIA, Anthropic, or any other service \
            by ClawGuard itself.

            Your gateway may route messages to external AI providers \
            depending on its configuration. That data flow is controlled \
            by your gateway administrator, not by ClawGuard.

            ClawGuard contains no advertising SDKs, analytics frameworks, \
            or tracking pixels.
            """
        )
    }

    // MARK: - Data Retention

    private var dataRetentionSection: some View {
        PolicySection(
            icon: "clock.arrow.circlepath",
            title: "Data Retention & Deletion",
            content: """
            • Chat messages: Not persisted. Lost on app close.
            • Audit log: Persisted locally. You can clear it in Settings.
            • Saved connections: Stored in Keychain until you delete them \
            via Settings → Saved Connections → swipe to delete.

            To delete all ClawGuard data: uninstall the app. This removes \
            all Keychain entries, audit logs, and cached data.
            """
        )
    }

    // MARK: - User Rights

    private var userRightsSection: some View {
        PolicySection(
            icon: "person.crop.circle.badge.checkmark",
            title: "Your Rights",
            content: """
            Under GDPR, CCPA, and similar regulations, you have the right to:

            • Access: View all data stored by ClawGuard (visible in \
            Settings and Audit Trail).
            • Delete: Remove any stored connection or clear audit logs.
            • Portability: Export audit logs from the Audit Trail view.
            • Opt-out: Disable PHI detection or suspicious content \
            blocking in Settings.

            Since all data is stored locally on your device and no data \
            is transmitted to our servers, exercising these rights requires \
            no server-side action.
            """
        )
    }

    // MARK: - Contact

    private var contactSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Contact", systemImage: "envelope")
                .font(.headline)

            Text("For privacy inquiries:")
                .font(.subheadline)

            Link("GitHub: Peaky8linders/OpenAgent",
                 destination: URL(string: "https://github.com/Peaky8linders/OpenAgent")!)
                .font(.subheadline)

            Text("Last updated: March 27, 2026")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text("ClawGuard v1.0.0")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Policy Section Component

struct PolicySection: View {
    let icon: String
    let title: String
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon)
                .font(.headline)

            Text(content)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - First-Launch AI Consent (Guideline 5.1.2(i))

public struct AIConsentView: View {
    @Binding var hasConsented: Bool
    @State private var showPrivacyPolicy = false

    public init(hasConsented: Binding<Bool>) {
        self._hasConsented = hasConsented
    }

    public var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "cpu")
                .font(.system(size: 64))
                .foregroundStyle(.blue)
                .accessibilityHidden(true)

            Text("AI Agent Connection")
                .font(.title.bold())

            VStack(alignment: .leading, spacing: 12) {
                ConsentRow(icon: "arrow.right.circle", text: "Your messages will be sent to the AI gateway you configure")
                ConsentRow(icon: "shield.checkered", text: "All messages are inspected locally by Sentinel before sending")
                ConsentRow(icon: "eye.slash", text: "No data is sent to ClawGuard servers or third parties")
                ConsentRow(icon: "cpu", text: "AI responses are generated by the model on your gateway")
            }
            .padding()
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 16))

            Text("By continuing, you acknowledge that messages sent through ClawGuard are processed by the AI model on your configured gateway.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button {
                hasConsented = true
            } label: {
                Text("I Understand — Continue")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(.blue)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .accessibilityLabel("Accept AI data processing and continue")

            Button("View Privacy Policy") {
                showPrivacyPolicy = true
            }
            .font(.caption)
            .sheet(isPresented: $showPrivacyPolicy) {
                PrivacyPolicyView()
            }

            Spacer()
        }
        .padding()
    }
}

struct ConsentRow: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(.blue)
                .frame(width: 24)
            Text(text)
                .font(.subheadline)
        }
    }
}
