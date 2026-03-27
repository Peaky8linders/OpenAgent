import SwiftUI

// MARK: - Settings View

public struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var showDisconnectConfirm = false
    @State private var credentials: [StoredCredential] = []
    @State private var auditCount = 0

    public init() {}

    public var body: some View {
        NavigationStack {
            List {
                connectionSection
                securitySection
                credentialsSection
                aboutSection
            }
            .navigationTitle("Settings")
            .task {
                credentials = await appState.vault.list()
                auditCount = await appState.audit.count
            }
        }
    }

    // MARK: - Connection

    private var connectionSection: some View {
        Section("Connection") {
            HStack {
                Text("Status")
                Spacer()
                HStack(spacing: 4) {
                    Circle()
                        .fill(appState.isConnected ? .green : .red)
                        .frame(width: 8, height: 8)
                    Text(connectionStateText)
                        .foregroundStyle(.secondary)
                }
            }

            if appState.isConnected {
                Button("Disconnect", role: .destructive) {
                    showDisconnectConfirm = true
                }
                .confirmationDialog("Disconnect?", isPresented: $showDisconnectConfirm) {
                    Button("Disconnect", role: .destructive) {
                        Task { await appState.gateway.disconnect() }
                    }
                }
            }
        }
    }

    // MARK: - Security

    private var securitySection: some View {
        Section("Security") {
            HStack {
                Label("Sentinel", systemImage: "shield.checkered")
                Spacer()
                Text("Active")
                    .foregroundStyle(.green)
            }

            HStack {
                Label("PHI Detection", systemImage: "eye.slash")
                Spacer()
                Text(appState.sentinel.phiDetection ? "On" : "Off")
                    .foregroundStyle(appState.sentinel.phiDetection ? .green : .orange)
            }

            HStack {
                Label("Block Suspicious", systemImage: "xmark.shield")
                Spacer()
                Text(appState.sentinel.blockOnSuspicious ? "On" : "Off")
                    .foregroundStyle(appState.sentinel.blockOnSuspicious ? .green : .orange)
            }

            HStack {
                Label("Audit Entries", systemImage: "link")
                Spacer()
                Text("\(auditCount)")
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Credentials

    private var credentialsSection: some View {
        Section("Saved Connections") {
            if credentials.isEmpty {
                Text("No saved connections")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(credentials) { cred in
                    VStack(alignment: .leading) {
                        Text(cred.name)
                            .font(.body.bold())
                        Text("\(cred.host):\(cred.port)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .onDelete { indices in
                    Task {
                        for index in indices {
                            try? await appState.vault.delete(id: credentials[index].id)
                        }
                        credentials = await appState.vault.list()
                    }
                }
            }
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section("About") {
            HStack {
                Text("ClawGuard")
                Spacer()
                Text("v1.0.0")
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("ClawGuard version 1.0.0")

            HStack {
                Text("Security")
                Spacer()
                Text("Sentinel + Audit Chain + Keychain")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Security features: Sentinel, Audit Chain, and Keychain encryption")

            HStack {
                Text("Compatible With")
                Spacer()
                Text("OpenClaw / NemoClaw")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Compatible with OpenClaw and NemoClaw gateways")

            NavigationLink {
                PrivacyPolicyView()
            } label: {
                Label("Privacy Policy", systemImage: "hand.raised.fill")
            }

            Link(destination: URL(string: "https://github.com/Peaky8linders/OpenAgent")!) {
                Label("Source Code", systemImage: "chevron.left.forwardslash.chevron.right")
            }
        }
    }

    // MARK: - Helpers

    private var connectionStateText: String {
        switch appState.gateway.connectionState {
        case .connected: "Connected"
        case .connecting: "Connecting..."
        case .reconnecting: "Reconnecting..."
        case .disconnected: "Disconnected"
        case .failed: "Failed"
        }
    }
}
