import Foundation

/// Catalog availability and access to actual mixable bytes are separate capabilities.
struct SourceCapabilities: Sendable {
    let search: Bool
    let recommendations: Bool
    let offline: Bool
    let pcm: Bool
    let mixing: Bool
}

struct SourceItem: Identifiable, Codable, Sendable {
    /// Stable provider + recording ID. A signed URL must never be used as identity.
    let id: String
    let provider: String
    let externalID: String
    let title: String
    let artist: String
    let artworkURL: URL?
    let duration: Double?
}

struct ResolvedAudio: Sendable {
    let url: URL
    let expiresAt: Date?
    let headers: [String: String]
    let mimeType: String
    let permitsOffline: Bool
    let permitsPCM: Bool
}

/// Future native adapters use URLSession, never spawn yt-dlp/FFmpeg or depend on localhost.
protocol MusicSource: Sendable {
    var id: String { get }
    var capabilities: SourceCapabilities { get }
    func search(_ query: String) async throws -> [SourceItem]
    func recommendations(seeds: [SourceItem]) async throws -> [SourceItem]
    func resolve(_ item: SourceItem) async throws -> ResolvedAudio
}
