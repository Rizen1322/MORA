import Foundation

let file = try NativeDiagnosticArchive.make(report: ["version": "1.0.40", "events": []], metrics: nil)
defer { try? FileManager.default.removeItem(at: file) }
let data = try Data(contentsOf: file)
assert(data.starts(with: [0x50, 0x4b, 0x03, 0x04]))
assert(data.range(of: Data("playback.json".utf8)) != nil)
print("Native diagnostic ZIP passed")
