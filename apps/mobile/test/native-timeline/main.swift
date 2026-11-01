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
