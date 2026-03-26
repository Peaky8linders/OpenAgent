import Foundation
import CryptoKit

// MARK: - Audit Ledger (Swift port of Python AuditLedger)
// Append-only, hash-chained tamper-proof logging

public struct AuditLogEntry: Sendable, Codable, Identifiable {
    public let id: String
    public let sequence: Int
    public let timestamp: String
    public let type: String
    public let userId: String?
    public let target: String
    public let outcome: String
    public let details: [String: String]
    public let previousHash: String
    public let hash: String
}

public actor AuditLedger {
    private var entries: [AuditLogEntry] = []
    private var sequenceCounter: Int = 0
    private var lastHash: String

    private static let genesisHash: String = {
        let data = Data("OPENHARNESS_GENESIS_V1".utf8)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }()

    public init() {
        self.lastHash = Self.genesisHash
    }

    // MARK: - Record

    @discardableResult
    public func record(
        type entryType: String,
        target: String,
        outcome: String,
        details: [String: String]? = nil,
        userId: String? = nil
    ) -> AuditLogEntry {
        sequenceCounter += 1
        let entryId = UUID().uuidString.lowercased()
        let ts = ISO8601DateFormatter().string(from: Date())

        let safeDetails = Self.redact(details ?? [:])

        // Build hash payload (matches Python's JSON sort_keys=True)
        let payload: [String: Any] = [
            "details": safeDetails,
            "id": entryId,
            "outcome": outcome,
            "prev": lastHash,
            "seq": sequenceCounter,
            "target": target,
            "ts": ts,
            "type": entryType,
            "user": userId as Any? ?? NSNull(),
        ]
        let payloadString = Self.deterministicJSON(payload)
        let entryHash = Self.sha256(payloadString)

        let entry = AuditLogEntry(
            id: entryId,
            sequence: sequenceCounter,
            timestamp: ts,
            type: entryType,
            userId: userId,
            target: target,
            outcome: outcome,
            details: safeDetails,
            previousHash: lastHash,
            hash: entryHash
        )

        entries.append(entry)
        lastHash = entryHash
        return entry
    }

    // MARK: - Verify Chain

    public func verifyChain() -> (valid: Bool, reason: String?) {
        guard !entries.isEmpty else { return (true, nil) }

        if entries[0].previousHash != Self.genesisHash {
            return (false, "First entry doesn't chain from genesis")
        }

        for i in 1..<entries.count {
            if entries[i].previousHash != entries[i - 1].hash {
                return (false, "Chain break at entry \(i)")
            }
        }

        return (true, nil)
    }

    // MARK: - Query

    public func query(
        since: String? = nil,
        before: String? = nil,
        typeFilter: String? = nil,
        limit: Int = 100
    ) -> [AuditLogEntry] {
        var results = entries

        if let typeFilter {
            results = results.filter { $0.type == typeFilter }
        }
        if let since {
            results = results.filter { $0.timestamp >= since }
        }
        if let before {
            results = results.filter { $0.timestamp <= before }
        }

        return Array(results.suffix(limit))
    }

    public var count: Int { entries.count }

    // MARK: - Export (for compliance)

    public func exportAll() -> [AuditLogEntry] { entries }

    // MARK: - Private Helpers

    private static let sensitiveKeyPattern = try! NSRegularExpression(
        pattern: #"(?:password|token|secret|key|credential|api_key|apikey)"#,
        options: .caseInsensitive
    )

    private static let valueRedactPatterns = [
        try! NSRegularExpression(pattern: #"(?:sk-|ghp_|AKIA)\S+"#)
    ]

    static func redact(_ details: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in details {
            let nsKey = key as NSString
            let keyRange = NSRange(location: 0, length: nsKey.length)
            if sensitiveKeyPattern.firstMatch(in: key, range: keyRange) != nil {
                result[key] = "[REDACTED]"
                continue
            }
            var redacted = value
            for pattern in valueRedactPatterns {
                let nsVal = redacted as NSString
                let range = NSRange(location: 0, length: nsVal.length)
                redacted = pattern.stringByReplacingMatches(
                    in: redacted, range: range, withTemplate: "[REDACTED]"
                )
            }
            result[key] = redacted
        }
        return result
    }

    private static func sha256(_ string: String) -> String {
        let data = Data(string.utf8)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func deterministicJSON(_ dict: [String: Any]) -> String {
        // Use JSONSerialization with sorted keys to match Python json.dumps(sort_keys=True)
        if #available(iOS 17.0, macOS 14.0, *) {
            let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
            if let data = try? JSONSerialization.data(withJSONObject: dict, options: options),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
        }
        // Fallback: manual sorted-key serialization with proper escaping
        let pairs = dict.keys.sorted().map { key -> String in
            let value = dict[key]!
            return "\"\(escapeJSON(key))\": \(serializeValue(value))"
        }
        return "{\(pairs.joined(separator: ", "))}"
    }

    private static func escapeJSON(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "\"", with: "\\\"")
         .replacingOccurrences(of: "\n", with: "\\n")
         .replacingOccurrences(of: "\r", with: "\\r")
         .replacingOccurrences(of: "\t", with: "\\t")
    }

    private static func serializeValue(_ value: Any) -> String {
        switch value {
        case let s as String:
            return "\"\(escapeJSON(s))\""
        case let n as Int:
            return "\(n)"
        case let d as Double:
            return "\(d)"
        case let b as Bool:
            return b ? "true" : "false"
        case let d as [String: Any]:
            return deterministicJSON(d)
        case is NSNull:
            return "null"
        default:
            if "\(value)" == "null" { return "null" }
            return "\"\(escapeJSON("\(value)"))\""
        }
    }
}
