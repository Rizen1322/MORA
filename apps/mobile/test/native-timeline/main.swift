import Foundation

// Native preparation inserts Swift Int values; bridge/JSON inserts NSNumber values.
let frames = 357 * 48000
for value: Any in [frames, Double(frames), NSNumber(value: frames)] {
    let duration = NativeMixTimeline.duration(["totalFrames": value], sampleRate: 48000)
    precondition(duration == 357, "Native prepared Int frames lost their duration: \(duration)")
}
print("Native timeline: Swift/bridge frame counts retain their duration")
