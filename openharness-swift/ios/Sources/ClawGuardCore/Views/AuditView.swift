import SwiftUI

// MARK: - Audit Trail View
// Real-time view of the hash-chained audit ledger

struct AuditView: View {
    @Environment(AppState.self) private var appState
    @State private var entries: [AuditLogEntry] = []
    @State private var chainValid = true
    @State private var chainReason: String?
    @State private var filterType: String?
    @State private var isVerifying = false

    private let auditTypes = [
        nil, "message_sent", "message_blocked", "message_sentinel_check",
        "gateway_connected", "credential_stored", "credential_accessed",
    ]

    var body: some View {
        NavigationStack {
            List {
                chainStatusSection
                filterSection
                entriesSection
            }
            .navigationTitle("Audit Trail")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await verifyChain() }
                    } label: {
                        Label("Verify", systemImage: "checkmark.seal")
                    }
                    .disabled(isVerifying)
                }
            }
            .task { await refresh() }
            .refreshable { await refresh() }
        }
    }

    // MARK: - Chain Status

    private var chainStatusSection: some View {
        Section {
            HStack {
                Image(systemName: chainValid ? "checkmark.seal.fill" : "xmark.seal.fill")
                    .foregroundStyle(chainValid ? .green : .red)
                    .font(.title2)

                VStack(alignment: .leading) {
                    Text(chainValid ? "Chain Integrity Verified" : "Chain Integrity BROKEN")
                        .font(.headline)
                    if let reason = chainReason {
                        Text(reason)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    Text("\(entries.count) entries in chain")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Filter

    private var filterSection: some View {
        Section("Filter") {
            Picker("Event Type", selection: $filterType) {
                Text("All").tag(nil as String?)
                ForEach(auditTypes.compactMap({ $0 }), id: \.self) { type in
                    Text(type.replacingOccurrences(of: "_", with: " "))
                        .tag(type as String?)
                }
            }
            .pickerStyle(.menu)
            .onChange(of: filterType) { _, _ in
                Task { await refresh() }
            }
        }
    }

    // MARK: - Entries

    private var entriesSection: some View {
        Section("Events (\(entries.count))") {
            ForEach(entries) { entry in
                AuditEntryRow(entry: entry)
            }
        }
    }

    // MARK: - Actions

    private func refresh() async {
        entries = await appState.audit.query(typeFilter: filterType, limit: 200)
        let result = await appState.audit.verifyChain()
        chainValid = result.valid
        chainReason = result.reason
    }

    private func verifyChain() async {
        isVerifying = true
        let result = await appState.audit.verifyChain()
        chainValid = result.valid
        chainReason = result.reason

        await appState.audit.record(
            type: "audit_verification",
            target: "chain",
            outcome: result.valid ? "success" : "failure"
        )

        // Refresh after verification (which adds its own entry)
        entries = await appState.audit.query(typeFilter: filterType, limit: 200)
        isVerifying = false
    }
}

// MARK: - Audit Entry Row

struct AuditEntryRow: View {
    let entry: AuditLogEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: iconForType(entry.type))
                    .foregroundStyle(colorForOutcome(entry.outcome))
                    .font(.caption)

                Text(entry.type.replacingOccurrences(of: "_", with: " "))
                    .font(.subheadline.bold())

                Spacer()

                Text(formatTimestamp(entry.timestamp))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text("Target: \(entry.target)")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                Text(entry.outcome)
                    .font(.caption)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(colorForOutcome(entry.outcome).opacity(0.15))
                    .clipShape(Capsule())
                    .foregroundStyle(colorForOutcome(entry.outcome))
            }

            if !entry.details.isEmpty {
                HStack(spacing: 4) {
                    ForEach(Array(entry.details.keys.sorted().prefix(3)), id: \.self) { key in
                        Text("\(key): \(entry.details[key] ?? "")")
                            .font(.caption2)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(.ultraThinMaterial)
                            .clipShape(Capsule())
                    }
                }
            }

            Text("seq #\(entry.sequence) | \(String(entry.hash.prefix(12)))...")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }

    private func iconForType(_ type: String) -> String {
        if type.contains("sentinel") || type.contains("blocked") { return "shield.fill" }
        if type.contains("message") { return "message.fill" }
        if type.contains("gateway") { return "network" }
        if type.contains("credential") { return "key.fill" }
        if type.contains("audit") { return "checkmark.seal" }
        if type.contains("system") { return "gear" }
        return "circle.fill"
    }

    private func colorForOutcome(_ outcome: String) -> Color {
        switch outcome {
        case "success", "safe": .green
        case "failure", "blocked": .red
        case "suspicious", "pending": .orange
        default: .gray
        }
    }

    private func formatTimestamp(_ ts: String) -> String {
        // ISO8601 → short time
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: ts) else { return ts }
        let display = DateFormatter()
        display.timeStyle = .medium
        return display.string(from: date)
    }
}
