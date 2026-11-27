import SwiftUI
import UIKit

@MainActor private var searchPlayGeneration = 0

extension NativeShellStore {
    private static let publicArtistIdRegex = try! NSRegularExpression(pattern: #"^UC[\w-]{22}$"#)
    private static let publicAlbumIdRegex = try! NSRegularExpression(pattern: #"^MPRE[\w-]{6,80}$"#)
    private static let soundCloudArtistIdRegex = try! NSRegularExpression(pattern: #"^\d{1,20}$"#)

    private static func searchPathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? value
    }

    private static func matchesRegex(_ regex: NSRegularExpression, _ value: String?) -> Bool {
        guard let value, !value.isEmpty else { return false }
        return regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    /// true means handled, including no-op input; supported errors never retry through WebContent.
    @MainActor func executeLibraryAction(_ name: String, _ args: [String: Any] = [:]) async throws -> Bool {
        guard sharedLibrary else { return false }
        let action = name == "act" ? args["name"] as? String ?? "" : name
        let values = name == "act" ? args["args"] as? [String: Any] ?? [:] : args
        if action == "likeAll" {
            guard let ids = values["ids"] as? [String], !ids.isEmpty else { throw NativeLibraryActions.Failure(message: "Треки не найдены") }
            likeAll(ids)
            return true
        }
        if action == "downloadTracks" {
            var seen = Set<String>()
            let ids = (values["ids"] as? [String] ?? []).filter { !$0.isEmpty && seen.insert($0).inserted }
            guard !ids.isEmpty else { throw NativeLibraryActions.Failure(message: "Треки не найдены") }
            let todo = ids.filter { byId[$0].map { $0.sourceKind == "remote" && !$0.pinned } ?? true }
            guard !todo.isEmpty else {
                show("Эти треки уже на iPhone или не скачиваются")
                return true
            }
            var count = 0
            for id in todo {
                _ = try await NativeServerApp.request("POST", "/api/downloads", body: ["trackId": id])
                count += 1
            }
            show("Добавлено в загрузки: \(count)")
            return true
        }
        if action == "deleteTracks" {
            var seen = Set<String>()
            let ids = (values["ids"] as? [String] ?? []).filter { !$0.isEmpty && seen.insert($0).inserted }
            guard !ids.isEmpty else { throw NativeLibraryActions.Failure(message: "Треки не найдены") }
            var count = 0
            do {
                for id in ids {
                    let encodedId = Self.searchPathComponent(id)
                    _ = try await NativeServerApp.request("DELETE", "/api/tracks/\(encodedId)", body: nil)
                    count += 1
                }
            } catch {
                refreshLibrary()
                throw error
            }
            try await refreshLibraryAfterMutation()
            show("Удалено: \(count)")
            return true
        }
        guard NativeLibraryActions.supports(action) else { return false }
        let result: NativeLibraryActions.Result
        do {
            guard let handled = try await NativeLibraryActions.execute(action, values, request: { method, path, body in
                try await NativeServerApp.request(method, path, body: body)
            }) else { return false }
            result = handled
        } catch {
            refreshLibrary()
            throw error
        }
        if result.mutated {
            do { try await refreshLibraryAfterMutation() }
            catch {
                show("Изменения сохранены. Не удалось обновить медиатеку: \(error.localizedDescription)")
                return true
            }
        }
        if let export = result.export { try await shareLibraryExport(export) }
        if let go = result.go { self.go(go) }
        if let message = result.message { show(message) }
        return true
    }

    @MainActor private func ensureSearchTrack(_ track: [String: Any], provider: String, priority: Int = 0, awaitRefresh: Bool = true) async throws -> String {
        let externalId = (track["externalId"] as? String) ?? (track["id"] as? String) ?? ""
        if let known = track["libraryTrackId"] as? String, !known.isEmpty, byId[known]?.ok == true { return known }
        if !externalId.isEmpty, let local = localCatalogTrack(provider: provider, externalId: externalId), byId[local.trackId]?.ok == true {
            return local.trackId
        }
        guard !externalId.isEmpty else { throw NativeLibraryActions.Failure(message: "Трек не найден") }
        let trackId: String
        if provider == "yandex" {
            var payload = track
            if payload["externalId"] == nil { payload["externalId"] = externalId }
            let res = try await NativeServerApp.request("POST", "/api/providers/yandex/import", body: ["track": payload], timeout: 60)
            guard let id = res["trackId"] as? String, !id.isEmpty else { throw NativeLibraryActions.Failure(message: "Не удалось загрузить трек") }
            trackId = id
        } else {
            let resolvedProvider = provider == "soundcloud" ? "soundcloud" : "youtube"
            let res = try await NativeServerApp.request("POST", "/api/public/prepare", body: [
                "provider": resolvedProvider,
                "externalId": externalId,
                "priority": priority,
                "progressive": true,
            ], timeout: 120)
            guard let id = res["trackId"] as? String, !id.isEmpty else { throw NativeLibraryActions.Failure(message: "Не удалось подготовить трек") }
            trackId = id
        }
        if awaitRefresh {
            try? await refreshLibraryAfterMutation()
        } else {
            registerOptimisticCatalogTrack(id: trackId, raw: track, provider: provider)
            refreshLibrary()
        }
        return trackId
    }

    @MainActor private func playSearchTracks(_ rawTracks: [[String: Any]], startIndex: Int, defaultProvider: String,
                                           context: NativeQueueController.Context) async throws {
        let playable = rawTracks.filter { $0["playable"] as? Bool != false }
        guard !playable.isEmpty else { return }
        searchPlayGeneration &+= 1
        let gen = searchPlayGeneration

        let clamped = max(0, min(rawTracks.count - 1, startIndex))
        let tail = rawTracks[clamped...].filter { $0["playable"] as? Bool != false }
        var ordered = Array((tail.isEmpty ? playable : tail).prefix(25))

        let first = ordered.removeFirst()
        let firstProvider = (first["audioProvider"] as? String) ?? (first["provider"] as? String) ?? defaultProvider
        let firstId = try await ensureSearchTrack(first, provider: firstProvider, priority: 0, awaitRefresh: false)
        guard gen == searchPlayGeneration else { return }
        try await NativeQueueController.shared.play(trackIds: [firstId], at: 0, context: context)

        guard !ordered.isEmpty else { return }
        Task { @MainActor in
            var remaining = ordered
            var firstBatch = true
            while !remaining.isEmpty {
                let count = firstBatch ? 2 : 4
                firstBatch = false
                let chunk = Array(remaining.prefix(count))
                remaining.removeFirst(chunk.count)
                guard gen == searchPlayGeneration,
                      NativeQueueController.shared.context == context,
                      NativeQueueController.shared.entries.contains(where: { $0.trackId == firstId }) else { return }
                var ids: [String] = []
                for item in chunk {
                    guard gen == searchPlayGeneration else { return }
                    let p = (item["audioProvider"] as? String) ?? (item["provider"] as? String) ?? defaultProvider
                    if let tid = try? await self.ensureSearchTrack(item, provider: p, priority: 2, awaitRefresh: false) {
                        ids.append(tid)
                    }
                }
                if !ids.isEmpty,
                   gen == searchPlayGeneration,
                   NativeQueueController.shared.context == context {
                    try? await NativeQueueController.shared.enqueue(trackIds: ids, next: false)
                }
            }
        }
    }

    @MainActor func executeNativeSearchAction(kind: String, trackId externalId: String, sessionId: String,
                                              playlist: String? = nil) async throws -> (go: String?, versions: String?, updated: NativeSearchResults?) {
        guard let session = catalog.searchSession(sessionId),
              let index = session.items.firstIndex(where: { (($0["externalId"] as? String) ?? ($0["id"] as? String)) == externalId }) else {
            throw NativeLibraryActions.Failure(message: "Результаты устарели. Повторите поиск.")
        }
        let item = session.items[index]
        let isYandex = session.source == "yandex"
        let audioProvider = isYandex ? "yandex" : ((item["audioProvider"] as? String) ?? (session.source == "soundcloud" ? "soundcloud" : "youtube"))
        let ctxType = (session.context["type"] as? String) ?? "search"
        let ctxLabel = (session.context["label"] as? String) ?? "Поиск"
        let ctx = NativeQueueController.Context(type: ctxType, id: session.context["id"] as? String, label: ctxLabel)

        if kind == "artist" || kind == "album" {
            if isYandex {
                let artistId = (item["artists"] as? [[String: Any]])?.first?["id"] as? String ?? (item["artistId"] as? String)
                let albumId = item["albumId"] as? String
                if kind == "artist", let artistId, !artistId.isEmpty {
                    return ("/catalog/artist/\(Self.searchPathComponent(artistId))", nil, nil)
                }
                if kind == "album", let albumId, !albumId.isEmpty {
                    return ("/catalog/album/\(Self.searchPathComponent(albumId))", nil, nil)
                }
            } else if session.source == "ytmusic" {
                let artistId = item["artistId"] as? String
                let albumId = item["albumId"] as? String
                if kind == "artist", Self.matchesRegex(Self.publicArtistIdRegex, artistId), let artistId {
                    return ("/public/artist/\(Self.searchPathComponent(artistId))", nil, nil)
                }
                if kind == "album", Self.matchesRegex(Self.publicAlbumIdRegex, albumId), let albumId {
                    return ("/public/album/\(Self.searchPathComponent(albumId))", nil, nil)
                }
            } else if session.source == "soundcloud" {
                let artistId = item["artistId"] as? String
                if kind == "artist", Self.matchesRegex(Self.soundCloudArtistIdRegex, artistId), let artistId {
                    return ("/soundcloud/artist/\(Self.searchPathComponent(artistId))", nil, nil)
                }
            }
            let fallbackQuery = kind == "artist" ? (item["artist"] as? String ?? "") : (item["album"] as? String ?? "")
            return ("/search?q=\(Self.searchPathComponent(fallbackQuery))&src=\(Self.searchPathComponent(session.source))", nil, nil)
        }

        if kind == "play" {
            try await playSearchTracks(session.items, startIndex: index, defaultProvider: audioProvider, context: ctx)
            return (nil, nil, nil)
        }

        if kind == "radio" {
            let title = item["title"] as? String ?? ""
            let artist = item["artist"] as? String ?? ""
            if ["ytmusic", "youtube"].contains(session.source),
               let radioRes = try? await NativeServerApp.request("GET", "/api/public/radio/\(Self.searchPathComponent(externalId))"),
               let radioItems = radioRes["items"] as? [[String: Any]], !radioItems.isEmpty {
                try await playSearchTracks(radioItems, startIndex: 0, defaultProvider: "youtube",
                                           context: NativeQueueController.Context(type: "online-radio", id: externalId, label: "Радио · \(title)"))
                return (nil, nil, nil)
            }
            let q = Self.searchPathComponent("\(artist) \(title)".trimmingCharacters(in: .whitespaces))
            if !q.isEmpty,
               let ytSearch = try? await NativeServerApp.request("GET", "/api/search/ytmusic?q=\(q)"),
               let ytFirst = (ytSearch["items"] as? [[String: Any]])?.first(where: { $0["playable"] as? Bool != false }),
               let videoId = ytFirst["externalId"] as? String,
               let radioRes = try? await NativeServerApp.request("GET", "/api/public/radio/\(Self.searchPathComponent(videoId))"),
               let radioItems = radioRes["items"] as? [[String: Any]], !radioItems.isEmpty {
                try await playSearchTracks(radioItems, startIndex: 0, defaultProvider: "youtube",
                                           context: NativeQueueController.Context(type: "online-radio", id: videoId, label: "Радио · \(title)"))
                return (nil, nil, nil)
            }
            let seedId = try await ensureSearchTrack(item, provider: audioProvider, priority: 0)
            let waveRes = try await NativeServerApp.request("POST", "/api/wave/next", body: ["currentId": seedId, "count": 4])
            let picks = (waveRes["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
            let list = [seedId] + picks.filter { $0 != seedId }
            try await NativeQueueController.shared.play(trackIds: list, at: 0,
                                                        context: NativeQueueController.Context(type: "wave", id: seedId, label: "Волна · \(title)"))
            return (nil, nil, nil)
        }

        let local = localCatalogTrack(provider: audioProvider, externalId: externalId)
        if (kind == "like" || kind == "dislike"), isYandex, local == nil {
            let current = (item["reaction"] as? NSNumber)?.intValue ?? 0
            let wanted = kind == "like" ? 1 : -1
            let next = current == wanted ? 0 : wanted
            let res = try await NativeServerApp.request("POST", "/api/catalog/yandex/tracks/\(Self.searchPathComponent(externalId))/reaction", body: ["value": next])
            let finalValue = (res["value"] as? NSNumber)?.intValue ?? next
            if let sync = res["sync"] as? [String: Any], let st = sync["status"] as? String, st == "error" || st == "pending" {
                show(sync["error"] as? String ?? "Реакция сохранена. Отправка в Яндекс продолжится автоматически.")
            }
            let rawUpdated = catalog.updateSearchSessionTrack(sessionId: sessionId, externalId: externalId, reaction: finalValue,
                                                              lookup: { self.localCatalogTrack(provider: $0, externalId: $1) })
            return (nil, nil, rawUpdated.flatMap(NativeSearchResults.init))
        }

        if kind == "playlist" {
            guard let playlist, playlists.contains(where: { $0.id == playlist }) else {
                throw NativeLibraryActions.Failure(message: "Плейлист не найден")
            }
        }

        let id = try await ensureSearchTrack(item, provider: audioProvider, priority: kind == "download" ? 2 : 0)
        switch kind {
        case "next", "playNext", "queue":
            let isNext = kind == "next" || kind == "playNext"
            try await NativeQueueController.shared.enqueue(trackIds: [id], next: isNext)
            show(isNext ? "Сыграет следующим" : "Добавлено в очередь")
            return (nil, nil, nil)
        case "versions":
            return (nil, id, nil)
        case "save":
            _ = try await NativeServerApp.request("POST", "/api/tracks/\(Self.searchPathComponent(id))/save", body: ["saved": true])
            try? await refreshLibraryAfterMutation()
            catalog.invalidate()
            show("Трек сохранён в медиатеку")
            let rawUpdated = catalog.updateSearchSessionTrack(sessionId: sessionId, externalId: externalId, libraryTrackId: id, saved: true,
                                                              lookup: { self.localCatalogTrack(provider: $0, externalId: $1) })
            return (nil, nil, rawUpdated.flatMap(NativeSearchResults.init))
        case "download":
            _ = try await NativeServerApp.request("POST", "/api/downloads", body: ["trackId": id])
            show("Скачиваем — прогресс в «Загрузках»")
            return (nil, nil, nil)
        case "playlist":
            guard let playlist else {
                throw NativeLibraryActions.Failure(message: "Плейлист не найден")
            }
            _ = try await NativeServerApp.request("POST", "/api/playlists/\(Self.searchPathComponent(playlist))/tracks", body: ["trackIds": [id]])
            try? await refreshLibraryAfterMutation()
            show("Добавлено в плейлист")
            let rawUpdated = catalog.updateSearchSessionTrack(sessionId: sessionId, externalId: externalId, libraryTrackId: id,
                                                              lookup: { self.localCatalogTrack(provider: $0, externalId: $1) })
            return (nil, nil, rawUpdated.flatMap(NativeSearchResults.init))
        case "like", "dislike":
            let wanted = kind == "like" ? 1 : -1
            let current = local?.reaction ?? reaction(id)
            let next = current == wanted ? 0 : wanted
            react(id: id, value: next)
            catalog.invalidate()
            let rawUpdated = catalog.updateSearchSessionTrack(sessionId: sessionId, externalId: externalId, reaction: next, libraryTrackId: id,
                                                              saved: next == 1 ? true : nil,
                                                              lookup: { self.localCatalogTrack(provider: $0, externalId: $1) })
            return (nil, nil, rawUpdated.flatMap(NativeSearchResults.init))
        default:
            throw NativeLibraryActions.Failure(message: "Неизвестное действие")
        }
    }

    @MainActor func presentSearchVersions(id: String) {
        if sharedLibrary, let track = byId[id], var parent = presenter {
            while let presented = parent.presentedViewController { parent = presented }
            if parent.viewIfLoaded?.window != nil {
                let controller = UIHostingController(rootView: NativeVersionView(track: track, store: self))
                controller.modalPresentationStyle = .pageSheet
                controller.sheetPresentationController?.prefersGrabberVisible = true
                controller.overrideUserInterfaceStyle = .dark
                parent.present(controller, animated: true)
                return
            }
        }
        presentVersions(id: id)
    }

    @MainActor private func shareLibraryExport(_ export: NativeLibraryActions.Export) async throws {
        guard var parent = presenter else { throw NativeLibraryActions.Failure(message: "Не удалось открыть экспорт") }
        while let presented = parent.presentedViewController { parent = presented }
        guard parent.view.window != nil, !parent.isBeingDismissed, !parent.isBeingPresented else {
            throw NativeLibraryActions.Failure(message: "Не удалось открыть экспорт. Повторите после закрытия окна.")
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("MORA-playlist-\(UUID().uuidString)", isDirectory: true)
        let url = folder.appendingPathComponent(export.name)
        try await Task.detached(priority: .utility) {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            do { try export.text.write(to: url, atomically: true, encoding: .utf8) }
            catch { try? FileManager.default.removeItem(at: folder); throw error }
        }.value
        guard parent.view.window != nil, parent.presentedViewController == nil, !parent.isBeingDismissed, !parent.isBeingPresented else {
            try? FileManager.default.removeItem(at: folder)
            throw NativeLibraryActions.Failure(message: "Не удалось открыть экспорт. Повторите после закрытия окна.")
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: folder) }
        sheet.popoverPresentationController?.sourceView = parent.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: parent.view.bounds.midX, y: parent.view.bounds.midY, width: 1, height: 1)
        parent.present(sheet, animated: true)
    }
}

/// SwiftUI screens of the shell; navigation still uses the page's router.

/// Tactile spring press feedback for cards, pills and primary buttons.
struct MoraPressStyle: ButtonStyle {
    var scale: CGFloat = 0.96
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

/// Subtle highlight + micro-press feedback for track and catalog rows.
struct MoraRowPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(configuration.isPressed ? Color.white.opacity(0.06) : Color.clear)
                    .padding(.horizontal, -6)
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

/// Lightweight pulsing skeleton modifier that respects Reduce Motion.
struct MoraShimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    func body(content: Content) -> some View {
        content
            .opacity(reduceMotion ? 0.55 : (pulse ? 0.78 : 0.36))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.95).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
    }
}

struct MoraSearchSkeleton: View {
    var rows: Int = 5

    var body: some View {
        VStack(spacing: 12) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.white.opacity(0.11))
                        .frame(width: 48, height: 48)
                    VStack(alignment: .leading, spacing: 7) {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(Color.white.opacity(0.12))
                            .frame(width: index % 2 == 0 ? 175 : 140, height: 13)
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(Color.white.opacity(0.08))
                            .frame(width: index % 2 == 0 ? 115 : 145, height: 11)
                    }
                    Spacer()
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(Color.white.opacity(0.08))
                        .frame(width: 34, height: 11)
                }
                .frame(minHeight: 54)
            }
        }
        .modifier(MoraShimmer())
    }
}

struct MoraCatalogSkeleton: View {
    let preview: NativeCatalogPreview?

    var body: some View {
        let isArtist = preview?.isArtist == true
        let width = UIScreen.main.bounds.width
        VStack(spacing: 22) {
            ZStack(alignment: .bottom) {
                if let preview, let cover = preview.cover {
                    NativeCover(url: cover, size: width, radius: 0, monogram: preview.title)
                        .frame(width: width, height: 280)
                        .clipped()
                        .blur(radius: 38)
                        .opacity(0.42)
                    LinearGradient(
                        colors: [Color.moraBackground.opacity(0.1), Color.moraBackground.opacity(0.75), Color.moraBackground],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 280)
                }
                VStack(spacing: 12) {
                    if let preview {
                        NativeCover(url: preview.cover, size: isArtist ? 142 : 200, radius: isArtist ? 71 : 14, monogram: preview.title)
                            .overlay(Group {
                                if isArtist { Circle().stroke(Color.moraMint.opacity(0.4), lineWidth: 1.5) }
                                else { RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.white.opacity(0.12), lineWidth: 0.75) }
                            })
                            .shadow(color: .black.opacity(0.45), radius: 18, y: 8)
                        Text(preview.title)
                            .font(.title2.bold())
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 16)
                        if !preview.detail.isEmpty {
                            Text(preview.detail)
                                .font(.subheadline)
                                .foregroundStyle(.white.opacity(0.65))
                                .lineLimit(1)
                        }
                    } else {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.white.opacity(0.1))
                            .frame(width: 190, height: 190)
                            .modifier(MoraShimmer())
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.white.opacity(0.12))
                            .frame(width: 180, height: 22)
                            .modifier(MoraShimmer())
                    }
                    HStack(spacing: 12) {
                        Capsule().fill(Color.moraMint.opacity(0.22)).frame(width: 148, height: 46)
                        Capsule().fill(Color.moraSurfaceElevated).frame(width: 148, height: 46)
                    }
                    .modifier(MoraShimmer())
                    .padding(.top, 4)
                }
                .padding(.top, 14)
                .padding(.bottom, 8)
            }
            MoraSearchSkeleton(rows: 6)
                .padding(.horizontal, 16)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Tinted glass symbol badge matching MORA's obsidian & mint design system.
struct NativeIconBadge: View {
    let symbol: String
    var size: CGFloat = 30
    var tint: Color = .moraMint

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.48, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous).stroke(tint.opacity(0.24), lineWidth: 0.75))
            .accessibilityHidden(true)
    }
}

// MARK: Home

struct NativeHomeView: View {
    @EnvironmentObject private var store: NativeShellStore

    private static func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? value
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    header
                    NativeWaveHero(wave: store.ui.wave)
                    stations
                    tiles
                    recentlyPlayed
                    if store.ui.loaded && store.library.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Добавьте свою музыку").font(.title3.bold())
                            Text("Импортируйте файлы или плейлист, либо найдите музыку в поиске.").foregroundStyle(.white.opacity(0.65))
                            Button("Импорт") { store.go("/import") }
                                .buttonStyle(.borderedProminent)
                                .tint(.moraMint)
                                .foregroundStyle(Color.moraBackground)
                                .frame(minHeight: 44)
                        }
                        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.moraSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 1))
                    }
                    rail("Недавно добавленные", Array(store.library.prefix(16)), type: "library", all: "/library/tracks")
                    artistRail
                    rail("Любимое", Array(store.liked.prefix(16)), type: "liked", all: "/liked")
                    if !store.playlists.isEmpty { playlists }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Locale(identifier: "ru_RU"))))
                    .font(.subheadline.weight(.medium)).foregroundStyle(.white.opacity(0.55))
                Text(NativeText.greeting(hour: Calendar.current.component(.hour, from: .now)))
                    .font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            }
            Spacer()
            Button { store.go("/more") } label: {
                Image(systemName: "person.crop.circle")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.9))
                    .frame(width: 44, height: 44)
                    .background(Color.moraSurface, in: Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.1), lineWidth: 0.75))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Профиль и настройки")
        }
    }

    @ViewBuilder private var stations: some View {
        let items = store.artistStations
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Станции для вас").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 14) {
                        ForEach(items) { station in
                            Button { store.run("artistRadio", ["artist": station.artist]) } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .fill(LinearGradient(colors: [Color.moraSurfaceElevated, Color.moraBackground], startPoint: .topLeading, endPoint: .bottomTrailing))
                                        NativeCover(url: station.cover, size: 172, radius: 18, monogram: station.artist)
                                            .blur(radius: 26)
                                            .opacity(0.45)
                                        LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom)
                                        NativeCover(url: station.cover, size: 106, radius: 53, monogram: station.artist)
                                            .overlay(Circle().stroke(Color.moraMint.opacity(0.45), lineWidth: 1.5))
                                            .shadow(color: .black.opacity(0.45), radius: 10, y: 5)
                                            .offset(y: -6)
                                        VStack {
                                            Spacer()
                                            HStack(spacing: 4) {
                                                Image(systemName: "waveform").font(.caption2.bold()).foregroundStyle(Color.moraMint)
                                                Text("РАДИО").font(.caption2.weight(.bold)).tracking(0.6)
                                            }
                                            .foregroundStyle(.white)
                                            .padding(.horizontal, 9)
                                            .padding(.vertical, 4)
                                            .background(.ultraThinMaterial, in: Capsule())
                                            .overlay(Capsule().stroke(Color.white.opacity(0.16), lineWidth: 0.75))
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(10)
                                    }
                                    .frame(width: 172, height: 172)
                                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.white.opacity(0.1), lineWidth: 1))
                                    Text(station.artist + " и похожие").font(.subheadline.weight(.semibold)).lineLimit(2)
                                    Text("Радиостанция").font(.caption).foregroundStyle(.white.opacity(0.55))
                                }
                                .frame(width: 172, alignment: .leading)
                            }
                            .buttonStyle(MoraPressStyle())
                            .disabled(store.offline || store.ui.wave.loading)
                            .accessibilityElement(children: .combine)
                            .accessibilityHint(store.offline ? "Для станции нужен интернет" : "Слушать артиста и похожую музыку")
                        }
                    }
                }
                .scrollClipDisabled()
            }
        }
    }

    private var tiles: some View {
        let offlineCount = store.offlineTrackCount
        let items: [(String, String, String, Bool, String?)] = [
            ("/liked", "Любимое", "heart.fill", false, store.liked.isEmpty ? nil : NativeText.tracks(store.liked.count)),
            ("/downloads", "Загрузки", "arrow.down.circle.fill", false, offlineCount > 0 ? NativeText.tracks(offlineCount) : nil),
            ("/history", "История", "clock.arrow.circlepath", true, nil),
            ("/import", "Импорт", "square.and.arrow.down.fill", true, nil)]
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(items, id: \.0) { item in
                let tint = item.3 ? Color.moraGold : Color.moraMint
                Button { store.go(item.0) } label: {
                    HStack(spacing: 12) {
                        NativeIconBadge(symbol: item.2, size: 38, tint: tint)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.1).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                            if let detail = item.4 { Text(detail).font(.caption).foregroundStyle(.white.opacity(0.55)).lineLimit(1) }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
                    .background(Color.moraSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.75))
                    .contentShape(Rectangle())
                }
                .buttonStyle(MoraPressStyle())
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private var recentlyPlayed: some View {
        let tracks = store.recentlyPlayedTracks
        if !tracks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Недавно слушали").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button { store.go("/history") } label: {
                        HStack(spacing: 4) { Text("Все"); Image(systemName: "chevron.forward").font(.caption.weight(.bold)) }
                            .font(.subheadline.weight(.medium)).foregroundStyle(Color.moraMint).frame(minHeight: 44)
                    }
                    .accessibilityLabel("Вся история")
                }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                        let active = store.isCurrentTrack(track.id)
                        Button { store.play(tracks, at: index, type: "history", label: "Недавно слушали") } label: {
                            HStack(spacing: 10) {
                                NativeCover(url: track.cover, size: 44, radius: 8, monogram: track.title)
                                    .overlay {
                                        if active {
                                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                                .fill(Color.black.opacity(0.45))
                                                .overlay { NativePlayingIndicator(playing: store.miniPlaying) }
                                        }
                                    }
                                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.75))
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(track.title)
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(active ? Color.moraMint : .white)
                                        .lineLimit(1)
                                    Text(track.artist)
                                        .font(.caption2)
                                        .foregroundStyle(.white.opacity(0.55))
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 7)
                            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
                            .background(Color.moraSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.75))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(MoraPressStyle())
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(track.title), \(track.artist)\(active ? (store.miniPlaying ? ", сейчас играет" : ", на паузе") : "")")
                        .accessibilityHint("Играть")
                        .contextMenu { NativeTrackActions(track: track, play: { store.play(tracks, at: index, type: "history", label: "Недавно слушали") }) }
                    }
                }
            }
        }
    }

    @ViewBuilder private var artistRail: some View {
        let artists = store.favoriteArtists
        if !artists.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Ваши исполнители").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button { store.go("/library/artists") } label: {
                        HStack(spacing: 4) { Text("Все"); Image(systemName: "chevron.forward").font(.caption.weight(.bold)) }
                            .font(.subheadline.weight(.medium)).foregroundStyle(Color.moraMint).frame(minHeight: 44)
                    }
                    .accessibilityLabel("Все исполнители")
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 16) {
                        ForEach(artists, id: \.name) { item in
                            Button { store.go("/artist/\(Self.encoded(item.name))") } label: {
                                VStack(spacing: 8) {
                                    NativeCover(url: item.cover, size: 92, radius: 46, monogram: item.name)
                                        .overlay(Circle().stroke(Color.white.opacity(0.14), lineWidth: 1))
                                        .shadow(color: .black.opacity(0.3), radius: 8, y: 4)
                                    Text(item.name)
                                        .font(.footnote.weight(.semibold))
                                        .lineLimit(1)
                                        .frame(width: 92)
                                }
                            }
                            .buttonStyle(MoraPressStyle())
                        }
                    }
                }
                .scrollClipDisabled()
            }
        }
    }

    @ViewBuilder private func rail(_ title: String, _ tracks: [NativeTrack], type: String, all: String) -> some View {
        if !tracks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(title).font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button { store.go(all) } label: {
                        HStack(spacing: 4) { Text("Все"); Image(systemName: "chevron.forward").font(.caption.weight(.bold)) }
                            .font(.subheadline.weight(.medium)).foregroundStyle(Color.moraMint).frame(minHeight: 44)
                    }
                    .accessibilityLabel("Показать все: " + title)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 14) {
                        ForEach(Array(tracks.enumerated()), id: \.element.id) { i, t in
                            Button { store.play(tracks, at: i, type: type, label: title) } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    NativeCover(url: t.cover, size: 152, radius: 12, monogram: t.title)
                                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.09), lineWidth: 0.75))
                                        .shadow(color: .black.opacity(0.32), radius: 8, y: 4)
                                    Text(t.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                    Text(t.artist).font(.caption).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                                }
                                .frame(width: 152, alignment: .leading)
                            }
                            .buttonStyle(MoraPressStyle())
                            .accessibilityElement(children: .combine)
                            .accessibilityHint("Играть")
                            .contextMenu { NativeTrackActions(track: t, play: { store.play(tracks, at: i, type: type, label: title) }) }
                        }
                    }
                }
                .scrollClipDisabled()
            }
        }
    }

    private var playlists: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Плейлисты").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                Button { store.go("/library/playlists") } label: {
                    HStack(spacing: 4) { Text("Все"); Image(systemName: "chevron.forward").font(.caption.weight(.bold)) }
                        .font(.subheadline.weight(.medium)).foregroundStyle(Color.moraMint).frame(minHeight: 44)
                }
                .accessibilityLabel("Все плейлисты")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(store.playlists) { p in
                        Button { store.go("/playlist/\(p.id)") } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                NativeCollageCover(urls: store.playlistCovers(for: p.id), size: 152, radius: 12, monogram: p.name)
                                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.09), lineWidth: 0.75))
                                    .shadow(color: .black.opacity(0.32), radius: 8, y: 4)
                                Text(p.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text(NativeText.tracks(p.count)).font(.caption).foregroundStyle(.white.opacity(0.55))
                            }
                            .frame(width: 152, alignment: .leading)
                        }
                        .buttonStyle(MoraPressStyle())
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .scrollClipDisabled()
        }
    }
}

/// «Моя волна»: source switch (Коллекция / Радио / Яндекс) and Play, as the web Home hero.
struct NativeWaveHero: View {
    let wave: NativeWave
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        let selected = store.waveSource.flatMap { wave.sources.contains($0) ? $0 : nil } ?? wave.preferred
        let button = wave.button(selected)
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    if wave.active != nil {
                        Circle().fill(Color.moraMint).frame(width: 7, height: 7)
                        Text("Сейчас в эфире")
                    } else {
                        Image(systemName: "waveform")
                        Text("Персональный поток")
                    }
                }
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.moraMint)
                (Text("Моя волна") + Text(".").foregroundColor(.moraMint)).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Text("Знакомое, любимое и то, что ещё предстоит открыть.").font(.subheadline).foregroundStyle(.white.opacity(0.72))
            }
            Picker("Источник волны", selection: Binding(get: { selected }, set: { store.waveSource = $0 })) {
                ForEach(wave.sources, id: \.self) { s in
                    Text(s == .own ? "Коллекция" : s == .online ? "Радио" : "Яндекс").tag(s)
                }
            }
            .pickerStyle(.segmented)
            HStack(spacing: 10) {
                Button { store.run("wave", ["source": selected.rawValue]) } label: {
                    Label(button.title, systemImage: button.symbol).font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .foregroundStyle(Color.moraBackground)
                        .background(Color.moraMint.opacity(button.enabled ? 1 : 0.4), in: Capsule())
                }
                .buttonStyle(MoraPressStyle())
                .disabled(!button.enabled)
                Button { store.waveSource = selected; store.go("/wave") } label: {
                    Image(systemName: "slider.horizontal.3").font(.headline).frame(width: 54, height: 54)
                        .background(Color.white.opacity(0.1), in: Circle())
                        .overlay(Circle().stroke(Color.white.opacity(0.14), lineWidth: 0.75))
                }
                .buttonStyle(MoraPressStyle())
                .accessibilityLabel("Настроить волну").accessibilityIdentifier("wave.settings")
            }
            if let error = wave.error, !error.isEmpty {
                Text(error).font(.footnote).foregroundStyle(Color(red: 1, green: 0.55, blue: 0.5))
            }
        }
        .padding(20)
        .background {
            let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)
            ZStack(alignment: .topTrailing) {
                shape.fill(LinearGradient(colors: [Color(red: 14 / 255, green: 45 / 255, blue: 32 / 255), Color(red: 6 / 255, green: 19 / 255, blue: 14 / 255)],
                                          startPoint: .topLeading, endPoint: .bottomTrailing))
                RadialGradient(colors: [Color.moraMint.opacity(0.16), .clear], center: .topTrailing, startRadius: 10, endRadius: 220)
                Image(systemName: "waveform").font(.system(size: 130, weight: .ultraLight))
                    .foregroundStyle(Color.moraMint.opacity(0.09)).offset(x: 28, y: -6).accessibilityHidden(true)
            }
            .clipShape(shape)
            .overlay(shape.stroke(Color.moraMint.opacity(0.22), lineWidth: 1))
        }
        .onChange(of: wave.active) { _, active in if active != nil { store.waveSource = nil } } // follow what plays now
    }
}

// MARK: Library and liked tracks

struct NativeTrackListView: View {
    let title: String
    let type: String
    let tracks: [NativeTrack]
    @EnvironmentObject private var store: NativeShellStore
    @State private var query = ""
    /// Non-nil while choosing tracks: rows toggle instead of playing and a bar of bulk actions shows.
    @State private var selection: Set<String>?
    @State private var confirmDelete = false

    var body: some View {
        let shown = NativeSearchText.filter(tracks, query)
        NavigationStack {
            List {
                if !store.ui.loaded {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                } else if shown.isEmpty {
                    let liked = type == "liked"
                    let title: String = !query.isEmpty ? "Ничего не найдено" : liked ? "Пока ничего любимого" : "Медиатека пуста"
                    let hint: String = !query.isEmpty ? "Попробуйте другой запрос." : liked ? "Отмечайте треки сердцем — они соберутся здесь." : "Добавьте музыку через импорт или поиск."
                    ContentUnavailableView(title, systemImage: liked ? "heart" : "music.note.list", description: Text(hint))
                        .listRowBackground(Color.clear)
                } else {
                    if query.isEmpty && selection == nil {
                        HStack(spacing: 10) {
                            playButton("Слушать", "play.fill", prominent: true) { store.play(shown, at: 0, type: type, label: title) }
                            playButton("Вперемешку", "shuffle", prominent: false) { store.play(shown.shuffled(), at: 0, type: type, label: title) }
                        }
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    }
                    Section {
                        ForEach(Array(shown.enumerated()), id: \.element.id) { i, t in
                            if let selection {
                                NativeTrackRow(track: t, play: { self.selection = selection.symmetricDifference([t.id]) }, selected: selection.contains(t.id))
                            } else {
                                NativeTrackRow(track: t) { store.play(shown, at: i, type: type, label: title) }
                            }
                        }
                    } header: {
                        Text(NativeText.tracks(shown.count)).font(.footnote).foregroundStyle(.white.opacity(0.55))
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Название, исполнитель, альбом")
            .navigationTitle(selection.map { $0.isEmpty ? "Выберите треки" : NativeText.tracks($0.count) } ?? title)
            .navigationBarTitleDisplayMode(selection == nil ? .automatic : .inline)
            .safeAreaInset(edge: .bottom) { if let selection { bulkBar(shown.filter { selection.contains($0.id) }) } }
            .confirmationDialog("Удалить из медиатеки?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Удалить: " + NativeText.tracks(selection?.count ?? 0), role: .destructive) {
                    bulk("deleteTracks", shown.filter { selection?.contains($0.id) == true })
                }
            } message: { Text("Скачанные копии и файлы в папке приложения тоже удалятся. Исходные файлы на устройстве не затрагиваются.") }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !shown.isEmpty || selection != nil {
                        Button(selection == nil ? "Выбрать" : "Готово") { selection = selection == nil ? [] : nil }
                            .frame(minHeight: 44)
                    }
                }
                if let selection {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(selection.count == shown.count ? "Снять все" : "Все") {
                            self.selection = selection.count == shown.count ? [] : Set(shown.map(\.id))
                        }.frame(minHeight: 44)
                    }
                } else if type == "liked" && !tracks.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { store.run("act", ["name": "downloadTracks", "args": ["ids": tracks.map(\.id)]]) } label: {
                            Image(systemName: "arrow.down.circle").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Скачать всё любимое на iPhone")
                    }
                }
                if type == "library" && selection == nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("Альбомы") { store.go("/library/albums") }
                            Button("Исполнители") { store.go("/library/artists") }
                            Button("Плейлисты") { store.go("/library/playlists") }
                        } label: {
                            Image(systemName: "square.stack").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Разделы медиатеки")
                    }
                }
            }
        }
    }

    private func playButton(_ title: String, _ symbol: String, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).font(.headline)
                .frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(prominent ? Color.moraBackground : Color.moraMint)
                .background(prominent ? Color.moraMint : Color.moraSurfaceElevated, in: Capsule())
                .overlay(Capsule().stroke(prominent ? Color.clear : Color.white.opacity(0.09), lineWidth: 0.75))
        }
        .buttonStyle(MoraPressStyle())
    }

    private func bulkBar(_ chosen: [NativeTrack]) -> some View {
        let playable = chosen.filter(\.ok)
        return HStack(spacing: 4) {
            bulkButton("Следующим", "text.line.first.and.arrowtriangle.forward", disabled: playable.isEmpty) {
                store.run("queue", ["ids": playable.map(\.id), "next": true]); selection = nil
            }
            bulkButton("В очередь", "text.append", disabled: playable.isEmpty) {
                store.run("queue", ["ids": playable.map(\.id), "next": false]); selection = nil
            }
            bulkButton("В плейлист", "text.badge.plus", disabled: chosen.isEmpty) { store.playlistTarget = chosen; selection = nil }
            bulkButton("Скачать", "arrow.down.circle", disabled: chosen.isEmpty) { bulk("downloadTracks", chosen) }
            bulkButton("Удалить", "trash", disabled: chosen.isEmpty) { confirmDelete = true }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .moraGlass(Capsule())
        .padding(.horizontal, 12).padding(.bottom, 8)
    }

    private func bulkButton(_ title: String, _ symbol: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: symbol).font(.body.weight(.semibold))
                Text(title).font(.caption2).lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }

    private func bulk(_ action: String, _ chosen: [NativeTrack]) {
        guard !chosen.isEmpty else { return }
        store.run("act", ["name": action, "args": ["ids": chosen.map(\.id)]])
        selection = nil
    }
}

struct NativePlayingIndicator: View {
    let playing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if playing && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { context in
                bars(at: context.date.timeIntervalSinceReferenceDate)
            }
        } else {
            bars(at: nil)
        }
    }

    private func bars(at time: TimeInterval?) -> some View {
        let heights: [CGFloat]
        if let t = time {
            heights = [
                4 + 9 * (0.5 + 0.5 * sin(t * 5.2)),
                4 + 9 * (0.5 + 0.5 * sin(t * 6.4 + 1.8)),
                4 + 9 * (0.5 + 0.5 * sin(t * 4.7 + 3.4)),
            ]
        } else {
            heights = [7, 11, 5.5]
        }
        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<3, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1.25, style: .continuous)
                    .fill(Color.moraMint)
                    .frame(width: 2.5, height: heights[index])
            }
        }
        .frame(width: 14, height: 14, alignment: .bottom)
        .accessibilityHidden(true)
    }
}

struct NativeTrackRow: View {
    let track: NativeTrack
    let play: () -> Void
    /// A page's own action for the row (remove from a playlist, delete a download).
    var remove: (title: String, symbol: String, run: () -> Void)? = nil
    /// Set while the list is choosing tracks: a tap toggles this row.
    var selected: Bool? = nil
    @EnvironmentObject private var store: NativeShellStore

    private var isActive: Bool {
        store.isCurrentTrack(track.id)
    }

    var body: some View {
        Button(action: play) {
            HStack(spacing: 12) {
                if let selected {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle").font(.title3)
                        .foregroundStyle(selected ? Color.moraMint : .white.opacity(0.4))
                        .accessibilityHidden(true)
                }
                NativeCover(url: track.cover, size: 48, monogram: track.title)
                    .overlay {
                        if isActive {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.black.opacity(0.45))
                                .overlay { NativePlayingIndicator(playing: store.miniPlaying) }
                        }
                    }
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.75))
                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(isActive ? Color.moraMint : .white)
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        if track.offline && (track.sourceKind == "remote" || track.pinned) {
                            Image(systemName: "arrow.down.circle.fill")
                                .font(.caption2)
                                .foregroundStyle(Color.moraMint)
                                .accessibilityHidden(true)
                        }
                        Text(track.artist).font(.subheadline).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if track.liked {
                    Image(systemName: "heart.fill").font(.caption).foregroundStyle(Color.moraMint).accessibilityHidden(true)
                }
                Text(NativePlayerTime.text(track.duration)).font(.footnote.monospacedDigit()).foregroundStyle(.white.opacity(0.5))
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 56)
            .contentShape(Rectangle())
            .opacity(track.ok || selected != nil ? 1 : 0.45)
        }
        .buttonStyle(MoraRowPressStyle())
        .disabled(!track.ok && selected == nil)
        .listRowBackground(Color.clear)
        .accessibilityLabel("\(track.title), \(track.artist)\(isActive ? (store.miniPlaying ? ", сейчас играет" : ", на паузе") : "")\(track.liked ? ", в любимом" : "")")
        .accessibilityValue(NativePlayerTime.text(track.duration))
        .accessibilityHint(selected != nil ? "Выбрать" : track.ok ? "Играть" : "Файл недоступен")
        .accessibilityAddTraits(selected == true ? .isSelected : [])
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button { NativeShellStore.shared?.queue(track, next: true) } label: { Label("Следующим", systemImage: "text.line.first.and.arrowtriangle.forward") }
                .tint(.moraMint)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button { NativeShellStore.shared?.queue(track, next: false) } label: { Label("В очередь", systemImage: "text.append") }
                .tint(.indigo)
            Button { NativeShellStore.shared?.react(track, track.liked ? 0 : 1) } label: {
                Label(track.liked ? "Убрать" : "Нравится", systemImage: track.liked ? "heart.slash" : "heart")
            }
            .tint(.moraGold)
        }
        .contextMenu {
            NativeTrackActions(track: track, play: play)
            if let remove {
                Divider()
                Button(role: .destructive, action: remove.run) { Label(remove.title, systemImage: remove.symbol) }
            }
        }
        .accessibilityAction(named: "Играть следующим") { NativeShellStore.shared?.queue(track, next: true) }
        .accessibilityAction(named: "Добавить в очередь") { NativeShellStore.shared?.queue(track, next: false) }
        .accessibilityAction(named: track.liked ? "Убрать из любимого" : "Нравится") { NativeShellStore.shared?.react(track, track.liked ? 0 : 1) }
    }
}

struct NativeTrackActions: View {
    let track: NativeTrack
    let play: () -> Void

    var body: some View {
        Button(action: play) { Label("Играть", systemImage: "play") }.disabled(!track.ok)
        Button { NativeShellStore.shared?.queue(track, next: true) } label: { Label("Играть следующим", systemImage: "text.line.first.and.arrowtriangle.forward") }.disabled(!track.ok)
        Button { NativeShellStore.shared?.queue(track, next: false) } label: { Label("Добавить в очередь", systemImage: "text.append") }.disabled(!track.ok)
        Button { NativeShellStore.shared?.playlistTarget = [track] } label: { Label("Добавить в плейлист", systemImage: "text.badge.plus") }
        Divider()
        Button { NativeShellStore.shared?.react(track, track.liked ? 0 : 1) } label: {
            Label(track.liked ? "Убрать из любимого" : "Нравится", systemImage: track.liked ? "heart.slash" : "heart")
        }
        Button { NativeShellStore.shared?.react(track, track.reaction < 0 ? 0 : -1) } label: {
            Label(track.reaction < 0 ? "Убрать «Не нравится»" : "Не нравится", systemImage: "hand.thumbsdown")
        }
        Divider()
        if let url = URL(string: "mora://track/" + track.id) { ShareLink(item: url) { Label("Поделиться треком", systemImage: "square.and.arrow.up") } }
        // The page's version picker takes over the screen (lib/native-ui.ts `versions`); the shell steps aside.
        Button { NativeShellStore.shared?.run("versions", ["id": track.id]) } label: { Label("Заменить трек", systemImage: "arrow.triangle.swap") }
        Button { NativeShellStore.shared?.go("/track-edit/\(track.id)") } label: { Label("Сведения о треке", systemImage: "pencil") }
        if !track.album.isEmpty {
            Button { NativeShellStore.shared?.run("open", ["id": track.id, "to": "album"]) } label: { Label("Перейти к альбому", systemImage: "square.stack") }
        }
        Button { NativeShellStore.shared?.run("open", ["id": track.id, "to": "artist"]) } label: { Label("Перейти к исполнителю", systemImage: "music.mic") }
    }
}

/// «Добавить в плейлист» from the track menu: an existing playlist or a new one, without leaving the screen.
struct NativePlaylistPicker: View {
    let tracks: [NativeTrack]
    @EnvironmentObject private var store: NativeShellStore
    @Environment(\.dismiss) private var dismiss
    @State private var creating = false
    @State private var name = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { name = ""; creating = true } label: { Label("Новый плейлист", systemImage: "plus") }
                        .accessibilityIdentifier("playlist.new")
                } footer: {
                    Text(subject)
                }
                Section("Мои плейлисты") {
                    if store.playlists.isEmpty {
                        Text("Плейлистов пока нет — создайте первый.").foregroundStyle(.white.opacity(0.6))
                    }
                    ForEach(store.playlists) { playlist in
                        Button { add(to: playlist.id) } label: {
                            HStack(spacing: 12) {
                                NativeCover(url: playlist.cover, size: 36, radius: 6)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(playlist.name).lineLimit(1)
                                    Text(NativeText.tracks(playlist.count)).font(.caption).foregroundStyle(.white.opacity(0.55))
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "plus.circle.fill").foregroundStyle(Color.moraMint)
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Добавить в «\(playlist.name)»")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .navigationTitle("В плейлист")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } } }
            .alert("Новый плейлист", isPresented: $creating) {
                TextField("Название", text: $name)
                Button("Создать") { create() }
                Button("Отмена", role: .cancel) { name = "" }
            } message: { Text(subject + " — в новый плейлист.") }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .tint(.moraMint)
        .preferredColorScheme(.dark)
    }

    private var subject: String { tracks.count == 1 ? "«\(tracks[0].title)» — \(tracks[0].artist)" : NativeText.tracks(tracks.count) }

    private func add(to playlistId: String) {
        store.run("addToPlaylist", ["ids": tracks.map(\.id), "playlistId": playlistId])
        dismiss()
    }

    private func create() {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        store.run("addToPlaylist", ["ids": tracks.map(\.id), "name": value])
        dismiss()
    }
}

// MARK: Search

/// Catalog search: the collection, YouTube Music, SoundCloud and Yandex Music.
struct NativeSearchView: View {
    private static let publicSources = ["ytmusic", "youtube", "soundcloud"]
    @EnvironmentObject private var store: NativeShellStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var results: [String: NativeSearchResults] = [:]
    @State private var errors: [String: String] = [:]
    @State private var searching: Set<String> = []
    @State private var recent = UserDefaults.standard.stringArray(forKey: "mora.nativeSearchRecent") ?? []
    @State private var busy = false
    @State private var loadingTrackId: String?
    @State private var lastSearchedQuery = ""
    @State private var playGeneration = 0
    @State private var failure: String?
    private var query: String { store.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var source: String { store.searchSource }
    private var scope: String { store.searchScope }
    private var key: String { query + "|" + source + "|" + scope }
    private var availableSourceChips: [String] {
        store.ui.wave.yandex
            ? ["yandex", "all", "local"] + Self.publicSources
            : ["all", "local"] + Self.publicSources + ["yandex"]
    }
    private var sources: [String] { source == "all" ? Self.publicSources + (store.ui.wave.yandex ? ["yandex"] : []) : source == "local" ? [] : [source] }
    private var local: [NativeTrack] { query.isEmpty ? [] : NativeSearchText.filter(store.library, query) }

    var body: some View {
        NavigationStack {
            List {
                filters
                if let title = store.ui.preparing {
                    HStack(spacing: 10) {
                        ProgressView().tint(.moraMint)
                        Text("Подготавливаем «\(title)»…").font(.subheadline)
                        Spacer()
                        Button("Отмена") { store.run("searchCancel") }
                    }.listRowBackground(Color.clear)
                }
                if query.isEmpty { history }
                if source == "yandex" && !store.ui.wave.yandex {
                    ContentUnavailableView("Подключите Яндекс Музыку", systemImage: "music.note", description: Text("Войдите в аккаунт для поиска по каталогу."))
                        .listRowBackground(Color.clear)
                    Button("Подключить") { store.go("/sources") }
                        .buttonStyle(.borderedProminent)
                        .tint(.moraMint)
                        .foregroundStyle(Color.moraBackground)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else {
                    if !query.isEmpty && (source == "all" || source == "local") { localSection }
                    ForEach(sources, id: \.self) { value in
                        if !query.isEmpty || source == "yandex" { remoteSection(value) }
                    }
                    if query.isEmpty && source != "yandex" { browseGrid }
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(Color.moraBackground)
            .scrollDismissesKeyboard(.interactively)
            .searchable(text: $store.searchQuery, placement: .navigationBarDrawer(displayMode: .always), prompt: "Трек, исполнитель, альбом или ссылка")
            .autocorrectionDisabled().textInputAutocapitalization(.never).submitLabel(.search)
            .onSubmit(of: .search) { remember() }
            .navigationTitle(source == "yandex" ? "Яндекс Музыка" : "Поиск")
            .task(id: key) {
                // Single debounce: only delay when typing a non-empty query; source/scope switches search immediately.
                if !query.isEmpty && query != lastSearchedQuery {
                    try? await Task.sleep(for: .milliseconds(220))
                }
                guard !Task.isCancelled else { return }
                lastSearchedQuery = query
                await search()
            }
            .refreshable { await search() }
            .onChange(of: store.searchSource) { _, value in
                loadingTrackId = nil
                if value != "yandex" { store.searchScope = "all" }
            }
            .onChange(of: store.searchQuery) { _, value in
                loadingTrackId = nil
                if value.count > 200 { store.searchQuery = String(value.prefix(200)) }
            }
            .alert("Не удалось выполнить", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) { Button("Понятно", role: .cancel) {} } message: { Text(failure ?? "") }
        }
    }
    private static func title(_ value: String) -> String {
        switch value {
        case "all": return "Все источники"
        case "local": return "Моя музыка"
        case "ytmusic": return "YouTube Music"
        case "youtube": return "YouTube"
        case "soundcloud": return "SoundCloud"
        default: return "Яндекс Музыка"
        }
    }
    private static func shortTitle(_ value: String) -> String {
        switch value {
        case "all": return "Все"
        case "local": return "Медиатека"
        case "ytmusic": return "YouTube Music"
        case "youtube": return "YouTube"
        case "soundcloud": return "SoundCloud"
        default: return "Яндекс"
        }
    }
    private var filters: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(availableSourceChips, id: \.self) { value in
                            let selected = store.searchSource == value
                            Button {
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                if reduceMotion { store.pickSearchSource(value) }
                                else { withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) { store.pickSearchSource(value) } }
                            } label: {
                                Text(Self.shortTitle(value))
                                    .font(.subheadline.weight(selected ? .semibold : .medium))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                                    .foregroundStyle(selected ? Color.moraBackground : .white.opacity(0.85))
                                    .background(selected ? Color.moraMint : Color.moraSurface, in: Capsule())
                                    .overlay(Capsule().stroke(selected ? Color.clear : Color.white.opacity(0.1), lineWidth: 0.75))
                            }
                            .buttonStyle(MoraPressStyle())
                            .accessibilityAddTraits(selected ? .isSelected : [])
                        }
                    }
                }
                .accessibilityIdentifier("search.source")

                if source == "yandex" {
                    let scopes: [(String, String)] = [("all", "Всё"), ("track", "Треки"), ("artist", "Артисты"), ("album", "Альбомы")]
                    HStack(spacing: 8) {
                        ForEach(scopes, id: \.0) { value, label in
                            let selected = store.searchScope == value
                            Button {
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                if reduceMotion { store.searchScope = value }
                                else { withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) { store.searchScope = value } }
                            } label: {
                                Text(label)
                                    .font(.caption.weight(selected ? .bold : .semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 7)
                                    .foregroundStyle(selected ? Color.moraMint : .white.opacity(0.75))
                                    .background(selected ? Color.moraMint.opacity(0.18) : Color.moraSurface, in: Capsule())
                                    .overlay(Capsule().stroke(selected ? Color.moraMint.opacity(0.45) : Color.white.opacity(0.08), lineWidth: 0.75))
                            }
                            .buttonStyle(MoraPressStyle())
                            .accessibilityAddTraits(selected ? .isSelected : [])
                        }
                    }
                    .accessibilityIdentifier("search.scope")
                }
            }
            .padding(.vertical, 2)
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
    @ViewBuilder private var history: some View {
        if !recent.isEmpty {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(recent, id: \.self) { text in
                            HStack(spacing: 6) {
                                Button {
                                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                    store.searchQuery = text
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: "clock")
                                            .font(.caption2)
                                            .foregroundStyle(.white.opacity(0.55))
                                        Text(text)
                                            .font(.subheadline)
                                            .foregroundStyle(.white)
                                            .lineLimit(1)
                                    }
                                    .padding(.leading, 12)
                                    .padding(.vertical, 8)
                                }
                                .buttonStyle(.plain)
                                Button {
                                    if reduceMotion {
                                        recent.removeAll { $0 == text }
                                        saveRecent()
                                    } else {
                                        withAnimation(.easeOut(duration: 0.18)) {
                                            recent.removeAll { $0 == text }
                                            saveRecent()
                                        }
                                    }
                                } label: {
                                    Image(systemName: "xmark")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.white.opacity(0.45))
                                        .padding(.trailing, 10)
                                        .padding(.vertical, 8)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Удалить \(text)")
                            }
                            .background(Color.moraSurfaceElevated, in: Capsule())
                            .overlay(Capsule().stroke(Color.white.opacity(0.08), lineWidth: 0.75))
                        }
                    }
                    .padding(.vertical, 2)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } header: {
                HStack {
                    Text("Недавно искали")
                    Spacer()
                    Button("Очистить") {
                        if reduceMotion { recent = []; saveRecent() }
                        else { withAnimation(.easeOut(duration: 0.2)) { recent = []; saveRecent() } }
                    }
                    .font(.caption.weight(.medium))
                }
            }
        }
    }
    private var browseGrid: some View {
        let cards: [(title: String, symbol: String, path: String, gold: Bool)] = [
            ("Любимое", "heart.fill", "/liked", false),
            ("Плейлисты", "music.note.list", "/library/playlists", false),
            ("Артисты", "music.mic", "/library/artists", true),
            ("Альбомы", "square.stack", "/library/albums", true),
        ]
        return Section {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(cards, id: \.path) { card in
                    let accent = card.gold ? Color.moraGold : Color.moraMint
                    Button { store.go(card.path) } label: {
                        ZStack(alignment: .bottomLeading) {
                            LinearGradient(colors: [accent.opacity(0.2), Color.moraSurface], startPoint: .topLeading, endPoint: .bottomTrailing)
                            Image(systemName: card.symbol)
                                .font(.system(size: 32, weight: .semibold))
                                .foregroundStyle(accent.opacity(0.28))
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                                .padding(12)
                            Text(card.title)
                                .font(.headline.bold())
                                .foregroundStyle(.white)
                                .padding(12)
                        }
                        .frame(height: 76)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.75))
                    }
                    .buttonStyle(MoraPressStyle())
                }
            }
            .padding(.top, 4)
        } header: {
            Text("Обзор")
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
    private var localSection: some View {
        let matches = local
        return Section("Моя музыка") {
            if matches.isEmpty { Text("Ничего не найдено").foregroundStyle(.secondary) }
            ForEach(Array(matches.prefix(source == "all" ? 4 : matches.count).enumerated()), id: \.element.id) { index, track in
                NativeTrackRow(track: track) { remember(); store.play(matches, at: index, type: "search", label: query) }
            }
            if source == "all" && matches.count > 4 { Button("Все треки медиатеки") { store.pickSearchSource("local") } }
        }
    }
    private func remoteSection(_ value: String) -> some View {
        let isBusy = searching.contains(value)
        let found = results[value]
        return Section {
            if let error = errors[value] {
                Text(error).font(.footnote).foregroundStyle(.secondary)
                Button("Повторить") { retry(value) }
                    .listRowBackground(Color.clear)
            }
            if isBusy && found == nil {
                MoraSearchSkeleton(rows: 5)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let found {
                if found.isEmpty && !isBusy {
                    Text("Ничего не найдено")
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
                let shownTracks = Array(found.tracks.prefix(source == "all" ? 6 : found.tracks.count))
                let shownArtists = Array(found.artists.prefix(source == "all" ? 6 : found.artists.count))
                let shownAlbums = Array(found.albums.prefix(source == "all" ? 6 : found.albums.count))

                // Tracks ALWAYS come first when present.
                if !shownTracks.isEmpty {
                    if source == "yandex" && scope == "all" && (!shownArtists.isEmpty || !shownAlbums.isEmpty) {
                        Text(query.isEmpty ? "Ваши треки" : "Треки")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.65))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                    ForEach(shownTracks) { item in hitRow(item, source: value, session: found.session) }
                }

                if !shownArtists.isEmpty {
                    if value == "yandex" && scope == "artist" {
                        ForEach(shownArtists) { item in linkRow(item, symbol: "music.mic") }
                    } else {
                        artistsShelf(shownArtists)
                    }
                }

                if !shownAlbums.isEmpty {
                    if value == "yandex" && scope == "album" {
                        ForEach(shownAlbums) { item in linkRow(item, symbol: "square.stack") }
                    } else {
                        albumsShelf(shownAlbums)
                    }
                }

                if source == "all" && (!found.artists.isEmpty || !found.albums.isEmpty || found.tracks.count > 6) {
                    Button("Все результаты · " + Self.title(value)) { store.pickSearchSource(value) }
                        .foregroundStyle(Color.moraMint)
                        .listRowBackground(Color.clear)
                } else if source == "yandex" && found.more {
                    Button(isBusy ? "Загружаем…" : "Показать ещё") { retry(value, more: true) }
                        .disabled(isBusy)
                        .foregroundStyle(Color.moraMint)
                        .listRowBackground(Color.clear)
                }
            }
        } header: {
            HStack(spacing: 8) {
                Text(value == "yandex" && query.isEmpty ? "Недавно понравилось в Яндексе" : Self.title(value))
                Spacer()
                if isBusy && found != nil {
                    ProgressView().controlSize(.small).tint(.moraMint)
                }
            }
        }
    }
    private func artistsShelf(_ items: [NativeCatalogLink]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Исполнители")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white.opacity(0.65))
                .padding(.horizontal, 16)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(items) { item in
                        Button {
                            remember()
                            store.openCatalog(item.path, title: item.title, detail: item.detail, cover: item.cover, isArtist: true)
                        } label: {
                            VStack(spacing: 7) {
                                NativeCover(url: item.cover, size: 78, radius: 39, monogram: item.title)
                                    .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 1))
                                    .shadow(color: .black.opacity(0.35), radius: 8, y: 4)
                                Text(item.title)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                    .frame(width: 84)
                            }
                        }
                        .buttonStyle(MoraPressStyle())
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
            }
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 0, bottom: 8, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
    private func albumsShelf(_ items: [NativeCatalogLink]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Альбомы")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white.opacity(0.65))
                .padding(.horizontal, 16)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(items) { item in
                        Button {
                            remember()
                            store.openCatalog(item.path, title: item.title, detail: item.detail, cover: item.cover, isArtist: false)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                NativeCover(url: item.cover, size: 126, radius: 12, monogram: item.title)
                                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.09), lineWidth: 0.75))
                                    .shadow(color: .black.opacity(0.32), radius: 8, y: 4)
                                Text(item.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                Text(item.detail.isEmpty ? "Альбом" : item.detail)
                                    .font(.caption)
                                    .foregroundStyle(.white.opacity(0.55))
                                    .lineLimit(1)
                            }
                            .frame(width: 126, alignment: .leading)
                        }
                        .buttonStyle(MoraPressStyle())
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
            }
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 0, bottom: 10, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
    private func linkRow(_ item: NativeCatalogLink, symbol: String) -> some View {
        let isArtist = symbol == "music.mic"
        return Button {
            remember()
            store.openCatalog(item.path, title: item.title, detail: item.detail, cover: item.cover, isArtist: isArtist)
        } label: {
            HStack(spacing: 12) {
                NativeCover(url: item.cover, size: isArtist ? 52 : 48, radius: isArtist ? 26 : 8, monogram: item.title)
                    .overlay(Group {
                        if isArtist { Circle().stroke(Color.white.opacity(0.16), lineWidth: 1) }
                        else { RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.75) }
                    })
                    .shadow(color: .black.opacity(isArtist ? 0.3 : 0), radius: 5, y: 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).fontWeight(.semibold).lineLimit(1)
                    Text(item.detail.isEmpty && isArtist ? "Исполнитель" : item.detail)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
            }.frame(minHeight: 58).contentShape(Rectangle())
        }.buttonStyle(MoraRowPressStyle()).listRowBackground(Color.clear)
    }
    @ViewBuilder private func hitContextButtons(_ track: NativeTrack, _ hit: NativeSearchHit, _ source: String, _ session: String) -> some View {
        actionButton("Играть следующим", "text.line.first.and.arrowtriangle.forward", "next", track, source, session)
        actionButton("В очередь", "text.append", "queue", track, source, session)
        actionButton(track.liked ? "Убрать лайк" : "Нравится", "heart", "like", track, source, session)
        actionButton(track.reaction < 0 ? "Убрать дизлайк" : "Не нравится", "hand.thumbsdown", "dislike", track, source, session)
        if !hit.saved { actionButton("Сохранить в медиатеку", "plus", "save", track, source, session) }
        if !store.playlists.isEmpty {
            Menu("В плейлист", systemImage: "music.note.list") {
                ForEach(store.playlists) { playlist in Button(playlist.name) { act("playlist", track: track, source: source, session: session, playlist: playlist.id) } }
            }
        }
        actionButton("Скачать", "arrow.down.circle", "download", track, source, session)
        actionButton("Другая версия", "arrow.triangle.swap", "versions", track, source, session)
        actionButton("Исполнитель", "music.mic", "artist", track, source, session)
        if !track.album.isEmpty { actionButton("Альбом", "square.stack", "album", track, source, session) }
        actionButton("Радио по треку", "dot.radiowaves.left.and.right", "radio", track, source, session)
    }
    private func hitRow(_ hit: NativeSearchHit, source: String, session: String) -> some View {
        let track = hit.track
        let provider = track.provider.isEmpty ? (source == "yandex" ? "yandex" : source == "soundcloud" ? "soundcloud" : "youtube") : track.provider
        let localTrackId = store.localCatalogTrack(provider: provider, externalId: track.id)?.trackId
        let isActive = store.isCurrentTrack(localTrackId ?? track.id)
        let isLoading = loadingTrackId == track.id
        return HStack(spacing: 8) {
            Button { act("play", track: track, source: source, session: session) } label: {
                HStack(spacing: 12) {
                    NativeCover(url: track.cover, size: 48, radius: 8, monogram: track.title)
                        .overlay {
                            if isLoading {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(Color.black.opacity(0.55))
                                    .overlay { ProgressView().controlSize(.small).tint(.moraMint) }
                            } else if isActive {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(Color.black.opacity(0.45))
                                    .overlay { NativePlayingIndicator(playing: store.miniPlaying) }
                            }
                        }
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 0.75))
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            Text(track.title)
                                .font(.body.weight(.medium))
                                .foregroundStyle(isActive || isLoading ? Color.moraMint : .white)
                                .lineLimit(1)
                            if hit.explicit {
                                Text("E").font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(.white.opacity(0.75))
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(Color.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                            }
                        }
                        Text(track.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        if !hit.tags.isEmpty { Text(hit.tags).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    Spacer(minLength: 0)
                    if track.liked { Image(systemName: "heart.fill").font(.caption).foregroundStyle(Color.moraMint) }
                    if hit.saved { Image(systemName: "checkmark").font(.caption).foregroundStyle(.secondary) }
                    Text(NativePlayerTime.text(track.duration)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }.frame(minHeight: 56).contentShape(Rectangle()).opacity(track.ok ? 1 : 0.45)
            }
            .buttonStyle(MoraRowPressStyle()).disabled(!track.ok)
            Menu {
                hitContextButtons(track, hit, source, session)
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(.white.opacity(0.55))
                    .frame(width: 32, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Действия с треком")
        }
        .listRowBackground(Color.clear)
        .contextMenu {
            hitContextButtons(track, hit, source, session)
        }
        .swipeActions(edge: .leading) { actionButton("Следующим", "text.line.first.and.arrowtriangle.forward", "next", track, source, session).tint(.moraMint) }
        .swipeActions(edge: .trailing) { actionButton(track.liked ? "Убрать лайк" : "Нравится", "heart", "like", track, source, session).tint(.moraGold) }
        .accessibilityLabel(track.title + ", " + track.artist)
    }
    private func actionButton(_ title: String, _ symbol: String, _ kind: String, _ track: NativeTrack, _ source: String, _ session: String) -> some View {
        Button { act(kind, track: track, source: source, session: session) } label: { Label(title, systemImage: symbol) }
    }
    private func act(_ kind: String, track: NativeTrack, source: String, session: String, playlist: String? = nil) {
        let isPlay = kind == "play"
        if !isPlay, busy { return }
        remember()
        if isPlay {
            playGeneration &+= 1
            loadingTrackId = track.id
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } else { busy = true }
        let generation = playGeneration
        let requested = key, origin = store.path
        Task { @MainActor in
            defer {
                if !isPlay { busy = false }
                else if loadingTrackId == track.id && generation == playGeneration { loadingTrackId = nil }
            }
            do {
                if store.sharedLibrary, store.catalog.searchSession(session) != nil {
                    let res = try await store.executeNativeSearchAction(kind: kind, trackId: track.id, sessionId: session, playlist: playlist)
                    if isPlay, generation != playGeneration { return }
                    guard key == requested, store.path == origin else { return }
                    if let path = res.go { store.go(path) }
                    if let id = res.versions { store.presentSearchVersions(id: id) }
                    if let updated = res.updated { results[source] = updated }
                    return
                }
                var args: [String: Any] = ["kind": kind, "id": track.id, "session": session]
                if let playlist { args["playlist"] = playlist }
                let value = try await store.call("searchAction", args, timeout: 180) as? [String: Any]
                if isPlay, generation != playGeneration { return }
                guard key == requested, store.path == origin else { return }
                if let path = value?["go"] as? String { store.go(path) }
                if let id = value?["versions"] as? String { store.presentVersions(id: id) }
                if ["like", "dislike", "save", "playlist"].contains(kind) { await load(source, key: key) }
            } catch {
                guard key == requested, store.path == origin else { return }
                if isPlay, (generation != playGeneration || NativeShellStore.isCancelled(error)) { return }
                failure = Self.message(error)
            }
        }
    }
    private func remember() {
        guard !query.isEmpty else { return }
        recent = [query] + Array(recent.filter { $0 != query }.prefix(11)); saveRecent()
    }
    private func saveRecent() { UserDefaults.standard.set(recent, forKey: "mora.nativeSearchRecent") }
    private func retry(_ source: String, more: Bool = false) { Task { @MainActor in await load(source, key: key, more: more) } }
    @MainActor private func search() async {
        errors = [:]
        if store.offline || source == "local" || (query.isEmpty && source != "yandex") || (source == "yandex" && !store.ui.wave.yandex) {
            results = [:]; searching = []
            return
        }
        let active = Set(sources)
        results = results.filter { active.contains($0.key) }
        searching = []
        let requested = key
        await withTaskGroup(of: Void.self) { group in
            for source in sources { group.addTask { @MainActor in await load(source, key: requested) } }
        }
    }
    @MainActor private func load(_ source: String, key requested: String, more: Bool = false) async {
        guard key == requested, !searching.contains(source) else { return }
        searching.insert(source); errors[source] = nil
        defer { if key == requested && !Task.isCancelled { searching.remove(source) } }
        do {
            let value: Any?
            if store.sharedLibrary && source == "yandex" {
                value = try await store.catalog.searchYandex(
                    query: query,
                    scope: scope,
                    more: more,
                    previousSession: more ? results[source]?.session : nil,
                    request: { try await NativeServerApp.request($0, $1, body: $2, timeout: 60) },
                    localLookup: { store.localCatalogTrack(provider: $0, externalId: $1) }
                )
            } else if store.sharedLibrary && Self.publicSources.contains(source) {
                value = try await store.catalog.searchPublic(
                    source: source,
                    query: query,
                    request: { try await NativeServerApp.request($0, $1, body: $2, timeout: 60) },
                    localLookup: { store.localCatalogTrack(provider: $0, externalId: $1) }
                )
            } else {
                var args: [String: Any] = ["source": source, "q": query, "scope": source == "yandex" ? scope : "all", "more": more]
                if more { args["session"] = results[source]?.session }
                value = try await store.call("search", args, timeout: 60)
            }
            guard key == requested, !Task.isCancelled else { return }
            guard let found = NativeSearchResults(value) else { throw NativeShellError.page }
            if reduceMotion { results[source] = found }
            else { withAnimation(.easeOut(duration: 0.18)) { results[source] = found } }
        } catch { if key == requested && !Task.isCancelled { errors[source] = Self.message(error) } }
    }
    private static func message(_ error: Error) -> String { (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription }
}

// MARK: «Ещё»

/// Grouped list of the app's other sections (native pages, NativePages.swift).
struct NativeMoreView: View {
    @EnvironmentObject private var store: NativeShellStore

    var body: some View {
        NavigationStack {
            List {
                Section("Музыка") {
                    link("/wave", "Моя волна", "Бесконечный поток под ваше настроение", "waveform", tint: .moraMint)
                    link("/history", "История", "Что звучало и как сменялись треки", "clock.arrow.circlepath", tint: .moraGold)
                    link("/statistics", "Статистика", "Музыка за последние 30 дней", "chart.bar.fill", tint: .moraGold)
                    link("/duplicates", "Дубликаты", "Объединить одинаковые файлы", "square.on.square", tint: .moraMint)
                    link("/smart-playlists", "Умные плейлисты", "Подборки по вашим правилам", "sparkles", tint: .moraGold)
                    link("/downloads", "Загрузки", "Музыка на этом iPhone", "arrow.down.circle.fill", tint: .moraMint)
                    link("/import", "Импорт", "Плейлисты из Spotify, Apple Music, YouTube", "square.and.arrow.down.fill", tint: .moraGold)
                }
                if !store.playlists.isEmpty {
                    Section("Плейлисты") {
                        ForEach(store.playlists) { p in
                            link("/playlist/\(p.id)", p.name, NativeText.tracks(p.count), "music.note.list", tint: .moraMint)
                        }
                    }
                }
                Section("Приложение") {
                    link("/sources", "Яндекс Музыка", "Аккаунт и синхронизация лайков", "person.crop.circle.fill", tint: .moraGold)
                    link("/settings", "Настройки", "Переходы, громкость и офлайн", "gearshape.fill", tint: .moraMint)
                    link("/sound", "Звук", "Эквалайзер и пресеты", "slider.vertical.3", tint: .moraMint)
                    link("/diagnostics", "Диагностика AutoMix", "Всё ли в порядке со звуком и переходами", "waveform.path.ecg", tint: .moraGold)
                }
                Section {
                    Button { store.setShown(false) } label: {
                        HStack(spacing: 14) {
                            NativeIconBadge(symbol: "globe", size: 32, tint: .moraMint)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Перейти на веб-интерфейс").foregroundStyle(.white)
                                Text("Откроет полную веб-версию плеера").font(.footnote).foregroundStyle(.white.opacity(0.55))
                            }
                            Spacer()
                            Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35))
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .listRowBackground(Color.moraSurface)
                } footer: {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Вернуть нативный интерфейс можно в «Ещё» веб-версии.\nMORA \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
                        Color.clear.frame(height: 56)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .navigationTitle("Ещё")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { store.go("/") } label: { Label("Главная", systemImage: "chevron.backward") }
                        .accessibilityLabel("Назад, на главную")
                }
            }
        }
    }

    private func link(_ path: String, _ title: String, _ hint: String, _ symbol: String, tint: Color = .moraMint) -> some View {
        Button { store.go(path) } label: {
            HStack(spacing: 14) {
                NativeIconBadge(symbol: symbol, size: 32, tint: tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(.medium)).foregroundStyle(.white)
                    Text(hint).font(.footnote).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.35))
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(hint)
        .listRowBackground(Color.moraSurface)
    }
}


struct NativeLibraryView: View {
    @EnvironmentObject private var store: NativeShellStore

    private static func encoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? value
    }

    private static func primaryArtist(_ raw: String) -> String {
        let separated = raw.replacingOccurrences(of: #"\s*[,;]\s*|\s+(?:feat\.?|ft\.?)\s+"#, with: "\u{1}", options: [.regularExpression, .caseInsensitive])
        let first = separated.split(separator: "\u{1}").first.map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        return first.isEmpty ? raw.trimmingCharacters(in: .whitespacesAndNewlines) : first
    }

    private var likedArtists: [NativeTrack] {
        var seen = Set<String>()
        return store.liked.filter {
            let trimmed = $0.artist.trimmingCharacters(in: .whitespacesAndNewlines)
            return !trimmed.isEmpty && seen.insert(trimmed.lowercased()).inserted
        }
        .sorted { $0.artist.localizedCaseInsensitiveCompare($1.artist) == .orderedAscending }
    }

    private var artistCount: Int {
        Set(store.library.map { $0.artist.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }).count
    }

    private var albumCount: Int {
        Set(store.library.map { $0.album.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }).count
    }

    private var offlineCount: Int {
        store.library.filter(\.offline).count
    }

    private var recentTracks: [(offset: Int, element: NativeTrack)] {
        Array(store.library.prefix(12).enumerated())
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    destination("Любимое", "heart.fill", "/liked", count: store.liked.count)
                    destination("Плейлисты", "music.note.list", "/library/playlists", count: store.playlists.count)
                    destination("Артисты", "music.mic", "/library/artists", count: artistCount)
                    destination("Альбомы", "square.stack.fill", "/library/albums", count: albumCount)
                    destination("Песни", "music.note", "/library/tracks", count: store.library.count)
                    destination("Загруженные", "arrow.down.circle.fill", "/downloads", count: offlineCount)
                }
                .listSectionSeparator(.hidden)

                if !likedArtists.isEmpty {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(alignment: .top, spacing: 14) {
                                ForEach(likedArtists) { track in
                                    Button { store.go("/artist/\(Self.encoded(Self.primaryArtist(track.artist)))") } label: {
                                        VStack(spacing: 8) {
                                            NativeCover(url: track.cover, size: 78, radius: 39, monogram: track.artist)
                                                .overlay(Circle().stroke(Color.white.opacity(0.14), lineWidth: 1))
                                                .shadow(color: .black.opacity(0.32), radius: 8, y: 4)
                                            Text(track.artist)
                                                .font(.caption.weight(.semibold))
                                                .foregroundStyle(.white)
                                                .lineLimit(1)
                                                .frame(width: 80)
                                        }
                                    }
                                    .buttonStyle(MoraPressStyle())
                                    .accessibilityLabel(track.artist)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .scrollClipDisabled()
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 10, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    } header: {
                        HStack {
                            Text("Любимые артисты").font(.title3.bold()).foregroundStyle(.white).textCase(nil)
                            Spacer()
                            Button { store.go("/library/artists") } label: {
                                HStack(spacing: 4) { Text("Все"); Image(systemName: "chevron.forward").font(.caption.weight(.bold)) }
                                    .font(.subheadline.weight(.medium)).foregroundStyle(Color.moraMint)
                            }
                        }
                    }
                }

                if !recentTracks.isEmpty {
                    Section {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 18) {
                            ForEach(recentTracks, id: \.element.id) { index, track in
                                Button { store.play(store.library, at: index, type: "library", label: "Медиатека") } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        NativeCover(url: track.cover, radius: 12, monogram: track.title, aspectSquare: true)
                                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.09), lineWidth: 0.75))
                                            .shadow(color: .black.opacity(0.32), radius: 8, y: 4)
                                        Text(track.title)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.white)
                                            .lineLimit(1)
                                        Text(track.artist)
                                            .font(.caption)
                                            .foregroundStyle(.white.opacity(0.55))
                                            .lineLimit(1)
                                    }
                                }
                                .buttonStyle(MoraPressStyle())
                                .accessibilityElement(children: .combine)
                                .accessibilityHint("Играть")
                                .contextMenu { NativeTrackActions(track: track, play: { store.play(store.library, at: index, type: "library", label: "Медиатека") }) }
                            }
                        }
                        .padding(.top, 4)
                        .padding(.bottom, 72)
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 16, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    } header: {
                        HStack {
                            Text("Недавно добавлено").font(.title3.bold()).foregroundStyle(.white).textCase(nil)
                            Spacer()
                            Button { store.go("/library/tracks") } label: {
                                HStack(spacing: 4) { Text("Все"); Image(systemName: "chevron.forward").font(.caption.weight(.bold)) }
                                    .font(.subheadline.weight(.medium)).foregroundStyle(Color.moraMint)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .navigationTitle("Медиатека")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { store.go("/more") } label: {
                        Image(systemName: "ellipsis.circle").foregroundStyle(.white.opacity(0.85))
                    }
                    .accessibilityLabel("Ещё и настройки")
                }
            }
        }
    }

    private func destination(_ title: String, _ symbol: String, _ path: String, count: Int) -> some View {
        Button { store.go(path) } label: {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Color.moraMint)
                    .frame(width: 28, height: 28)
                Text(title).font(.body.weight(.medium)).foregroundStyle(.white)
                Spacer()
                if count > 0 {
                    Text("\(count)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.white.opacity(0.45))
                }
                Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.32))
            }
            .frame(minHeight: 42)
            .contentShape(Rectangle())
        }
        .buttonStyle(MoraRowPressStyle())
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Color.white.opacity(0.08))
    }
}
