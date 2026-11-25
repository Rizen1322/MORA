import Foundation

struct NativeDownloadJob: Codable, Equatable, Identifiable {
    enum State: String, Codable { case queued, downloading, paused, failed, done, cancelled }
    enum Transfer: Equatable {
        case background
        case inApp
        init?(sourceKind: String?, supportsBackground: Bool) {
            guard let sourceKind, !sourceKind.isEmpty else { return nil }
            self = supportsBackground && ["direct", "yandex"].contains(sourceKind) ? .background : .inApp
        }
    }
    var id = UUID().uuidString
    var trackId: String
    var title: String, artist: String, album: String
    var duration: Double
    var expectedBytes: Int64
    var receivedBytes: Int64 = 0
    var state: State = .queued
    var error: String?
    var attempts = 0
    var createdAt = Date()
    var reservedBytes: Int64 { max(receivedBytes, expectedBytes) }
    var progress: Double { expectedBytes > 0 ? min(1, max(0, Double(receivedBytes) / Double(expectedBytes))) : 0 }
    func eta(elapsed: Double) -> Double? {
        guard receivedBytes > 0, expectedBytes >= receivedBytes, elapsed > 0 else { return nil }
        return Double(expectedBytes - receivedBytes) * elapsed / Double(receivedBytes)
    }
    mutating func apply(_ action: String) {
        guard state != .done && state != .cancelled else { return }
        switch action {
        case "pause": state = .paused
        case "resume", "retry": state = .queued; error = nil
        case "cancel": state = .cancelled
        default: break
        }
    }
    mutating func finish(_ result: Result<Int64, Error>) {
        switch result {
        case .success(let bytes):
            let total = max(Int64(0), bytes)
            receivedBytes = total
            expectedBytes = max(expectedBytes, total)
            state = .done
            error = nil
        case .failure(let err):
            state = .failed
            error = err.localizedDescription
        }
    }
    static func retryDelay(attempt: Int) -> Double { min(300, pow(2, Double(max(0, min(10, attempt)))) * 5) }
}
