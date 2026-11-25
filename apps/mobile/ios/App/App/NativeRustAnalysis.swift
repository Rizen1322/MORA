import Foundation

// packages/audio-rust/src/ffi.rs, linked as libmora_audio.a (apps/mobile/scripts/build-rust-ios.sh).
@_silgen_name("mora_analyzer_version")
private func moraAnalyzerVersion() -> UnsafePointer<CChar>
@_silgen_name("mora_analyze_f32le")
private func moraAnalyze(_ path: UnsafePointer<CChar>, _ frames: UInt64,
                         _ cancelled: (@convention(c) (UnsafeMutableRawPointer?) -> Bool)?, _ context: UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>?
@_silgen_name("mora_free_string")
private func moraFreeString(_ value: UnsafeMutablePointer<CChar>?)

@_silgen_name("mora_plan_json")
private func moraPlan(_ bytes: UnsafePointer<UInt8>?, _ length: Int) -> UnsafeMutablePointer<CChar>?
@_silgen_name("mora_analysis_new")
private func moraAnalysisNew(_ expectedFrames: Int) -> UnsafeMutableRawPointer?
@_silgen_name("mora_analysis_push")
private func moraAnalysisPush(_ handle: UnsafeMutableRawPointer, _ pcm: UnsafePointer<Float>, _ frames: Int) -> Bool
@_silgen_name("mora_analysis_finish")
private func moraAnalysisFinish(_ handle: UnsafeMutableRawPointer) -> UnsafeMutablePointer<CChar>?
@_silgen_name("mora_analysis_free")
private func moraAnalysisFree(_ handle: UnsafeMutableRawPointer)

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
        return Self.object(raw)
    }

    static func analyzePCM(expectedFrames: Int, produce: ((UnsafeRawPointer, Int) throws -> Void) throws -> Void) throws -> [String: Any]? {
        guard expectedFrames > 0, let handle = moraAnalysisNew(expectedFrames) else { return nil }
        defer { moraAnalysisFree(handle) }
        try produce { buffer, count in
            guard moraAnalysisPush(handle, buffer.assumingMemoryBound(to: Float.self), count) else { throw Failure.invalidPCM }
        }
        return object(moraAnalysisFinish(handle))
    }

    static func plan(_ input: String) -> String? {
        let bytes = Array(input.utf8)
        return bytes.withUnsafeBufferPointer { buffer in
            guard let raw = moraPlan(buffer.baseAddress, buffer.count) else { return nil }
            defer { moraFreeString(raw) }
            return String(validatingCString: raw)
        }
    }

    private enum Failure: Error { case invalidPCM }
    private static func object(_ raw: UnsafeMutablePointer<CChar>?) -> [String: Any]? {
        guard let raw else { return nil }
        defer { moraFreeString(raw) }
        return (try? JSONSerialization.jsonObject(with: Data(bytes: raw, count: strlen(raw)))) as? [String: Any]
    }
}