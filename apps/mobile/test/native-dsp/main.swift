import Foundation

// Repeats test/native-dsp/fixture.ts step by step with the Swift mixer (NativeDSPRenderer.swift).
// JSON keys are written in the reference's order: the comparator checks them.
guard CommandLine.arguments.count == 2 else { fatalError("Expected the output path") }
var json = "["
var firstCase = true
for sr in [44100.0, 48000.0] {
    for kind in ["transport", "transition", "effects", "tape"] {
        let m = MixerCore(sr)
        var events: [String] = []
        m.emit = { events.append($0.fields["type"] as! String) }
        var pcm: [Float] = []
        var phases: [String] = []
        func source(_ deck: Int, _ token: String, _ seed: UInt32) {
            let count = Int(sr) * 6
            var left = [Float](repeating: 0, count: count), right = [Float](repeating: 0, count: count)
            var state = seed
            for i in 0..<count {
                state = state &* 1664525 &+ 1013904223
                let noise = (Double(state) / 4294967296 - 0.5) * 0.03
                left[i] = Float((i > 0 ? Double(left[i - 1]) * 0.98 : 0) + noise + (Double(i % 233) / 233 - 0.5) * 0.012)
                right[i] = Float((i > 0 ? Double(right[i - 1]) * 0.97 : 0) - noise + (Double(i % 317) / 317 - 0.5) * 0.015)
            }
            m.load(deck, token, ArraySource(left, right), 0)
        }
        let L = FBuf(128, 0), R = FBuf(128, 0)
        func render(_ seconds: Double, _ name: String) {
            for _ in 0..<Int((seconds * sr / 128).rounded(.up)) {
                m.process(L, R, 128)
                for i in 0..<128 { pcm.append(L[i]); pcm.append(R[i]) }
            }
            phases.append("{\"name\":\"\(name)\",\"paused\":\(m.paused),\"main\":\(m.main),\"clock\":\(m.clock)}")
        }
        source(0, "A", 123)
        m.start(0, "A", 0)
        if kind == "transport" {
            render(0.25, "playing")
            m.setPaused(true)
            render(0.12, "paused")
            m.seek("A", jsRound(1.25 * sr))
            render(0.06, "seekPaused")
            m.setPaused(false)
            render(0.25, "resumed")
            m.setPlayback(PlaybackSettings(speed: 1.08, semitones: 1))
            render(0.25, "speedPitch")
            m.stopAll()
            render(0.06, "stopped")
        } else if kind == "effects" || kind == "tape" {
            source(1, "B", 456)
            m.setTone(ToneSettings(["enabled": true, "gains": [3.0, 2, 0, -1, 0, 1.5, 2, -2, 1, 0], "preampDb": -1.0,
                                    "autoHeadroom": true, "balance": 0.2, "mono": false, "reverbMix": 0.2]), nil)
            let duration = jsRound(1.5 * sr)
            var raw: [String: Any] = [
                "planId": "native-\(kind)", "method": kind == "tape" ? "tape_stop" : "loop_out", "fromToken": "A", "toToken": "B",
                "triggerFrame": jsRound(0.6 * sr), "entryFrame": jsRound(0.3 * sr), "durationFrames": duration, "gapFrames": 0.0,
                "swapFrame": jsRound(duration / 2), "bDelayFrames": jsRound(0.1 * sr),
                "tempoB": [[0.0, 0.985], [duration, 1.0]], "tempoA": [[0.0, 1.0], [duration, 1.01]],
                "lanes": [
                    ["deck": "A", "lane": 0, "points": [[0.0, 1.0], [duration * 0.8, 0.0]]],
                    ["deck": "B", "lane": 0, "points": [[0.0, 0.0], [duration, 1.0]]],
                    ["deck": "A", "lane": 3, "points": [[0.0, 1.0], [duration / 2, 0.3]]],
                    ["deck": "B", "lane": 2, "points": [[0.0, 0.5], [duration, 1.0]]],
                    ["deck": "A", "lane": 6, "points": [[0.0, 0.0], [duration, -0.6]]],
                ],
            ]
            if kind == "tape" {
                raw["tapeStopA"] = ["start": jsRoundInt(0.9 * sr), "end": jsRoundInt(1.5 * sr), "fade": jsRoundInt(0.05 * sr)]
            } else {
                raw["loopA"] = ["start": jsRoundInt(0.5 * sr), "end": Int(sr), "until": jsRoundInt(1.5 * sr), "fade": jsRoundInt(0.005 * sr)]
            }
            guard let plan = ArmedTransition(raw) else { fatalError("Invalid \(kind) plan") }
            m.arm(plan)
            render(2.3, "afterTransition")
            m.setPlayback(PlaybackSettings(speed: 0.92, semitones: -2))
            render(0.3, "slower")
        } else {
            source(1, "B", 456)
            let duration = jsRound(1.2 * sr)
            guard let plan = ArmedTransition([
                "planId": "native-parity", "method": "beatmatch_blend", "fromToken": "A", "toToken": "B",
                "triggerFrame": jsRound(0.25 * sr), "entryFrame": jsRound(0.4 * sr),
                "durationFrames": duration, "gapFrames": 0.0, "swapFrame": jsRound(duration / 2),
                "tempoB": [[0.0, 1.016], [duration, 1.0]],
                "echoDelayFrames": jsRound(sr * 0.125), "echoFeedback": 0.25,
                "lanes": [
                    ["deck": "A", "lane": 0, "points": [[0.0, 1.0], [duration, 0.0]]],
                    ["deck": "B", "lane": 0, "points": [[0.0, 0.0], [duration, 1.0]]],
                    ["deck": "A", "lane": 1, "points": [[0.0, 1.0], [duration / 2, 0.2]]],
                    ["deck": "B", "lane": 1, "points": [[0.0, 0.2], [duration, 1.0]]],
                    ["deck": "A", "lane": 4, "points": [[0.0, 0.0], [duration / 2, 0.3], [duration, 0.0]]],
                    ["deck": "B", "lane": 6, "points": [[0.0, 0.3], [duration, 0.0]]],
                ],
            ]) else { fatalError("Invalid transition plan") }
            m.arm(plan)
            render(1.9, "afterTransition")
        }
        if !firstCase { json += "," }
        firstCase = false
        json += "{\"sr\":\(Int(sr)),\"kind\":\"\(kind)\",\"pcm\":["
        json += pcm.map { "\(Double($0))" }.joined(separator: ",")
        json += "],\"phases\":[" + phases.joined(separator: ",") + "],\"events\":["
        json += events.map { "\"\($0)\"" }.joined(separator: ",") + "]}"
    }
}
json += "]"
try json.write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)
print("Swift mixer rendered the MixerCore parity fixtures")
