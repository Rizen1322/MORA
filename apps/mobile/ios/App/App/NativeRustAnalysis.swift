import Foundation

// packages/audio-rust/src/ffi.rs, linked as libmora_audio.a (apps/mobile/scripts/build-rust-ios.sh).
@_silgen_name("mora_analyzer_version")
private func moraAnalyzerVersion() -> UnsafePointer<CChar>
@_silgen_name("mora_analyze_f32le")
private func moraAnalyze(_ path: UnsafePointer<CChar>, _ frames: UInt64,
                         _ cancelled: (@convention(c) (UnsafeMutableRawPointer?) -> Bool)?, _ context: UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>?
@_silgen_name("mora_free_string")
private func moraFreeString(_ value: UnsafeMutablePointer<CChar>?)

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
        guard let raw else { return nil }
        defer { moraFreeString(raw) }
        return (try? JSONSerialization.jsonObject(with: Data(bytes: raw, count: strlen(raw)))) as? [String: Any]
    }
}
