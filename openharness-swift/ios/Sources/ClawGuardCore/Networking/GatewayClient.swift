import Foundation

// MARK: - OpenClaw/NemoClaw Gateway Client
// Connects to an OpenClaw gateway over WebSocket with sentinel enforcement on all messages

public enum GatewayConnectionState: Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed(Error)
}

public struct GatewayConfig: Sendable, Codable {
    public var host: String
    public var port: Int
    public var useTLS: Bool
    public var apiKey: String?
    public var sandboxName: String?
    public var timeoutSeconds: Double

    public init(
        host: String = "localhost",
        port: Int = 8080,
        useTLS: Bool = true,
        apiKey: String? = nil,
        sandboxName: String? = nil,
        timeoutSeconds: Double = 30
    ) {
        self.host = host
        self.port = port
        self.useTLS = useTLS
        self.apiKey = apiKey
        self.sandboxName = sandboxName
        self.timeoutSeconds = timeoutSeconds
    }

    public var baseURL: URL? {
        let scheme = useTLS ? "https" : "http"
        let sanitizedHost = host.addingPercentEncoding(withAllowedCharacters: .urlHostAllowed) ?? host
        return URL(string: "\(scheme)://\(sanitizedHost):\(port)")
    }

    public var wsURL: URL? {
        let scheme = useTLS ? "wss" : "ws"
        let sanitizedHost = host.addingPercentEncoding(withAllowedCharacters: .urlHostAllowed) ?? host
        return URL(string: "\(scheme)://\(sanitizedHost):\(port)/ws")
    }
}

// MARK: - Message Types

public struct AgentMessage: Sendable, Codable, Identifiable {
    public let id: String
    public let role: MessageRole
    public let content: String
    public let timestamp: Date
    public let metadata: MessageMetadata?

    public init(id: String = UUID().uuidString, role: MessageRole, content: String, timestamp: Date = .now, metadata: MessageMetadata? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.metadata = metadata
    }
}

public enum MessageRole: String, Sendable, Codable {
    case user
    case assistant
    case system
    case tool
}

public struct MessageMetadata: Sendable, Codable {
    public var model: String?
    public var tokensUsed: Int?
    public var toolCalls: [ToolCall]?
    public var sentinelResult: SentinelMetadata?
}

public struct SentinelMetadata: Sendable, Codable {
    public let threatLevel: String
    public let findingsCount: Int
    public let latencyMs: Double
}

public struct ToolCall: Sendable, Codable {
    public let name: String
    public let arguments: String?
    public let result: String?
}

// MARK: - Gateway Errors

public enum GatewayError: Error, LocalizedError {
    case connectionFailed(String)
    case messageBlocked(String)
    case authenticationFailed
    case timeout
    case invalidResponse(String)
    case sandboxNotFound(String)

    public var errorDescription: String? {
        switch self {
        case .connectionFailed(let reason): "Connection failed: \(reason)"
        case .messageBlocked(let reason): "Message blocked by sentinel: \(reason)"
        case .authenticationFailed: "Authentication failed — check API key"
        case .timeout: "Request timed out"
        case .invalidResponse(let detail): "Invalid response: \(detail)"
        case .sandboxNotFound(let name): "Sandbox '\(name)' not found"
        }
    }
}

// MARK: - Gateway Client

@Observable @MainActor
public final class GatewayClient {
    public private(set) var connectionState: GatewayConnectionState = .disconnected
    public private(set) var messages: [AgentMessage] = []

    private let sentinel: SentinelPipeline
    private let audit: AuditLedger
    private var config: GatewayConfig?
    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveTask: Task<Void, Never>?
    private static let maxMessages = 500

    public init(sentinel: SentinelPipeline, audit: AuditLedger) {
        self.sentinel = sentinel
        self.audit = audit
    }

    deinit {
        receiveTask?.cancel()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
    }

    // MARK: - Connection

    public func connect(config: GatewayConfig) async throws {
        self.config = config
        connectionState = .connecting

        guard let baseURL = config.baseURL else {
            throw GatewayError.connectionFailed("Invalid host or port")
        }

        await audit.record(
            type: "gateway_connect_attempt",
            target: baseURL.absoluteString,
            outcome: "pending",
            details: ["host": config.host, "port": String(config.port)]
        )

        // First verify the gateway is reachable via HTTP health check
        let healthURL = baseURL.appendingPathComponent("health")
        var healthRequest = URLRequest(url: healthURL, timeoutInterval: config.timeoutSeconds)
        if let apiKey = config.apiKey {
            healthRequest.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (_, response) = try await URLSession.shared.data(for: healthRequest)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                throw GatewayError.connectionFailed("Gateway health check failed")
            }
        } catch let error as GatewayError {
            connectionState = .failed(error)
            await audit.record(type: "gateway_connect_failed", target: config.host, outcome: "failure", details: ["error": error.localizedDescription])
            throw error
        } catch {
            connectionState = .failed(error)
            await audit.record(type: "gateway_connect_failed", target: config.host, outcome: "failure", details: ["error": error.localizedDescription])
            throw GatewayError.connectionFailed(error.localizedDescription)
        }

        // Establish WebSocket connection
        let session = URLSession(configuration: .default)
        self.session = session

        guard let wsURL = config.wsURL else {
            throw GatewayError.connectionFailed("Invalid WebSocket URL")
        }

        var wsRequest = URLRequest(url: wsURL)
        if let apiKey = config.apiKey {
            wsRequest.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        if let sandbox = config.sandboxName {
            wsRequest.setValue(sandbox, forHTTPHeaderField: "X-Sandbox-Name")
        }

        let task = session.webSocketTask(with: wsRequest)
        self.webSocketTask = task
        task.resume()

        connectionState = .connected
        await audit.record(type: "gateway_connected", target: config.host, outcome: "success")

        // Start receiving messages
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    public func disconnect() async {
        receiveTask?.cancel()
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        connectionState = .disconnected

        if let host = config?.host {
            await audit.record(type: "gateway_disconnected", target: host, outcome: "success")
        }
    }

    // MARK: - Send Message (with sentinel enforcement)

    public func send(_ content: String) async throws -> AgentMessage {
        guard case .connected = connectionState else {
            throw GatewayError.connectionFailed("Not connected to gateway")
        }

        // SENTINEL CHECK — inspect outbound message before sending
        let inspection = sentinel.inspect(content)

        let sentinelMeta = SentinelMetadata(
            threatLevel: inspection.threatLevel.rawValue,
            findingsCount: inspection.findings.count,
            latencyMs: inspection.latencyMs
        )

        await audit.record(
            type: "message_sentinel_check",
            target: "outbound",
            outcome: inspection.threatLevel.rawValue,
            details: [
                "findings": String(inspection.findings.count),
                "latency_ms": String(inspection.latencyMs),
            ]
        )

        if inspection.threatLevel == .blocked {
            let reasons = inspection.findings.map(\.description).joined(separator: "; ")
            await audit.record(
                type: "message_blocked",
                target: "outbound",
                outcome: "blocked",
                details: ["reason": reasons]
            )
            throw GatewayError.messageBlocked(reasons)
        }

        // Add user message to local history (capped)
        let userMessage = AgentMessage(
            role: .user,
            content: content,
            metadata: MessageMetadata(sentinelResult: sentinelMeta)
        )
        appendMessage(userMessage)

        // Send via WebSocket
        let payload: [String: Any] = [
            "type": "message",
            "content": content,
            "id": userMessage.id,
        ]
        let jsonData = try JSONSerialization.data(withJSONObject: payload)
        let jsonString = String(data: jsonData, encoding: .utf8) ?? "{}"

        try await webSocketTask?.send(.string(jsonString))

        await audit.record(
            type: "message_sent",
            target: config?.host ?? "unknown",
            outcome: "success",
            details: ["message_id": userMessage.id, "length": String(content.count)]
        )

        return userMessage
    }

    // MARK: - Receive Loop

    private func receiveLoop() async {
        guard let ws = webSocketTask else { return }
        var retryCount = 0
        let maxRetries = 5

        while !Task.isCancelled {
            do {
                let message = try await ws.receive()
                retryCount = 0 // Reset on successful receive
                switch message {
                case .string(let text):
                    handleIncoming(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        handleIncoming(text)
                    }
                @unknown default:
                    break
                }
            } catch {
                if Task.isCancelled { break }

                retryCount += 1
                if retryCount > maxRetries {
                    connectionState = .failed(error)
                    await audit.record(
                        type: "gateway_receive_error",
                        target: config?.host ?? "unknown",
                        outcome: "failure",
                        details: ["error": error.localizedDescription, "retries_exhausted": "true"]
                    )
                    break
                }

                // Exponential backoff reconnect
                connectionState = .reconnecting
                await audit.record(
                    type: "gateway_reconnecting",
                    target: config?.host ?? "unknown",
                    outcome: "pending",
                    details: ["retry": String(retryCount)]
                )
                let delay = min(pow(2.0, Double(retryCount)), 30.0)
                try? await Task.sleep(for: .seconds(delay))

                if let config, let wsURL = config.wsURL {
                    var wsRequest = URLRequest(url: wsURL)
                    if let apiKey = config.apiKey {
                        wsRequest.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
                    }
                    let newTask = (session ?? URLSession(configuration: .default)).webSocketTask(with: wsRequest)
                    self.webSocketTask = newTask
                    newTask.resume()
                    connectionState = .connected
                } else {
                    break
                }
            }
        }
    }

    private func handleIncoming(_ text: String) async {
        // SENTINEL CHECK — inspect inbound message before displaying
        let inspection = sentinel.inspect(text)

        await audit.record(
            type: "message_received_sentinel",
            target: "inbound",
            outcome: inspection.threatLevel.rawValue,
            details: [
                "findings": String(inspection.findings.count),
                "length": String(text.count),
            ]
        )

        let sentinelMeta = SentinelMetadata(
            threatLevel: inspection.threatLevel.rawValue,
            findingsCount: inspection.findings.count,
            latencyMs: inspection.latencyMs
        )

        // Parse the response
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        let content: String
        if inspection.threatLevel == .blocked {
            // Redact blocked content — show warning instead
            content = "[BLOCKED BY SENTINEL] Response contained potentially harmful content and was redacted for your safety."
            await audit.record(
                type: "inbound_message_blocked",
                target: "display",
                outcome: "blocked",
                details: ["original_length": String(text.count)]
            )
        } else {
            content = json["content"] as? String ?? text
        }

        var metadata = MessageMetadata(sentinelResult: sentinelMeta)
        metadata.model = json["model"] as? String
        metadata.tokensUsed = json["tokens_used"] as? Int

        let agentMessage = AgentMessage(
            role: .assistant,
            content: content,
            metadata: metadata
        )

        appendMessage(agentMessage)
    }

    /// Append message with cap to prevent unbounded growth
    private func appendMessage(_ message: AgentMessage) {
        messages.append(message)
        if messages.count > Self.maxMessages {
            messages.removeFirst(messages.count - Self.maxMessages)
        }
    }

    // MARK: - REST API Fallback

    /// Send a message via REST API instead of WebSocket (for gateways that don't support WS)
    public func sendREST(_ content: String) async throws -> AgentMessage {
        guard let config else {
            throw GatewayError.connectionFailed("No configuration set")
        }

        // Sentinel check outbound
        let inspection = sentinel.inspect(content)
        if inspection.threatLevel == .blocked {
            let reasons = inspection.findings.map(\.description).joined(separator: "; ")
            await audit.record(type: "message_blocked", target: "outbound_rest", outcome: "blocked", details: ["reason": reasons])
            throw GatewayError.messageBlocked(reasons)
        }

        let userMessage = AgentMessage(role: .user, content: content)
        appendMessage(userMessage)

        guard let baseURL = config.baseURL else {
            throw GatewayError.connectionFailed("Invalid URL")
        }
        let url = baseURL.appendingPathComponent("v1/chat/completions")
        var request = URLRequest(url: url, timeoutInterval: config.timeoutSeconds)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let apiKey = config.apiKey {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        let body: [String: Any] = [
            "messages": messages.map { ["role": $0.role.rawValue, "content": $0.content] },
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw GatewayError.invalidResponse("HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any],
              let assistantContent = message["content"] as? String else {
            throw GatewayError.invalidResponse("Could not parse response")
        }

        // Sentinel check inbound
        let inboundInspection = sentinel.inspect(assistantContent)
        let finalContent: String
        if inboundInspection.threatLevel == .blocked {
            finalContent = "[BLOCKED BY SENTINEL] Response redacted."
            await audit.record(type: "inbound_rest_blocked", target: "display", outcome: "blocked")
        } else {
            finalContent = assistantContent
        }

        let sentinelMeta = SentinelMetadata(
            threatLevel: inboundInspection.threatLevel.rawValue,
            findingsCount: inboundInspection.findings.count,
            latencyMs: inboundInspection.latencyMs
        )

        let assistantMessage = AgentMessage(
            role: .assistant,
            content: finalContent,
            metadata: MessageMetadata(
                model: json["model"] as? String,
                tokensUsed: (json["usage"] as? [String: Any])?["total_tokens"] as? Int,
                sentinelResult: sentinelMeta
            )
        )
        messages.append(assistantMessage)

        await audit.record(
            type: "message_exchange_rest",
            target: config.host,
            outcome: "success",
            details: ["message_id": assistantMessage.id]
        )

        return assistantMessage
    }

    // MARK: - Gateway Info

    public func fetchGatewayInfo() async throws -> GatewayInfo {
        guard let config, let baseURL = config.baseURL else {
            throw GatewayError.connectionFailed("No config or invalid URL")
        }

        let url = baseURL.appendingPathComponent("health")
        var request = URLRequest(url: url, timeoutInterval: config.timeoutSeconds)
        if let apiKey = config.apiKey {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(GatewayInfo.self, from: data)
    }

    /// List available sandboxes on the gateway
    public func listSandboxes() async throws -> [SandboxInfo] {
        guard let config, let baseURL = config.baseURL else {
            throw GatewayError.connectionFailed("No config or invalid URL")
        }

        let url = baseURL.appendingPathComponent("v1/sandboxes")
        var request = URLRequest(url: url, timeoutInterval: config.timeoutSeconds)
        if let apiKey = config.apiKey {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(SandboxListResponse.self, from: data)
        return response.sandboxes
    }

    public func clearHistory() {
        messages.removeAll()
    }
}

// MARK: - Gateway Info Models

public struct GatewayInfo: Sendable, Codable {
    public let status: String?
    public let version: String?
    public let name: String?
    public let uptime: Double?
}

public struct SandboxInfo: Sendable, Codable, Identifiable {
    public var id: String { name }
    public let name: String
    public let status: String
    public let template: String?
    public let createdAt: String?
}

private struct SandboxListResponse: Codable {
    let sandboxes: [SandboxInfo]
}
