import Foundation
import CryptoKit

// MARK: - Keychain-Backed Credential Vault
// Stores gateway credentials securely using iOS Keychain + encryption

public struct StoredCredential: Sendable, Codable, Identifiable {
    public let id: String
    public let name: String
    public let host: String
    public let port: Int
    public let useTLS: Bool
    public let sandboxName: String?
    public let createdAt: Date
    public var lastUsed: Date?

    // API key stored separately in Keychain, not in this struct
}

public actor CredentialVault {
    private let audit: AuditLedger
    private let serviceName = "com.clawguard.credentials"
    private var cachedCredentials: [StoredCredential] = []

    public init(audit: AuditLedger) {
        self.audit = audit
    }

    // MARK: - Store Credential

    public func store(
        name: String,
        config: GatewayConfig
    ) async throws -> StoredCredential {
        let id = UUID().uuidString.lowercased()
        let credential = StoredCredential(
            id: id,
            name: name,
            host: config.host,
            port: config.port,
            useTLS: config.useTLS,
            sandboxName: config.sandboxName,
            createdAt: .now
        )

        // Store the API key in Keychain
        if let apiKey = config.apiKey {
            try storeInKeychain(key: keychainKey(for: id), value: apiKey)
        }

        // Store credential metadata
        try storeMetadata(credential)

        cachedCredentials.append(credential)

        await audit.record(
            type: "credential_stored",
            target: name,
            outcome: "success",
            details: ["id": id, "host": config.host]
        )

        return credential
    }

    // MARK: - Retrieve

    public func list() async -> [StoredCredential] {
        if cachedCredentials.isEmpty {
            cachedCredentials = (try? loadAllMetadata()) ?? []
        }
        return cachedCredentials
    }

    public func getConfig(for credentialId: String) async throws -> GatewayConfig {
        let credentials = await list()
        guard let credential = credentials.first(where: { $0.id == credentialId }) else {
            throw CredentialError.notFound(credentialId)
        }

        let apiKey = try? retrieveFromKeychain(key: keychainKey(for: credentialId))

        await audit.record(
            type: "credential_accessed",
            target: credential.name,
            outcome: "success",
            details: ["id": credentialId]
        )

        return GatewayConfig(
            host: credential.host,
            port: credential.port,
            useTLS: credential.useTLS,
            apiKey: apiKey,
            sandboxName: credential.sandboxName
        )
    }

    // MARK: - Delete

    public func delete(id: String) async throws {
        // Remove API key from Keychain
        deleteFromKeychain(key: keychainKey(for: id))

        // Remove metadata
        deleteFromKeychain(key: metadataKey(for: id))

        cachedCredentials.removeAll { $0.id == id }

        // Update the index
        try saveIndex()

        await audit.record(
            type: "credential_deleted",
            target: id,
            outcome: "success"
        )
    }

    // MARK: - Keychain Operations

    private func keychainKey(for id: String) -> String {
        "\(serviceName).apikey.\(id)"
    }

    private func metadataKey(for id: String) -> String {
        "\(serviceName).meta.\(id)"
    }

    private func indexKey() -> String {
        "\(serviceName).index"
    }

    private func storeInKeychain(key: String, value: String) throws {
        let data = Data(value.utf8)

        // Delete existing item first
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        // Add new item
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw CredentialError.keychainError(status)
        }
    }

    private func retrieveFromKeychain(key: String) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw CredentialError.keychainError(status)
        }
        return value
    }

    private func deleteFromKeychain(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Metadata Persistence

    private func storeMetadata(_ credential: StoredCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let encoded = String(data: data, encoding: .utf8)!
        try storeInKeychain(key: metadataKey(for: credential.id), value: encoded)

        // Update index
        var ids = (try? loadIndex()) ?? []
        if !ids.contains(credential.id) {
            ids.append(credential.id)
        }
        try storeInKeychain(key: indexKey(), value: ids.joined(separator: ","))
    }

    private func loadAllMetadata() throws -> [StoredCredential] {
        let ids = try loadIndex()
        return ids.compactMap { id in
            guard let json = try? retrieveFromKeychain(key: metadataKey(for: id)),
                  let data = json.data(using: .utf8),
                  let cred = try? JSONDecoder().decode(StoredCredential.self, from: data) else {
                return nil
            }
            return cred
        }
    }

    private func loadIndex() throws -> [String] {
        guard let raw = try? retrieveFromKeychain(key: indexKey()) else {
            return []
        }
        return raw.split(separator: ",").map(String.init)
    }

    private func saveIndex() throws {
        let ids = cachedCredentials.map(\.id).joined(separator: ",")
        if ids.isEmpty {
            deleteFromKeychain(key: indexKey())
        } else {
            try storeInKeychain(key: indexKey(), value: ids)
        }
    }
}

// MARK: - Errors

public enum CredentialError: Error, LocalizedError {
    case notFound(String)
    case keychainError(OSStatus)
    case encryptionFailed

    public var errorDescription: String? {
        switch self {
        case .notFound(let id): "Credential not found: \(id)"
        case .keychainError(let status): "Keychain error: \(status)"
        case .encryptionFailed: "Encryption failed"
        }
    }
}
