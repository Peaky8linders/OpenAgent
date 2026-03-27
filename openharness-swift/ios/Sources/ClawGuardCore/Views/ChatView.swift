import SwiftUI

// MARK: - Chat View with Sentinel-Enforced Message Flow

public struct ChatView: View {
    @Environment(AppState.self) private var appState
    @State private var inputText = ""
    @State private var isSending = false
    @State private var showSentinelAlert = false
    @State private var sentinelAlertMessage = ""
    @FocusState private var inputFocused: Bool

    public init() {}

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                messageList
                sentinelStatusBar
                inputBar
            }
            .navigationTitle("Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    connectionIndicator
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        appState.gateway.clearHistory()
                    } label: {
                        Image(systemName: "trash")
                    }
                }
            }
            .alert("Message Blocked", isPresented: $showSentinelAlert) {
                Button("OK") {}
            } message: {
                Text(sentinelAlertMessage)
            }
        }
    }

    // MARK: - Message List

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if appState.gateway.messages.isEmpty {
                        emptyState
                    }

                    ForEach(appState.gateway.messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                    }
                }
                .padding()
            }
            .onChange(of: appState.gateway.messages.count) { _, _ in
                if let last = appState.gateway.messages.last {
                    withAnimation {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "shield.lock.fill")
                .font(.system(size: 48))
                .foregroundStyle(.blue.opacity(0.5))

            Text("Secure Agent Chat")
                .font(.title3.bold())

            VStack(alignment: .leading, spacing: 8) {
                FeatureRow(icon: "shield.checkered", text: "Every message inspected by sentinel")
                FeatureRow(icon: "link", text: "All actions audit-logged with hash chain")
                FeatureRow(icon: "eye.slash", text: "PII and credentials auto-detected")
                FeatureRow(icon: "xmark.shield", text: "Injection attempts blocked")
            }
            .padding()
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 12))

            Spacer()
        }
        .padding(.top, 40)
    }

    // MARK: - Sentinel Status Bar

    private var sentinelStatusBar: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(.green)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text("Sentinel active")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
            if let lastMessage = appState.gateway.messages.last,
               let sentinel = lastMessage.metadata?.sentinelResult {
                HStack(spacing: 4) {
                    Image(systemName: sentinelIcon(for: sentinel.threatLevel))
                        .font(.caption2)
                        .foregroundStyle(sentinelColor(for: sentinel.threatLevel))
                    Text("\(sentinel.latencyMs, specifier: "%.1f")ms")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Last message threat level: \(sentinel.threatLevel), inspection time \(String(format: "%.1f", sentinel.latencyMs)) milliseconds")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sentinel security status bar")
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Message...", text: $inputText, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(10)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .focused($inputFocused)
                .onSubmit { Task { await sendMessage() } }

            Button {
                Task { await sendMessage() }
            } label: {
                Image(systemName: isSending ? "ellipsis.circle.fill" : "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .gray : .blue)
                    .symbolEffect(.rotate, isActive: isSending)
            }
            .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: - Connection Indicator

    private var connectionIndicator: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(appState.isConnected ? .green : .red)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(appState.isConnected ? "Connected" : "Disconnected")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Gateway connection status: \(appState.isConnected ? "connected" : "disconnected")")
    }

    // MARK: - Actions

    private func sendMessage() async {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        isSending = true
        inputText = ""

        do {
            let _ = try await appState.gateway.send(text)
        } catch let error as GatewayError {
            switch error {
            case .messageBlocked(let reason):
                sentinelAlertMessage = "Your message was blocked by the sentinel:\n\n\(reason)"
                showSentinelAlert = true
            default:
                sentinelAlertMessage = error.localizedDescription
                showSentinelAlert = true
            }
        } catch {
            sentinelAlertMessage = error.localizedDescription
            showSentinelAlert = true
        }

        isSending = false
    }

    // MARK: - Helpers

    private func sentinelIcon(for level: String) -> String {
        switch level {
        case "safe": "checkmark.shield"
        case "suspicious": "exclamationmark.shield"
        case "blocked": "xmark.shield"
        default: "shield"
        }
    }

    private func sentinelColor(for level: String) -> Color {
        switch level {
        case "safe": .green
        case "suspicious": .orange
        case "blocked": .red
        default: .gray
        }
    }
}

// MARK: - Message Bubble

struct MessageBubble: View {
    let message: AgentMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 60) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
                Text(message.content)
                    .padding(12)
                    .background(bubbleColor)
                    .foregroundStyle(message.role == .user ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                HStack(spacing: 6) {
                    if let sentinel = message.metadata?.sentinelResult {
                        Image(systemName: sentinel.threatLevel == "safe" ? "checkmark.shield" : "exclamationmark.shield")
                            .font(.caption2)
                            .foregroundStyle(sentinel.threatLevel == "safe" ? .green : .orange)
                    }

                    if let tokens = message.metadata?.tokensUsed {
                        Text("\(tokens) tokens")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    Text(message.timestamp, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if message.role != .user { Spacer(minLength: 60) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.role.rawValue) message: \(message.content)")
    }

    private var bubbleColor: Color {
        switch message.role {
        case .user: .blue
        case .assistant: Color(.systemGray6)
        case .system: Color(.systemYellow).opacity(0.2)
        case .tool: Color(.systemPurple).opacity(0.2)
        }
    }
}

// MARK: - Feature Row

struct FeatureRow: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.blue)
                .frame(width: 20)
            Text(text)
                .font(.caption)
        }
    }
}
