import Foundation

actor PreparedQueueCheck {
    private var key = 700000
    private var entries: [String] = []
    func allocate() -> Int { key += 1; return key }
    func accept(_ index: Int, _ track: [String: Any]) -> Bool {
        precondition(index == entries.count + 1)
        precondition(track["totalFrames"] as? Int == 24000)
        precondition(track["gainDb"] as? Double != nil)
        entries.append(track["entryId"] as! String); return true
    }
    func result() -> [String] { entries }
}
actor ArtworkCheck {
    private var files: Set<Int> = []
    func accept(_ file: Int) { files.insert(file) }
    func result() -> Set<Int> { files }
}

let base = URL(string: CommandLine.arguments[1])!
let root = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let group = DispatchGroup(); group.enter()
Task.detached {
    let client = NativeMediaHTTP(allowLoopback: true)
    defer { client.invalidate(); group.leave() }
    do {
        let pendingStart = NativeQueuePreparation(index: 0, remaining: 6)
        precondition(pendingStart.hasRemaining) // Before run()/JavaScriptCore is scheduled.
        let pendingRepeat = NativeQueuePreparation(index: 0, loopCount: 1)
        precondition(pendingRepeat.hasRemaining) // Repeat-one has no initial raw items.
        pendingRepeat.cancel(); precondition(!pendingRepeat.hasRemaining)
        let loader = NativeMediaLoader(http: client, allowLoopback: true)
        let xml = "<download-info><host>edge.storage.yandex.net</host><path>/test/audio.mp3</path><ts>1a</ts><s>salt123</s></download-info>"
        let signed = try loader.yandexXML(xml, base: URL(string: "https://api.music.yandex.net")!)
        precondition(signed.absoluteString == CommandLine.arguments[3])
        do { _ = try loader.yandexXML("<!DOCTYPE unsafe>" + xml, base: base); fatalError("DTD accepted") }
        catch NativeMediaLoader.Failure.source {}
        let packed = Data([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 7, 8, 1, 2, 3])
        let stripped = try NativeMediaLoader.packedAudio(packed)
        precondition(stripped == Data([1, 2, 3]))
        let hlsFile = root.appendingPathComponent("hls.aac")
        _ = try await loader.load(["kind": "hls", "url": base.appendingPathComponent("list.m3u8").absoluteString, "headers": ["X-Mora-Test": "required"]],
            to: hlsFile, folder: root, ticket: NativePreparationTicket())
        let hls = try Data(contentsOf: hlsFile)
        precondition(hls == Data([1, 2, 3, 4, 5, 6]))
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
        precondition(Set(files) == Set(["first.bin", "hls.aac"]))
        let folder = root.appendingPathComponent("queue")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let firstPCM = [Float](repeating: 0.1, count: 24000 * 2).withUnsafeBytes { Data($0) }
        try firstPCM.write(to: folder.appendingPathComponent("0.f32le"))
        let source: [String: Any] = ["kind": "direct", "url": base.appendingPathComponent("wave").absoluteString, "allowHTTP": true]
        let item: (String) -> [String: Any] = { id in ["file": 1, "entryId": id, "trackId": id, "title": id,
            "artist": "", "duration": 0.5, "mixingAllowed": false, "source": source] }
        let job = NativeQueuePreparation(index: 0), sink = PreparedQueueCheck()
        let script = try String(contentsOf: root.deletingLastPathComponent().appendingPathComponent("preparation.js"), encoding: .utf8)
        let core = try NativePreparationCore(script: script)
        let profile = try core.analyze(root.deletingLastPathComponent().appendingPathComponent("analysis-input.f32le"), frames: 44100 * 4, ticket: NativePreparationTicket())
        try JSONSerialization.data(withJSONObject: profile).write(to: root.deletingLastPathComponent().appendingPathComponent("analysis-actual.json"))
        await job.run(folder: folder, manifest: ["from": 1, "items": [item("B"), item("C")],
            "loopItems": [item("A"), item("B"), item("C")], "settings": ["enabled": false],
            "previous": ["trackId": "A", "duration": 0.5, "mixingAllowed": false]],
            seed: ["file": 0, "totalFrames": 24000], script: script,
            allocate: { await sink.allocate() }, accept: { index, track in
                let accepted = await sink.accept(index, track)
                if index == 8 { job.cancel() } else { job.gate.advance(index) } // Native audible advancement simulation.
                return accepted
            }, event: { _, _ in })
        let entries = await sink.result()
        precondition(entries == ["B", "C", "A", "B", "C", "A", "B", "C"])
        let preparedFiles = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        precondition(preparedFiles.filter { $0.hasSuffix(".f32le") }.count == 9)
        precondition(!preparedFiles.contains { $0.hasSuffix(".download") || $0.hasSuffix(".partial") || $0.hasSuffix(".analysis") })
        // MIR/planner failure must not turn decodable songs into a three-track stop.
        let fallbackFolder = root.appendingPathComponent("fallback")
        try FileManager.default.createDirectory(at: fallbackFolder, withIntermediateDirectories: true)
        try firstPCM.write(to: fallbackFolder.appendingPathComponent("0.f32le"))
        let fallback = NativeQueuePreparation(index: 0), fallbackSink = PreparedQueueCheck()
        let badScript = "var MoraPreparation = { analyzeJSON: function() { throw Error('fixture'); }, planJSON: function() { throw Error('fixture'); } };"
        let fallbackItems = ["B", "C", "D", "E", "F", "G", "H"].map { id -> [String: Any] in
            var value = item(id); value["mixingAllowed"] = true; return value
        }
        await fallback.run(folder: fallbackFolder, manifest: ["from": 1, "items": fallbackItems, "settings": ["enabled": true],
            "previous": ["trackId": "A", "duration": 0.5, "mixingAllowed": true]],
            seed: ["file": 0, "totalFrames": 24000], script: badScript,
            allocate: { await fallbackSink.allocate() }, accept: { index, track in
                let accepted = await fallbackSink.accept(index, track)
                precondition(track["transition"] == nil)
                fallback.gate.advance(index); return accepted
            }, event: { _, _ in })
        let fallbackEntries = await fallbackSink.result()
        precondition(fallbackEntries == ["B", "C", "D", "E", "F", "G", "H"])
        precondition(fallback.snapshot["running"] as? Bool == false)
        let coverFolder = root.appendingPathComponent("cover")
        try FileManager.default.createDirectory(at: coverFolder, withIntermediateDirectories: true)
        try firstPCM.write(to: coverFolder.appendingPathComponent("0.f32le"))
        let coverJob = NativeQueuePreparation(index: 0), coverSink = PreparedQueueCheck()
        var covered = item("B"); covered["coverUrl"] = base.appendingPathComponent("slow-cover").absoluteString
        await coverJob.run(folder: coverFolder, manifest: ["from": 1, "items": [covered], "settings": ["enabled": false],
            "previous": ["trackId": "A", "duration": 0.5, "mixingAllowed": false]],
            seed: ["file": 0, "totalFrames": 24000], script: script,
            allocate: { await coverSink.allocate() }, accept: { index, track in
                let accepted = await coverSink.accept(index, track)
                let acknowledgement = try! await client.data(base.appendingPathComponent("cover-accepted"), ticket: NativePreparationTicket())
                precondition(String(data: acknowledgement, encoding: .utf8) == "before-cover", "Optional cover blocked ready PCM")
                return accepted
            }, event: { _, _ in })
        coverJob.cancel()
        let images = NativeQueueArtwork(), imageSink = ArtworkCheck()
        for file in 1...5 {
            images.load(base.appendingPathComponent("cover-window"), hosts: [base.host!], index: file, file: file) { _, file, data in
                precondition(String(data: data, encoding: .utf8) == "cover")
                Task { await imageSink.accept(file) }
            }
        }
        for _ in 0..<100 {
            if await imageSink.result().count == 5 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let imageFiles = await imageSink.result()
        precondition(imageFiles == Set(1...5), "Deferred current/future covers were dropped")
        images.cancel()
        print("Native preparation: delayed optional artwork does not hold ready PCM")
        print("Native queue: failed MIR/planner preserve seven playable future songs")
        print("Native queue: eight preparations, repeat cycles and playback permits passed without WebContent")
        print("Native HTTP: file bytes, HTTP status, transfer limit, cancelled job and cross-host auth stripping passed")
    } catch { fatalError("Native HTTP test failed: \(error)") }
}
group.wait()
