import MetricKit

final class NativeMetrics: NSObject, MXMetricManagerSubscriber {
    static let shared = NativeMetrics()
    static var folder: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("diagnostics/metrics", isDirectory: true) }
    private let io = DispatchQueue(label: "ru.mora.metrics")
    private override init() { super.init(); MXMetricManager.shared.add(self) }
    func didReceive(_ payloads: [MXMetricPayload]) { for payload in payloads { save(payload.jsonRepresentation(), kind: "metrics") } }
    func didReceive(_ payloads: [MXDiagnosticPayload]) { for payload in payloads { save(payload.jsonRepresentation(), kind: "diagnostics") } }
    private func save(_ data: Data, kind: String) {
        guard data.count <= 4 * 1024 * 1024 else { return }
        io.async {
            do {
                let root = Self.folder, fm = FileManager.default
                try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: NativePreparationFiles.attributes)
                let name = "\(Int64(Date().timeIntervalSince1970 * 1000))-\(kind)-\(UUID().uuidString).json"
                try data.write(to: root.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                let files = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent > $1.lastPathComponent }
                for old in files.dropFirst(20) { try fm.removeItem(at: old) }
            } catch { MoraPlaybackJournal.record("native.metrics.failed", ["reason": "persist"]) }
        }
    }
}
