import Testing
@testable import ClawGuardCore

@Suite("AuditLedger Tests")
struct AuditLedgerTests {

    @Test func emptyChainIsValid() async {
        let ledger = AuditLedger()
        let result = await ledger.verifyChain()
        #expect(result.valid)
        #expect(result.reason == nil)
    }

    @Test func recordCreatesEntry() async {
        let ledger = AuditLedger()
        let entry = await ledger.record(type: "test", target: "unit", outcome: "success")
        #expect(entry.sequence == 1)
        #expect(entry.type == "test")
        #expect(entry.target == "unit")
        #expect(entry.outcome == "success")
        #expect(!entry.hash.isEmpty)
        #expect(await ledger.count == 1)
    }

    @Test func chainIntegrityHolds() async {
        let ledger = AuditLedger()
        await ledger.record(type: "first", target: "a", outcome: "success")
        await ledger.record(type: "second", target: "b", outcome: "success")
        await ledger.record(type: "third", target: "c", outcome: "failure")

        let result = await ledger.verifyChain()
        #expect(result.valid)
        #expect(await ledger.count == 3)
    }

    @Test func sequenceIncrementsMonotonically() async {
        let ledger = AuditLedger()
        let e1 = await ledger.record(type: "a", target: "t", outcome: "success")
        let e2 = await ledger.record(type: "b", target: "t", outcome: "success")
        let e3 = await ledger.record(type: "c", target: "t", outcome: "success")

        #expect(e1.sequence == 1)
        #expect(e2.sequence == 2)
        #expect(e3.sequence == 3)
    }

    @Test func entriesChainFromPrevious() async {
        let ledger = AuditLedger()
        let e1 = await ledger.record(type: "a", target: "t", outcome: "success")
        let e2 = await ledger.record(type: "b", target: "t", outcome: "success")

        #expect(e2.previousHash == e1.hash)
    }

    @Test func redactsSensitiveKeys() async {
        let redacted = AuditLedger.redact([
            "password": "mysecret",
            "api_key": "sk-abc123",
            "normal": "visible",
        ])

        #expect(redacted["password"] == "[REDACTED]")
        #expect(redacted["api_key"] == "[REDACTED]")
        #expect(redacted["normal"] == "visible")
    }

    @Test func redactsSensitivePatterns() async {
        let redacted = AuditLedger.redact([
            "value": "key is sk-abc123456789012345678901234567890 here",
            "token": "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        ])

        #expect(redacted["value"]!.contains("[REDACTED]"))
        #expect(redacted["token"] == "[REDACTED]") // key "token" is sensitive
    }

    @Test func queryFiltersByType() async {
        let ledger = AuditLedger()
        await ledger.record(type: "message_sent", target: "chat", outcome: "success")
        await ledger.record(type: "gateway_connected", target: "host", outcome: "success")
        await ledger.record(type: "message_sent", target: "chat", outcome: "success")

        let results = await ledger.query(typeFilter: "message_sent")
        #expect(results.count == 2)
    }

    @Test func queryRespectsLimit() async {
        let ledger = AuditLedger()
        for i in 0..<10 {
            await ledger.record(type: "test", target: "t\(i)", outcome: "success")
        }

        let results = await ledger.query(limit: 3)
        #expect(results.count == 3)
    }

    @Test func exportReturnsAllEntries() async {
        let ledger = AuditLedger()
        await ledger.record(type: "a", target: "t", outcome: "success")
        await ledger.record(type: "b", target: "t", outcome: "success")

        let all = await ledger.exportAll()
        #expect(all.count == 2)
    }
}
