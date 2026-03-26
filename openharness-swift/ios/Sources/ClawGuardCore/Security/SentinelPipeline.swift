import Foundation

// MARK: - Sentinel Pipeline (Swift port of Python security/__init__.py)
// Content inspection before persistence — blocks injection, credential leaks, PHI

public struct ThreatFinding: Sendable, Codable, Equatable {
    public let category: String
    public let confidence: Double
    public let description: String
    public let matchedPattern: String?

    public init(category: String, confidence: Double, description: String, matchedPattern: String? = nil) {
        self.category = category
        self.confidence = confidence
        self.description = description
        self.matchedPattern = matchedPattern
    }
}

public enum ThreatLevel: String, Sendable, Codable {
    case safe
    case suspicious
    case blocked
}

public struct InspectionResult: Sendable, Codable {
    public let threatLevel: ThreatLevel
    public let findings: [ThreatFinding]
    public let latencyMs: Double
}

// MARK: - Pattern Definitions

private struct PatternDef {
    let regex: NSRegularExpression
    let category: String
    let description: String
}

private let injectionPatterns: [PatternDef] = {
    func p(_ pattern: String, _ category: String, _ desc: String) -> PatternDef? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return nil }
        return PatternDef(regex: re, category: category, description: desc)
    }
    return [
        p(#"(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?)"#,
          "prompt_injection", "Attempts to override system instructions"),
        p(#"you\s+are\s+now\s+(?:a|an|in)\s+(?:new|different|unrestricted|jailbreak)"#,
          "prompt_injection", "Persona override injection"),
        p(#"\[(?:system|admin|root|sudo)\]|\{\{(?:system|admin)\}\}"#,
          "system_override", "Fake system/admin tag"),
        p(#"(?:secretly|quietly|silently|without\s+(?:telling|informing))\s+(?:send|forward|email|post|upload|exfiltrate)"#,
          "hidden_instruction", "Hidden exfiltration instruction"),
        p(#"forward\s+(?:the\s+)?(?:contents?\s+of|all)\s+(?:~/|/home|/etc|\.ssh|\.env|\.aws|credentials?|secrets?|keys?)"#,
          "data_exfiltration", "File/credential exfiltration"),
        p(#"(?:I\s+am|this\s+is)\s+(?:the\s+)?(?:admin|administrator|system|root|owner|developer)"#,
          "authority_exploit", "False authority claim"),
        p(#"(?:remember|memorize|always)\s+(?:that|this|the\s+(?:following|rule))\s*:?\s*(?:always|never|from\s+now)"#,
          "memory_poisoning", "Persistent instruction injection"),
    ].compactMap { $0 }
}()

private struct CredentialPatternDef {
    let regex: NSRegularExpression
    let description: String
}

private let credentialPatterns: [CredentialPatternDef] = {
    func p(_ pattern: String, _ desc: String) -> CredentialPatternDef? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return nil }
        return CredentialPatternDef(regex: re, description: desc)
    }
    return [
        p(#"(?:sk|pk|rk)-(?:[a-zA-Z0-9]+-)?[a-zA-Z0-9]{20,}"#, "API key (sk-/pk-/rk- prefix)"),
        p(#"ghp_[a-zA-Z0-9]{36,}"#, "GitHub PAT"),
        p(#"AKIA[0-9A-Z]{16}"#, "AWS access key"),
        p(#"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----"#, "Private key"),
        p(#"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}"#, "JWT token"),
        p(#"(?:password|passwd|pwd)\s*[:=]\s*\S{6,}"#, "Plaintext password"),
    ].compactMap { $0 }
}()

private struct PHIPatternDef {
    let regex: NSRegularExpression
    let category: String
    let description: String
}

private let phiPatterns: [PHIPatternDef] = {
    func p(_ pattern: String, _ cat: String, _ desc: String) -> PHIPatternDef? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return nil }
        return PHIPatternDef(regex: re, category: cat, description: desc)
    }
    return [
        p(#"\b\d{3}-\d{2}-\d{4}\b"#, "pii_exposure", "SSN"),
        p(#"\bMRN\s*:?\s*\d{6,}"#, "phi_exposure", "Medical Record Number"),
        p(#"\b(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})\s?\d{4}\s?\d{4}\s?\d{4}\b"#, "pii_exposure", "Credit card"),
    ].compactMap { $0 }
}()

// MARK: - Critical Categories

private let criticalCategories: Set<String> = [
    "prompt_injection", "data_exfiltration", "credential_leak", "system_override"
]

// MARK: - Pipeline

public final class SentinelPipeline: @unchecked Sendable {
    public let blockOnSuspicious: Bool
    public let phiDetection: Bool

    public init(blockOnSuspicious: Bool = true, phiDetection: Bool = true) {
        self.blockOnSuspicious = blockOnSuspicious
        self.phiDetection = phiDetection
    }

    public func inspect(_ content: String) -> InspectionResult {
        let start = CFAbsoluteTimeGetCurrent()
        var findings: [ThreatFinding] = []

        // Normalize whitespace for injection detection
        let normalized = content.replacingOccurrences(
            of: #"\s+"#, with: " ", options: .regularExpression
        )
        let nsNormalized = normalized as NSString
        let nsContent = content as NSString

        // Injection patterns
        for pattern in injectionPatterns {
            let range = NSRange(location: 0, length: nsNormalized.length)
            if let match = pattern.regex.firstMatch(in: normalized, range: range) {
                let matched = nsNormalized.substring(with: match.range)
                let truncated = String(matched.prefix(30))
                findings.append(ThreatFinding(
                    category: pattern.category,
                    confidence: 85,
                    description: pattern.description,
                    matchedPattern: truncated
                ))
            }
        }

        // Credential patterns
        for pattern in credentialPatterns {
            let range = NSRange(location: 0, length: nsContent.length)
            if let match = pattern.regex.firstMatch(in: content, range: range) {
                let matched = nsContent.substring(with: match.range)
                let redacted = String(matched.prefix(20)) + "...[REDACTED]"
                findings.append(ThreatFinding(
                    category: "credential_leak",
                    confidence: 90,
                    description: pattern.description,
                    matchedPattern: redacted
                ))
            }
        }

        // PHI patterns
        if phiDetection {
            for pattern in phiPatterns {
                let range = NSRange(location: 0, length: nsContent.length)
                if pattern.regex.firstMatch(in: content, range: range) != nil {
                    findings.append(ThreatFinding(
                        category: pattern.category,
                        confidence: 75,
                        description: pattern.description
                    ))
                }
            }
        }

        // Determine threat level
        let threatLevel: ThreatLevel
        if findings.isEmpty {
            threatLevel = .safe
        } else {
            let highConf = findings.contains { $0.confidence >= 85 }
            let critical = findings.contains { criticalCategories.contains($0.category) }
            if highConf && critical {
                threatLevel = .blocked
            } else if blockOnSuspicious {
                threatLevel = highConf ? .blocked : .suspicious
            } else {
                threatLevel = .suspicious
            }
        }

        let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
        return InspectionResult(
            threatLevel: threatLevel,
            findings: findings,
            latencyMs: (elapsed * 100).rounded() / 100
        )
    }
}
