import Foundation

// Native preparation inserts Swift Int values; bridge/JSON inserts NSNumber values.
let frames = 357 * 48000
for value in [frames as Any, Double(frames) as Any, NSNumber(value: frames) as Any] {
    let duration = NativeMixTimeline.duration(["totalFrames": value], sampleRate: 48000)
    precondition(duration == 357, "Native prepared Int frames lost their duration: \(duration)")
}
print("Native timeline: Swift/bridge frame counts retain their duration")

let previous: [String: Any] = ["trackId": "A", "duration": 180.0, "mixingAllowed": true]
let candidate: [String: Any] = ["trackId": "B", "mixingAllowed": true]
let reserve = NativeMixTimeline.reserve(before: previous, next: candidate, frames: 180 * 48000, settings: [:])!
let transition = reserve["transition"] as! [String: Any]
precondition(transition["triggerFrame"] as? Double == 174 * 48000)
precondition(transition["durationFrames"] as? Double == 6 * 48000)
let lanes = transition["lanes"] as! [[String: Any]]
let outgoing = lanes[0]["points"] as! [[Double]], incoming = lanes[1]["points"] as! [[Double]]
for i in outgoing.indices { precondition(abs(pow(outgoing[i][1], 2) + pow(incoming[i][1], 2) - 1) < 1e-12) }
precondition(NativeMixTimeline.reserve(before: previous, next: candidate, frames: 48000, settings: ["enabled": false]) == nil)
precondition(NativeMixTimeline.reserve(before: previous, next: candidate, frames: 48000, settings: ["fallbackSeconds": 0]) == nil)
precondition(NativeMixTimeline.reserve(before: previous, next: ["mixingAllowed": false], frames: 48000, settings: [:]) == nil)
precondition(NativeMixTimeline.reserve(before: ["duration": Double.nan, "mixingAllowed": true], next: candidate, frames: 48000, settings: [:]) == nil)
precondition(NativeMixTimeline.reserve(before: previous, next: candidate, frames: 1, settings: [:]) == nil)
print("Native reserve: timing, equal power, disabled/forbidden/invalid inputs passed")

let full: [[String: Any]] = (1...74).map { ["entryId": "E\($0)", "trackId": "T\($0)"] }
let original: [String: Any] = ["from": 1, "items": full]
var partial: [String: Any] = ["from": 2, "items": Array(full.dropFirst().prefix(2))]
let preserved = NativeMixTimeline.preservingTail(partial, after: original)["items"] as! [[String: Any]]
precondition(preserved.count == 73 && preserved.last?["entryId"] as? String == "E74")
partial["replaceFuture"] = true
precondition((NativeMixTimeline.preservingTail(partial, after: original)["items"] as! [[String: Any]]).count == 2)
partial["replaceFuture"] = false; partial["items"] = [["entryId": "other", "trackId": "other"]]
precondition((NativeMixTimeline.preservingTail(partial, after: original)["items"] as! [[String: Any]]).count == 74, "Unaligned page list dropped the native tail")
let restored: [String: Any] = ["from": 2, "items": [full[1], full[4], full[2]]]
let reordered = NativeMixTimeline.preservingTail(restored, after: original)["items"] as! [[String: Any]]
precondition(reordered.count == 73 && Set(reordered.map { $0["entryId"] as! String }).count == 73, "Stale restored order lost or duplicated entries")
print("Native manifest: 74-track tail survives partial, unaligned and reordered refreshes; explicit replacement respected")

// B failed decoding, so C is native index 1 even though it was manifest item 2.
let skippedItems: [[String: Any]] = ["B", "C", "D", "E", "F"].map { ["entryId": $0, "trackId": $0] }
let skippedOriginal: [String: Any] = ["from": 1, "items": skippedItems]
let skippedRefresh: [String: Any] = ["from": 2, "items": Array(skippedItems[2...3])]
let skippedTail = NativeMixTimeline.preservingTail(skippedRefresh, after: skippedOriginal, currentEntryId: "C")["items"] as! [[String: Any]]
precondition(skippedTail.map { $0["entryId"] as! String } == ["D", "E", "F"])
let emptyRefresh: [String: Any] = ["from": 2, "items": [[String: Any]]()]
let emptyTail = NativeMixTimeline.preservingTail(emptyRefresh, after: skippedOriginal, currentEntryId: "C")["items"] as! [[String: Any]]
precondition(emptyTail.map { $0["entryId"] as! String } == ["D", "E", "F"], "Empty refresh replayed the audible track after a failed source")
var explicitClear = emptyRefresh; explicitClear["replaceFuture"] = true
precondition((NativeMixTimeline.preservingTail(explicitClear, after: skippedOriginal, currentEntryId: "C")["items"] as! [[String: Any]]).isEmpty)
let beforeFirst: [String: Any] = ["from": 1, "items": [[String: Any]]()]
precondition((NativeMixTimeline.preservingTail(beforeFirst, after: skippedOriginal, currentEntryId: "A")["items"] as! [[String: Any]]).count == 5)
precondition((NativeMixTimeline.preservingTail(emptyRefresh, after: skippedOriginal, currentEntryId: "unknown")["items"] as! [[String: Any]]).isEmpty)
print("Native manifest: failed sources preserve identity-aligned tails without replaying the audible entry")

let stalePage: [String: Any] = ["from": 4, "items": Array(skippedItems.prefix(1))]
let staleMerged = NativeMixTimeline.preservingTail(stalePage, after: skippedOriginal, currentEntryId: "D")["items"] as! [[String: Any]]
let consumed = NativeMixTimeline.consumedPrefix(staleMerged, currentEntryId: "D", requestedFrom: 4, currentIndex: 3)!
precondition(staleMerged[consumed - 1]["entryId"] as? String == "D")
precondition(staleMerged.dropFirst(consumed).map { $0["entryId"] as! String } == ["E", "F"], "Fresh native index replayed stale page entries")
precondition(NativeMixTimeline.consumedPrefix([["entryId": "new"]], currentEntryId: "D", requestedFrom: 4, currentIndex: 3) == 0)
precondition(NativeMixTimeline.consumedPrefix([], currentEntryId: "D", requestedFrom: 4, currentIndex: 3) == 0) // Repeat-one lives in loopItems.
precondition(NativeMixTimeline.consumedPrefix([["entryId": "new"]], currentEntryId: "D", requestedFrom: 2, currentIndex: 3) == nil)
print("Native manifest: audible identity rebases stale page entries even with a fresh native index")

func nowPlayingPublishes(rate: Double, sourceRate: Double, seekAt: Double? = nil) -> Int {
    var sent = (position: 0.0, at: 0.0), count = 1, position = 0.0
    for tick in 1...120 {
        let now = Double(tick) * 0.5
        position += 0.5 * sourceRate
        if let seekAt, now == seekAt { position = 100 }
        if !NativeMixTimeline.nowPlayingCurrent(sentPosition: sent.position, sentAt: sent.at, rate: rate, position: position, now: now) {
            sent = (position, now); count += 1
        }
    }
    return count
}
precondition(nowPlayingPublishes(rate: 1, sourceRate: 1) == 1, "Steady playback republished Now Playing")
precondition(nowPlayingPublishes(rate: 1.25, sourceRate: 1.25) == 1, "DSP speed is not extrapolated")
precondition((2...6).contains(nowPlayingPublishes(rate: 1, sourceRate: 1.03)), "Tempo stretch drift is not corrected")
precondition(nowPlayingPublishes(rate: 1, sourceRate: 1, seekAt: 20) == 2, "A jump was not republished")
precondition(nowPlayingPublishes(rate: 1, sourceRate: 0) == 121, "A stalled clock was not corrected")
print("Native Now Playing: one publish for a steady minute, bounded drift corrections, jumps and stalls republished")

precondition(NativeMixTimeline.aheadDepth(["kind": "local", "file": 1]) == 2)
precondition(NativeMixTimeline.aheadDepth(["kind": "upload"]) == 2)
precondition(NativeMixTimeline.aheadDepth(["kind": "direct", "url": "https://example.com/a"]) == 4)
precondition(NativeMixTimeline.aheadDepth(["kind": "hls"]) == 4 && NativeMixTimeline.aheadDepth(nil) == 4)
print("Native preparation depth: two ahead for local files, four for downloads")

precondition(NativeMixTimeline.pendingSkips(0, ahead: 0, remaining: 5) == 1)
precondition(NativeMixTimeline.pendingSkips(1, ahead: 0, remaining: 5) == 2)
precondition(NativeMixTimeline.pendingSkips(2, ahead: 1, remaining: 1) == 2, "Skip target passed the end of the queue")
precondition(NativeMixTimeline.pendingSkips(0, ahead: 0, remaining: 0) == 0, "Next accepted with nothing left")
precondition(NativeMixTimeline.pendingSkips(NativeMixTimeline.maxPendingSkips, ahead: 0, remaining: 50) == NativeMixTimeline.maxPendingSkips)
var presses = 0
for _ in 0..<5 { presses = NativeMixTimeline.pendingSkips(presses, ahead: 0, remaining: 3) }
precondition(presses == 3, "Five quick presses over three remaining songs: \(presses)")
print("Native skips: each press moves the target, bounded by remaining songs and storage")

precondition((0..<5).map { NativeMixTimeline.retryDelay("network_-1001", attempt: $0) } == [2, 5, 15, 30, 30], "Offline songs must be retried, not skipped")
precondition(NativeMixTimeline.retryDelay("http_503", attempt: 3) == nil)
precondition(NativeMixTimeline.retryDelay("http_503", attempt: 0) == 2)
for reason in ["http_404", "http_403", "http_0", "decode_-11829", "preparation", "encrypted", "size_limit", "commit"] {
    precondition(NativeMixTimeline.retryDelay(reason, attempt: 0) == nil, "\(reason) was retried")
}
print("Native retry: network and server errors back off 2/5/15 s, unavailable sources are skipped")
