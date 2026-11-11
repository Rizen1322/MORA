import CoreSpotlight
import UniformTypeIdentifiers

@MainActor enum NativeSpotlight {
    private static var revision = 0
    static func update(_ tracks: [NativeTrack]) {
        guard CSSearchableIndex.isIndexingAvailable() else { return }
        revision += 1
        let generation = revision
        let previous = UserDefaults.standard.dictionary(forKey: "mora.spotlight") as? [String: String] ?? [:]
        let fingerprints = Dictionary(tracks.map { ($0.id, "\($0.title)\u{0}\($0.artist)\u{0}\($0.album)") }, uniquingKeysWith: { first, _ in first })
        let deleted = previous.keys.filter { fingerprints[$0] == nil }
        let items = tracks.filter { previous[$0.id] != fingerprints[$0.id] }.map { track -> CSSearchableItem in
            let attributes = CSSearchableItemAttributeSet(contentType: .audio)
            attributes.title = track.title; attributes.artist = track.artist; attributes.album = track.album
            attributes.contentDescription = "\(track.artist) · \(track.album)"
            attributes.keywords = [track.artist, track.album, "MORA"]
            return CSSearchableItem(uniqueIdentifier: track.id, domainIdentifier: "ru.mora.player.library", attributeSet: attributes)
        }
        guard !deleted.isEmpty || !items.isEmpty else { return }
        Task { @MainActor in
            do {
                let index = CSSearchableIndex.default()
                if !deleted.isEmpty { try await index.deleteSearchableItems(withIdentifiers: Array(deleted)) }
                if !items.isEmpty { try await index.indexSearchableItems(items) }
                if generation == revision { UserDefaults.standard.set(fingerprints, forKey: "mora.spotlight") }
            } catch { NativeShellStore.shared?.show("Не удалось обновить Spotlight: \(error.localizedDescription)") }
        }
    }
}
