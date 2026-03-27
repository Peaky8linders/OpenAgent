import SwiftUI

// MARK: - Connection / Onboarding View

public struct ConnectionView: View {
    @Environment(AppState.self) private var appState
    @State private var host = "localhost"
    @State private var port = "8080"
    @State private var apiKey = ""
    @State private var sandboxName = ""
    @State private var useTLS = true
    @State private var isConnecting = false
    @State private var errorMessage: String?
    @State private var savedConnections: [StoredCredential] = []
    @State private var connectionName = ""

    public init() {}

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    headerSection
                    savedConnectionsSection
                    newConnectionSection
                    securityBadges
                }
                .padding()
            }
            .navigationTitle("ClawGuard")
            .task {
                savedConnections = await appState.vault.list()
            }
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 12) {
            Image(systemName: "shield.lock.fill")
                .font(.system(size: 56))
                .foregroundStyle(.blue)
                .symbolEffect(.pulse, isActive: isConnecting)

            Text("Secure Agent Client")
                .font(.title2.bold())

            Text("Connect to your OpenClaw or NemoClaw gateway with enterprise-grade security.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical)
    }

    // MARK: - Saved Connections

    @ViewBuilder
    private var savedConnectionsSection: some View {
        if !savedConnections.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Saved Connections")
                    .font(.headline)

                ForEach(savedConnections) { credential in
                    Button {
                        Task { await connectSaved(credential) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(credential.name)
                                    .font(.body.bold())
                                Text("\(credential.host):\(credential.port)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if credential.useTLS {
                                Image(systemName: "lock.fill")
                                    .foregroundStyle(.green)
                                    .font(.caption)
                            }
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.secondary)
                        }
                        .padding()
                        .background(.ultraThinMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await deleteConnection(credential.id) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
        }
    }

    // MARK: - New Connection Form

    private var newConnectionSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Connection")
                .font(.headline)

            VStack(spacing: 12) {
                TextField("Connection Name", text: $connectionName)
                    .textFieldStyle(.roundedBorder)

                HStack(spacing: 8) {
                    TextField("Host", text: $host)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    TextField("Port", text: $port)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numberPad)
                        .frame(width: 80)
                }

                SecureField("API Key (optional)", text: $apiKey)
                    .textFieldStyle(.roundedBorder)

                TextField("Sandbox Name (optional)", text: $sandboxName)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)

                Toggle("Use TLS", isOn: $useTLS)
            }

            if let errorMessage {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            Button {
                Task { await connectNew() }
            } label: {
                HStack {
                    if isConnecting {
                        ProgressView()
                            .tint(.white)
                    }
                    Text(isConnecting ? "Connecting..." : "Connect")
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(isConnecting ? .gray : .blue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(isConnecting || host.isEmpty)
        }
        .padding()
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // MARK: - Security Badges

    private var securityBadges: some View {
        VStack(spacing: 8) {
            HStack(spacing: 16) {
                SecurityBadge(icon: "shield.checkered", label: "Sentinel", detail: "All messages inspected")
                SecurityBadge(icon: "link", label: "Audit Chain", detail: "Hash-chained logging")
            }
            HStack(spacing: 16) {
                SecurityBadge(icon: "key.fill", label: "Keychain", detail: "Encrypted credentials")
                SecurityBadge(icon: "eye.slash.fill", label: "Privacy", detail: "No data collection")
            }
        }
    }

    // MARK: - Actions

    private func connectNew() async {
        isConnecting = true
        errorMessage = nil

        let config = GatewayConfig(
            host: host,
            port: Int(port) ?? 8080,
            useTLS: useTLS,
            apiKey: apiKey.isEmpty ? nil : apiKey,
            sandboxName: sandboxName.isEmpty ? nil : sandboxName
        )

        do {
            try await appState.gateway.connect(config: config)

            // Save connection
            let name = connectionName.isEmpty ? "\(host):\(port)" : connectionName
            let _ = try await appState.vault.store(name: name, config: config)
            savedConnections = await appState.vault.list()
        } catch {
            errorMessage = error.localizedDescription
        }

        isConnecting = false
    }

    private func connectSaved(_ credential: StoredCredential) async {
        isConnecting = true
        errorMessage = nil

        do {
            let config = try await appState.vault.getConfig(for: credential.id)
            try await appState.gateway.connect(config: config)
        } catch {
            errorMessage = error.localizedDescription
        }

        isConnecting = false
    }

    private func deleteConnection(_ id: String) async {
        try? await appState.vault.delete(id: id)
        savedConnections = await appState.vault.list()
    }
}

// MARK: - Security Badge

struct SecurityBadge: View {
    let icon: String
    let label: String
    let detail: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.blue)
            Text(label)
                .font(.caption.bold())
            Text(detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(10)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
