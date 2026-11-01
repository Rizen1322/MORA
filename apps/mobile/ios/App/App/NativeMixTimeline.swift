import Foundation

enum NativeMixTimeline {
    static func preservingTail(_ incoming: [String: Any], after old: [String: Any]?, currentEntryId: String? = nil) -> [String: Any] {
        guard incoming["replaceFuture"] as? Bool != true, let old,
              let start = incoming["from"] as? Int, let oldStart = old["from"] as? Int, start >= oldStart,
              let items = incoming["items"] as? [[String: Any]], let previous = old["items"] as? [[String: Any]] else { return incoming }
        func same(_ a: [String: Any], _ b: [String: Any]) -> Bool {
            a["entryId"] as? String != nil && a["entryId"] as? String == b["entryId"] as? String
                && a["trackId"] as? String == b["trackId"] as? String
        }
        let offset: Int
        // Failed sources consume manifest entries but never consume native track indices.
        if let first = items.first, let match = previous.firstIndex(where: { same(first, $0) }) {
            offset = match
        } else if let currentEntryId {
            if let match = previous.firstIndex(where: { $0["entryId"] as? String == currentEntryId }) { offset = match + 1 }
            else if start == oldStart { offset = 0 }
            else { return incoming }
        } else { offset = start - oldStart }
        guard offset <= previous.count else { return incoming }
        // Only replaceFuture truncates: a restored/partial page list keeps every native entry it does not name.
        let named = Set(items.compactMap { $0["entryId"] as? String })
        let kept = previous.dropFirst(offset).filter { ($0["entryId"] as? String).map { !named.contains($0) } ?? false }
        guard !kept.isEmpty else { return incoming }
        var result = incoming; result["items"] = items + kept; return result
    }

    static func consumedPrefix(_ items: [[String: Any]], currentEntryId: String?, requestedFrom: Int, currentIndex: Int) -> Int? {
        if let currentEntryId, let consumed = items.firstIndex(where: { $0["entryId"] as? String == currentEntryId }) { return consumed + 1 }
        return requestedFrom <= currentIndex ? nil : 0
    }

    /// Duration-only equal-power reserve; never waits for JavaScriptCore/MIR.
    static func reserve(before: [String: Any], next: [String: Any], frames: Int, settings: [String: Any]) -> [String: Any]? {
        guard settings["enabled"] as? Bool != false, before["mixingAllowed"] as? Bool == true,
              next["mixingAllowed"] as? Bool == true, let a = before["duration"] as? Double, a.isFinite, a > 0, frames > 0 else { return nil }
        func limit(_ name: String, _ fallback: Double, _ maximum: Double) -> Double {
            guard let v = (settings[name] as? NSNumber)?.doubleValue, v.isFinite else { return fallback }
            return max(0, min(maximum, v))
        }
        let b = Double(frames) / 48000
        let length = min(limit("fallbackSeconds", 6, 20), limit("maxBlendSeconds", 32, 60), a * 0.15, b * 0.35)
        guard length >= 0.03 else { return nil }
        func rounded(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
        let start = rounded(max(0, a - length)), duration = rounded(length), swap = rounded(length / 2)
        let id = "native-reserve-\(UUID().uuidString)"
        let lanes: [[String: Any]] = ["A", "B"].map { deck in
            ["deck": deck, "lane": "gain", "points": (0...8).map { i -> [Double] in
                let t = Double(i) / 8
                return [length * t, deck == "A" ? cos(t * .pi / 2) : sin(t * .pi / 2)]
            }]
        }
        let plan: [String: Any] = ["id": id, "version": "native-reserve-1", "fromTrackId": before["trackId"] ?? "",
            "toTrackId": next["trackId"] ?? "", "method": "fallback_crossfade", "confidence": 0.3,
            "reasons": ["Резервный кроссфейд: полный анализ ещё не готов"], "fallbackReason": "analysis_pending",
            "aExit": start, "bEntry": 0.0, "duration": duration, "gap": 0.0, "swapAt": swap,
            "tempoB": [[0.0, 1.0]], "automation": lanes, "gainA": 0.0, "gainB": 0.0, "debug": ["processingAllowed": true]]
        let transition: [String: Any] = ["planId": id, "method": "fallback_crossfade", "fromToken": "A", "toToken": "B",
            "triggerFrame": (start * 48000).rounded(), "entryFrame": 0.0, "durationFrames": (duration * 48000).rounded(),
            "swapFrame": (swap * 48000).rounded(), "gapFrames": 0.0, "tempoB": [[0.0, 1.0]],
            "lanes": lanes.map { lane -> [String: Any] in
                ["deck": lane["deck"]!, "lane": 0, "points": (lane["points"] as! [[Double]]).map { [($0[0] * 48000).rounded(), $0[1]] }]
            }]
        return ["plan": plan, "transition": transition]
    }

    /// iOS advances Now Playing elapsed time by the published rate; true while that
    /// extrapolation is still within 0.5 s of the audible position.
    static func nowPlayingCurrent(sentPosition: Double, sentAt: Double, rate: Double, position: Double, now: Double) -> Bool {
        abs(sentPosition + (now - sentAt) * rate - position) < 0.5
    }

    /// Remote sources are downloaded in full before decoding, so quick skips need more of them ready.
    /// Storage stays bounded: prune() keeps only the previous track onward: depth + 2 files, plus pending skips.
    static func aheadDepth(_ source: [String: Any]?) -> Int {
        ["local", "upload"].contains(source?["kind"] as? String ?? "") ? 2 : 4
    }

    /// Lock-screen Next presses while the target song is still preparing: each moves it one further,
    /// bounded by the songs that can still arrive and by storage (skipped songs stay on disk until the target plays).
    static let maxPendingSkips = 8
    static func pendingSkips(_ current: Int, ahead: Int, remaining: Int) -> Int {
        max(current, min(current + 1, maxPendingSkips, max(0, ahead) + max(0, remaining)))
    }

    static func duration(_ track: [String: Any], sampleRate: Double) -> Double {
        guard let frames = (track["totalFrames"] as? NSNumber)?.doubleValue,
              frames.isFinite, frames > 0, sampleRate.isFinite, sampleRate > 0 else { return 0 }
        return frames / sampleRate
    }
}
