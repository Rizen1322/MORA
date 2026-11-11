import Foundation

@MainActor enum StationStarter {
    private static var starting = false

    static func start(source: String? = nil, playlistId: String? = nil, waveOnly: Bool = false) async throws {
        guard !starting else { throw NativeStationSnapshot.Failure.noLocalFiles }
        starting = true
        defer { starting = false }
        let snapshot = try NativeStationFiles.load()
        guard !waveOnly || snapshot.isWave else { throw NativeStationSnapshot.Failure.noLocalFiles }
        if let playlistId, snapshot.context != "playlist" || snapshot.contextId != playlistId { throw NativeStationSnapshot.Failure.noLocalFiles }
        guard source == nil || source == snapshot.source, let root = NativeStationFiles.root else { throw NativeStationSnapshot.Failure.noLocalFiles }
        let tracks = try snapshot.localTracks(in: root)
        let host = NativeMixHost.shared
        NativeLiveActivity.install(host)
        if host.active {
            let state = host.snapshot
            if state["playing"] as? Bool != true {
                _ = try await reply { host.command("play", source: "station", completion: $0) }
            }
            return
        }
        let session = try await reply { host.begin($0) }
        guard let id = session["id"] as? String else { throw NativeStationSnapshot.Failure.invalid }
        func item(_ track: NativeStationSnapshot.Track, _ index: Int) -> [String: Any] {
            ["trackId": track.trackId, "entryId": "station-\(index)-\(track.trackId)", "file": index,
             "title": track.title, "artist": track.artist, "duration": track.duration, "mixingAllowed": false,
             "source": ["kind": "station", "file": track.localFile!]]
        }
        do {
            let first = item(tracks[0], 0)
            _ = try await reply { host.prepareStart(id: id, item: first,
                config: ["sampleRate": 48000.0, "position": min(snapshot.position, max(0, tracks[0].duration - 0.1)), "paused": false], completion: $0) }
            if tracks.count > 1 {
                _ = try await reply { host.prepareQueue(id: id, manifest: ["from": 1,
                    "previous": first, "settings": ["enabled": false],
                    "items": tracks.dropFirst().enumerated().map { item($0.element, $0.offset + 1) }], completion: $0) }
            }
        } catch {
            host.stop { _ in }
            throw error
        }
    }
    private static func reply(_ call: (@escaping NativeMixHost.Reply) -> Void) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { done in call { done.resume(with: $0) } }
    }
}
