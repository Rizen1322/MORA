import Foundation

/// Only the widget's wave route; ambiguous or unknown sources use the app's preference.
struct NativeWaveLink {
    let source: String?

    init?(_ url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "mora", parts.host?.lowercased() == "wave",
              parts.path.isEmpty || parts.path == "/" else { return nil }
        let sources = (parts.queryItems ?? []).filter { $0.name == "source" }
        let value = sources.count == 1 ? sources[0].value : nil
        source = value.flatMap { ["own", "online", "yandex"].contains($0) ? $0 : nil }
    }
}
