import Foundation

// packages/audio-rust/src/ffi.rs, linked as libmora_audio.a (apps/mobile/scripts/build-rust-ios.sh).
@_silgen_name("mora_analyzer_version")
private func moraAnalyzerVersion() -> UnsafePointer<CChar>
@_silgen_name("mora_analyze_f32le")
private func moraAnalyze(_ path: UnsafePointer<CChar>, _ frames: UInt64,
                         _ cancelled: (@convention(c) (UnsafeMutableRawPointer?) -> Bool)?, _ context: UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>?
@_silgen_name("mora_free_string")
private func moraFreeString(_ value: UnsafeMutablePointer<CChar>?)
@_silgen_name("mora_analysis_begin")
private func moraAnalysisBegin(_ expectedFrames: UInt64) -> OpaquePointer?
@_silgen_name("mora_analysis_push")
private func moraAnalysisPush(_ accumulator: OpaquePointer, _ interleaved: UnsafePointer<Float>, _ frames: Int) -> Bool
@_silgen_name("mora_analysis_finish")
private func moraAnalysisFinish(_ accumulator: OpaquePointer, _ cancel: Bool) -> UnsafeMutablePointer<CChar>?

private func moraJSON(_ raw: UnsafeMutablePointer<CChar>?) -> [String: Any]? {
    guard let raw else { return nil }
    defer { moraFreeString(raw) }
    return (try? JSONSerialization.jsonObject(with: Data(bytes: raw, count: strlen(raw)))) as? [String: Any]
}

/// Compiled MIR with the bundled script's output: JavaScriptCore has no JIT in apps,
/// so the script analyzer needs minutes per track on an iPhone.
enum NativeRustAnalysis {
    private final class Cancel { let check: () -> Bool; init(_ check: @escaping () -> Bool) { self.check = check } }
    static var version: String { String(cString: moraAnalyzerVersion()) }
    /// Interleaved stereo f32le at 44100 Hz. Returns nil on cancellation or invalid PCM.
    static func analyze(_ url: URL, frames: Int, cancelled: @escaping () -> Bool) -> [String: Any]? {
        guard frames > 0 else { return nil }
        let cancel = Cancel(cancelled)
        let raw = withExtendedLifetime(cancel) {
            url.withUnsafeFileSystemRepresentation { path -> UnsafeMutablePointer<CChar>? in
                guard let path else { return nil }
                return moraAnalyze(path, UInt64(frames), { context in
                    guard let context else { return true }
                    return Unmanaged<Cancel>.fromOpaque(context).takeUnretainedValue().check()
                }, Unmanaged.passUnretained(cancel).toOpaque())
            }
        }
        return moraJSON(raw)
    }

    /// The same analysis fed in memory: interleaved stereo 44100 Hz blocks in, no PCM file on disk.
    final class Stream {
        private var accumulator: OpaquePointer?
        /// `expectedFrames` only sizes buffers.
        init?(expectedFrames: Int) {
            guard let accumulator = moraAnalysisBegin(UInt64(max(0, expectedFrames))) else { return nil }
            self.accumulator = accumulator
        }
        /// False on invalid PCM or after finish.
        func push(_ interleaved: UnsafePointer<Float>, frames: Int) -> Bool {
            guard let accumulator else { return false }
            return moraAnalysisPush(accumulator, interleaved, frames)
        }
        /// Ends the stream once; nil when cancelled or on invalid PCM.
        func finish(cancel: Bool) -> [String: Any]? {
            guard let accumulator else { return nil }
            self.accumulator = nil
            return moraJSON(moraAnalysisFinish(accumulator, cancel))
        }
        deinit { if let accumulator { _ = moraAnalysisFinish(accumulator, true) } }
    }
}
