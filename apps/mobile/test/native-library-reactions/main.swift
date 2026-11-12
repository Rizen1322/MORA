import Foundation

func reject(_ operation: () throws -> Void) {
    do { try operation(); fatalError("Unconfirmed reaction accepted") } catch {}
}

@MainActor func checkReactions() async throws {
    let suite = "mora.native-library-reactions.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    var outbox = NativeReactionOutbox(defaults: defaults)
    outbox.set("track", 1)
    precondition(NativeReactionOutbox(defaults: defaults).pending == ["track": 1])
    var sent: [(String, Int)] = []
    try await NativeLibraryReactions.drain(next: { outbox.pending.first.map { ($0.key, $0.value) } }, send: { id, value in
        sent.append((id, value))
        if sent.count == 1 {
            await Task.yield()
            // A newer gesture and a second track arrive while the first request is in flight.
            outbox.set("track", -1); outbox.set("other", 1)
        }
        try NativeLibraryReactions.validate(["ok": true, "value": value, "sync": ["status": "pending"]], value: value)
    }, acknowledge: { outbox.acknowledge($0, $1) })
    precondition(sent.count == 3 && sent[0].0 == "track" && sent[0].1 == 1)
    precondition(sent.contains { $0.0 == "track" && $0.1 == -1 })
    precondition(sent.contains { $0.0 == "other" && $0.1 == 1 })
    precondition(outbox.pending.isEmpty && NativeReactionOutbox(defaults: defaults).pending.isEmpty)

    outbox.set("track", 1)
    var acknowledged = false
    do {
        try await NativeLibraryReactions.drain(next: { outbox.pending.first.map { ($0.key, $0.value) } }, send: { _, _ in
            throw NativeLibraryReactions.Failure(message: "Сервер временно недоступен")
        }, acknowledge: { id, value in acknowledged = true; outbox.acknowledge(id, value) })
        fatalError("Failed reaction was acknowledged")
    } catch is NativeLibraryReactions.Failure {}
    precondition(!acknowledged && NativeReactionOutbox(defaults: defaults).pending == ["track": 1])
    outbox = NativeReactionOutbox(defaults: defaults)
    outbox.set("track", 0)
    try await NativeLibraryReactions.drain(next: { outbox.pending.first.map { ($0.key, $0.value) } }, send: { id, value in
        precondition(id == "track" && value == 0)
        // A failed remote sync does not undo the successful local SQLite write.
        try NativeLibraryReactions.validate(["ok": true, "value": value, "sync": ["status": "error"]], value: value)
    }, acknowledge: { outbox.acknowledge($0, $1) })
    precondition(NativeReactionOutbox(defaults: defaults).pending.isEmpty)

    let reactions = ["neutral": 0, "liked": 1, "disliked": -1]
    precondition(NativeLibraryReactions.toLike(["neutral", "neutral", "liked", "disliked", "unknown"], reaction: { reactions[$0] }) == ["neutral"])
    let escaped = try NativeLibraryReactions.path("id/with?query#%.")
    precondition(escaped == "/api/tracks/id%2Fwith%3Fquery%23%25%2E/reaction")
    reject { _ = try NativeLibraryReactions.path("") }
    reject { _ = try NativeLibraryReactions.path(String(repeating: "a", count: 513)) }
    let invalid: [[String: Any]] = [[:], ["ok": false, "value": 1], ["ok": 1, "value": 1], ["ok": true, "value": -1],
        ["ok": true, "value": true], ["ok": true, "value": 1.5]]
    for response in invalid {
        reject { try NativeLibraryReactions.validate(response, value: 1) }
    }
    print("Native reactions: durable outbox, rapid toggles, failure/retry, local ACK, bulk semantics and safe IDs passed")
}

try await checkReactions()
