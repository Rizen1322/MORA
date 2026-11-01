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
