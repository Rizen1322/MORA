import Foundation

let base = URL(string: CommandLine.arguments[1])!
let root = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let group = DispatchGroup(); group.enter()
Task.detached {
    let client = NativeMediaHTTP(allowLoopback: true)
    defer { client.invalidate(); group.leave() }
    do {
        let first = root.appendingPathComponent("first.bin")
        try await client.download(base.appendingPathComponent("body"), to: first, ticket: NativePreparationTicket())
        let expected = Data((0..<1024).map { UInt8($0 % 256) })
        let actual = try Data(contentsOf: first)
        precondition(actual == expected)
        let redirect = try await client.data(base.appendingPathComponent("redirect"), headers: ["Authorization": "Bearer fixture"], ticket: NativePreparationTicket())
        precondition(redirect == expected)
        do { _ = try await client.data(base.appendingPathComponent("missing"), ticket: NativePreparationTicket()); fatalError("HTTP status ignored") }
        catch NativeMediaHTTP.Failure.http(404) {}
        do { _ = try await client.data(base.appendingPathComponent("body"), limit: 10, ticket: NativePreparationTicket()); fatalError("Limit ignored") }
        catch NativeMediaHTTP.Failure.tooLarge {}
        do { _ = try await client.data(base.appendingPathComponent("chunked"), limit: 10, ticket: NativePreparationTicket()); fatalError("Streaming limit ignored") }
        catch NativeMediaHTTP.Failure.tooLarge {}
        let ticket = NativePreparationTicket(); ticket.cancel()
        do { _ = try await client.data(base.appendingPathComponent("body"), ticket: ticket); fatalError("Cancellation ignored") }
        catch NativeMediaHTTP.Failure.cancelled {}
        let files = try FileManager.default.contentsOfDirectory(atPath: root.path)
        precondition(files == ["first.bin"])
        print("Native HTTP: file bytes, HTTP status, transfer limit, cancelled job and cross-host auth stripping passed")
    } catch { fatalError("Native HTTP test failed: \(error)") }
}
group.wait()
