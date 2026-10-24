import Foundation

enum NativeMixTimeline {
    static func duration(_ track: [String: Any], sampleRate: Double) -> Double {
        guard let frames = (track["totalFrames"] as? NSNumber)?.doubleValue,
              frames.isFinite, frames > 0, sampleRate.isFinite, sampleRate > 0 else { return 0 }
        return frames / sampleRate
    }
}
