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
actor UpgradeCheck {
    private var gain: Double?
    func accept(_ track: [String: Any]) { gain = (track["gainDb"] as? NSNumber)?.doubleValue }
    func result() -> Double? { gain }
}

func stage(_ message: String) {
    // stderr remains visible in CI even when an optimized precondition traps before stdout flushes.
    FileHandle.standardError.write(Data(("Native HTTP check: \(message)\n").utf8))
}

func checkSharedFiles(in folder: URL) throws {
    let root = folder.appendingPathComponent("shared-file-check-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sharedRoot = root.appendingPathComponent("server", isDirectory: true)
    let sharedData = sharedRoot.appendingPathComponent("data", isDirectory: true)
    try FileManager.default.createDirectory(at: sharedData, withIntermediateDirectories: true)
    let sharedAudio = sharedData.appendingPathComponent("song.mp3")
    try Data([1, 2, 3]).write(to: sharedAudio)
    let sharedFile = NativeMediaLoader.sharedFile("/data/song.mp3", root: sharedRoot)
    precondition(sharedFile == sharedAudio.resolvingSymlinksInPath())
    let sharedBytes = try Data(contentsOf: sharedFile!)
    precondition(sharedBytes == Data([1, 2, 3]))
    for path in ["/data/missing.mp3", "/data/../outside.mp3", "/data/./song.mp3", "/data", "/data/", "/elsewhere/song.mp3", "/data/song.mp3\0"] {
        precondition(NativeMediaLoader.sharedFile(path, root: sharedRoot) == nil)
    }
    let outside = root.appendingPathComponent("outside.mp3")
    try Data([9]).write(to: outside)
    try FileManager.default.createSymbolicLink(at: sharedData.appendingPathComponent("escape.mp3"), withDestinationURL: outside)
    precondition(NativeMediaLoader.sharedFile("/data/escape.mp3", root: sharedRoot) == nil)
    try FileManager.default.createSymbolicLink(at: sharedData.appendingPathComponent("escape"), withDestinationURL: root)
    precondition(NativeMediaLoader.sharedFile("/data/escape/outside.mp3", root: sharedRoot) == nil)
    try FileManager.default.createSymbolicLink(at: sharedData.appendingPathComponent("alias.mp3"), withDestinationURL: sharedAudio)
    precondition(NativeMediaLoader.sharedFile("/data/alias.mp3", root: sharedRoot) == sharedAudio.resolvingSymlinksInPath())
}

let base = URL(string: CommandLine.arguments[1])!
let root = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let group = DispatchGroup(); group.enter()
Task.detached {
    let client = NativeMediaHTTP(allowLoopback: true)
    defer { client.invalidate(); group.leave() }
    do {
        stage("shared file paths")
        try checkSharedFiles(in: root)
        stage("HTTP transport")
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
        stage("HTTP temporary file cleanup")
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
        let decimatorReference = try String(contentsOf: root.deletingLastPathComponent().appendingPathComponent("decimator-reference.js"), encoding: .utf8)
        let fftCore = try NativePreparationCore(script: decimatorReference + "\n" + """
        var MoraPreparation = {analyzeJSON: function() {
            try {
            for (var n of [2, 8, 2048, 4096]) {
                var storage = new Float64Array(n + 2); storage[0] = 123; storage[n + 1] = 456;
                var re = storage.subarray(1, n + 1), im = new Float64Array(n);
                for (var i = 0; i < n; i++) { re[i] = Math.sin(i * .31); im[i] = Math.cos(i * .17); }
                var a = re.slice(), b = im.slice();
                if (!moraPreparationFFT(re, im)) throw Error('native FFT missing');
                if (storage[0] !== 123 || storage[n + 1] !== 456) throw Error('FFT wrote outside view');
                for (var k = 0; k < Math.min(8, n); k++) {
                    var r = 0, m = 0;
                    for (var j = 0; j < n; j++) { var t = -2 * Math.PI * j * k / n; r += a[j]*Math.cos(t)-b[j]*Math.sin(t); m += a[j]*Math.sin(t)+b[j]*Math.cos(t); }
                    if (Math.abs(r-re[k]) > 1e-8 || Math.abs(m-im[k]) > 1e-8) throw Error('FFT mismatch');
                }
            }
            if (moraPreparationFFT(new Float64Array(3), new Float64Array(3))) throw Error('invalid FFT accepted');
            if (moraPreparationFFT(new Float32Array(8), new Float64Array(8))) throw Error('invalid type accepted');
            if (moraPreparationFFT(new Float64Array(8), new Float64Array(2))) throw Error('mismatched lengths accepted');
            var reference = new MoraDecimatorReference.Decimator2(), historyStorage = new Float64Array(64), coefficientStorage = new Float64Array(33);
            historyStorage[0] = 123; historyStorage[63] = 456; coefficientStorage[0] = 789; coefficientStorage[32] = 987;
            var history = historyStorage.subarray(1, 63), coefficients = coefficientStorage.subarray(1, 32), pos = 0, phase = 0, offset = 0;
            coefficients.set(reference.h);
            for (var length of [0, 1, 2, 7, 31, 4, 127, 65536, 1]) {
                var backing = new Float32Array(length + 2);
                for (var i = 0; i < backing.length; i++) backing[i] = Math.sin((offset + i) * .19);
                var input = backing.subarray(1, length + 1), expected = [];
                reference.push(input, length, function(value) { expected.push(value); });
                var result = moraPreparationDecimate(input, length, coefficients, history, pos, phase);
                if (!result || !(result.output instanceof Float64Array) || result.output.length !== expected.length) throw Error('decimator output');
                for (var i = 0; i < expected.length; i++) if (Math.abs(expected[i] - result.output[i]) > 1e-14) throw Error('decimator parity');
                if (result.pos !== reference.pos || result.phase !== reference.phase) throw Error('decimator state');
                if (historyStorage[0] !== 123 || historyStorage[63] !== 456 || coefficientStorage[0] !== 789 || coefficientStorage[32] !== 987) throw Error('decimator wrote outside view');
                for (var i = 0; i < 31; i++) if (history[i] !== reference.buf[i] || history[i + 31] !== reference.buf[i]) throw Error('decimator history');
                pos = result.pos; phase = result.phase; offset += length;
            }
            var snapshot = history.slice();
            for (var invalid of [
                [new Float64Array(2), 2, reference.h, history, pos, phase],
                [new Float32Array(2), 3, reference.h, history, pos, phase],
                [new Float32Array([NaN]), 1, reference.h, history, pos, phase],
                [new Float32Array(2), 2, reference.h, history, 31, phase],
                [new Float32Array(2), 2, reference.h, history, pos, 2]
            ]) {
                if (moraPreparationDecimate.apply(null, invalid)) throw Error('invalid decimator accepted');
                for (var i = 0; i < history.length; i++) if (history[i] !== snapshot[i]) throw Error('invalid decimator mutated history');
            }
            return '{"passed":true}';
            } catch (error) { return JSON.stringify({error: String(error)}); }
        }};
        """)
        let fftCheck = try fftCore.analyze(root.deletingLastPathComponent().appendingPathComponent("analysis-input.f32le"), frames: 1, ticket: NativePreparationTicket())
        precondition(fftCheck["passed"] as? Bool == true, "Synthetic DSP fixture: \(fftCheck["error"] as? String ?? "missing result")")
        print("Native FFT and decimator: complex DFT, irregular blocks, Double output, history and invalid-input checks passed")
        let analysisFrames = CommandLine.arguments.count > 4 ? Int(CommandLine.arguments[4])! : 44100 * 4
        precondition(analysisFrames > 0 && analysisFrames <= 44100 * 180)
        let analysisStarted = ProcessInfo.processInfo.systemUptime
        var stage = "starting", stageStarted = analysisStarted
        let profile = try core.analyze(root.deletingLastPathComponent().appendingPathComponent("analysis-input.f32le"), frames: analysisFrames, ticket: NativePreparationTicket(), progress: { next in
            guard next != stage else { return }
            let now = ProcessInfo.processInfo.systemUptime
            print("Native MIR stage \(stage): \(Int((now - stageStarted) * 1000))ms")
            stage = next; stageStarted = now
        })
        let analysisEnded = ProcessInfo.processInfo.systemUptime
        print("Native MIR stage \(stage): \(Int((analysisEnded - stageStarted) * 1000))ms")
        print("Native MIR total: \(analysisFrames / 44100)s audio, \(Int((analysisEnded - analysisStarted) * 1000))ms wall time (macOS test host)")
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
                precondition((track["transition"] as? [String: Any])?["method"] as? String == "fallback_crossfade", "MIR failure removed the ready reserve")
                fallback.gate.advance(index); return accepted
            }, event: { _, _ in })
        let fallbackEntries = await fallbackSink.result()
        precondition(fallbackEntries == ["B", "C", "D", "E", "F", "G", "H"])
        precondition(fallback.snapshot["running"] as? Bool == false)
        // Turning off overlap must retain loudness normalization. Supplied full
        // analysis avoids conflating this check with the speed of the analyzer.
        let gainFolder = root.appendingPathComponent("gain")
        try FileManager.default.createDirectory(at: gainFolder, withIntermediateDirectories: true)
        try firstPCM.write(to: gainFolder.appendingPathComponent("0.f32le"))
        var known = profile
        known["loudness"] = ["integratedLufs": -24.0, "truePeakDb": -8.0]
        var gainItem = item("B"); gainItem["mixingAllowed"] = true; gainItem["analysis"] = known
        let gainJob = NativeQueuePreparation(index: 0), gainSink = PreparedQueueCheck(), upgradedGain = UpgradeCheck()
        await gainJob.run(folder: gainFolder, manifest: ["from": 1, "items": [gainItem],
            "settings": ["enabled": false, "loudnessTarget": -16.0],
            "previous": ["trackId": "A", "mixingAllowed": true, "analysis": known]],
            seed: ["file": 0, "totalFrames": 24000], script: script,
            allocate: { await gainSink.allocate() }, accept: { index, track in await gainSink.accept(index, track) },
            upgrade: { _, track in Task { await upgradedGain.accept(track) } }, event: { _, _ in })
        for _ in 0..<200 {
            if await upgradedGain.result() != nil { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let normalization = await upgradedGain.result()
        precondition(normalization == 8.0, "Disabling AutoMix removed loudness normalization")
        gainJob.cancel()
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
