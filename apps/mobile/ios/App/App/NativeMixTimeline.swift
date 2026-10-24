import Foundation

enum NativeMixTimeline {
    static func duration(_ track: [String: Any], sampleRate: Double) -> Double {
        (track["totalFrames"] as? Double ?? 0) / sampleRate
    }
}
