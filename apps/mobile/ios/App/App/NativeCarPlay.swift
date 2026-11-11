import CarPlay
import Combine
import UIKit

/// CarPlay (audio app): «Волна», «Любимое» and «Загрузки» tabs, then the system Now Playing screen,
/// which the native host already feeds (MPNowPlayingInfoCenter, remote commands).
/// CarPlay lists the app only when the signature carries com.apple.developer.carplay-audio
/// (Apple grants it on request; see MORA_CARPLAY in scripts/ios-mac.sh).
/// Starting music goes through the page, which owns the queue and the wave. With WebContent suspended
/// (iPhone locked, app in the background) that can fail: CarPlay then asks to open MORA on the iPhone.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interface: CPInterfaceController?
    private var watch: AnyCancellable?
    private var waiting: Timer?
    private let wave = CPListTemplate(title: "Волна", sections: [])
    private let liked = CPListTemplate(title: "Любимое", sections: [])
    private let offline = CPListTemplate(title: "Загрузки", sections: [])
    private let resume = CPListTemplate(title: "Продолжить", sections: [])
    private let recent = CPListTemplate(title: "Недавние", sections: [])
    private var recentTracks: [NativeTrack] = []
    private var loadingRecent = false
    private static let thumbnails: NSCache<NSString, UIImage> = { let cache = NSCache<NSString, UIImage>(); cache.countLimit = 100; return cache }()

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        AppDelegate.backgroundLaunch = true
        interface = interfaceController
        wave.tabImage = UIImage(systemName: "waveform")
        liked.tabImage = UIImage(systemName: "heart.fill")
        offline.tabImage = UIImage(systemName: "arrow.down.circle.fill")
        resume.tabImage = UIImage(systemName: "play.circle.fill")
        recent.tabImage = UIImage(systemName: "clock")
        interfaceController.setRootTemplate(CPTabBarTemplate(templates: [resume, wave, liked, offline, recent]), animated: false, completion: nil)
        attach()
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        interface = nil; watch = nil
        waiting?.invalidate(); waiting = nil
    }

    /// The shell exists once the iPhone scene has loaded the page; until then the lists say so.
    private func attach() {
        reload()
        guard let store = NativeShellStore.shared else {
            waiting = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.attach() }
            return
        }
        watch = store.$library.map { _ in () }
            .merge(with: store.$ui.map(\.wave).removeDuplicates().map { _ in () })
            .merge(with: store.$offline.removeDuplicates().map { _ in () })
            .merge(with: store.$player.map { "\($0.trackId)|\($0.playing)" }.removeDuplicates().map { _ in () })
            .debounce(for: .seconds(1), scheduler: RunLoop.main)
            .sink { [weak self] in self?.reload() }
    }

    private func reload() {
        if let snapshot = try? NativeStationFiles.load(), snapshot.tracks.indices.contains(snapshot.index) {
            let track = snapshot.tracks[snapshot.index]
            let item = CPListItem(text: track.title, detailText: track.artist, image: UIImage(systemName: "play.circle.fill"))
            item.handler = { [weak self] _, done in
                Task { @MainActor in
                    do { try await StationStarter.start(); self?.showNowPlaying() }
                    catch { self?.askToOpen() }
                    done()
                }
            }
            resume.updateSections([CPListSection(items: [item])])
        } else {
            resume.updateSections([CPListSection(items: [CPListItem(text: "Начните слушать в MORA", detailText: "Здесь появится последняя станция")])])
        }
        guard let store = NativeShellStore.shared else {
            let hint = CPListSection(items: [CPListItem(text: "Откройте MORA на iPhone", detailText: "Медиатека загрузится за пару секунд")])
            [wave, liked, offline, recent].forEach { $0.updateSections([hint]) }
            return
        }
        let current = store.ui.wave
        wave.updateSections([CPListSection(items: NativeWaveSource.allCases.map { source in
            let state = current.active == source ? (current.playing ? "Играет" : "На паузе") : nil
            let item = CPListItem(text: Self.title(source), detailText: state, image: UIImage(systemName: source == .online ? "dot.radiowaves.left.and.right" : "waveform"))
            item.handler = { [weak self] _, done in self?.startWave(source); done() }
            return item
        })])
        liked.updateSections([tracks(store.liked, type: "liked", label: "Любимое")])
        offline.updateSections([tracks(store.library.filter(\.offline), type: "library", label: "Загрузки")])
        recent.updateSections([tracks(recentTracks, type: "history", label: "Недавние")])
        if !loadingRecent, UIApplication.shared.applicationState == .active {
            loadingRecent = true
            Task { @MainActor [weak self] in
                guard let self else { return }
                defer { self.loadingRecent = false }
                if let rows = try? await store.call("recent", timeout: 5) as? [[String: Any]] {
                    self.recentTracks = rows.compactMap(NativeTrack.init)
                    self.recent.updateSections([self.tracks(self.recentTracks, type: "history", label: "Недавние")])
                }
            }
        }
    }

    private static func title(_ source: NativeWaveSource) -> String {
        switch source {
        case .own: return "Моя коллекция"
        case .online: return "Онлайн-радио"
        case .yandex: return "Яндекс Музыка"
        }
    }

    private func tracks(_ list: [NativeTrack], type: String, label: String) -> CPListSection {
        let shown = Array(list.filter(\.ok).prefix(CPListTemplate.maximumItemCount))
        guard !shown.isEmpty else { return CPListSection(items: [CPListItem(text: "Здесь пока пусто", detailText: nil)]) }
        return CPListSection(items: shown.enumerated().map { index, track in
            let store = NativeShellStore.shared
            let current = store?.player.trackId == track.id || store?.ui.now?.id == track.id
            let state = current ? (store?.miniPlaying == true ? "Играет" : "На паузе") : nil
            let detail = [track.artist, track.album, store?.offline == true ? "Нет сети" : "", track.offline ? "Без сети" : "", state ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
            let item = CPListItem(text: track.title, detailText: detail, image: UIImage(systemName: "music.note"))
            item.isPlaying = current && store?.miniPlaying == true
            if let cover = track.cover {
                if let image = Self.thumbnails.object(forKey: cover as NSString) { item.setImage(image) }
                else {
                    Task { @MainActor [weak item] in
                        if let image = await NativeCovers.image(cover), let thumbnail = await image.byPreparingThumbnail(ofSize: CGSize(width: 40, height: 40)) {
                            Self.thumbnails.setObject(thumbnail, forKey: cover as NSString)
                            item?.setImage(thumbnail)
                        }
                    }
                }
            }
            item.handler = { [weak self] _, done in self?.play(shown, at: index, type: type, label: label); done() }
            return item
        })
    }

    private func play(_ list: [NativeTrack], at index: Int, type: String, label: String) {
        guard let store = NativeShellStore.shared else { askToOpen(); return }
        Task { @MainActor in
            do {
                _ = try await store.call("play", ["ids": list.map(\.id), "index": index, "type": type, "label": label], timeout: 8)
                showNowPlaying()
            } catch { askToOpen() }
        }
    }

    private func startWave(_ source: NativeWaveSource) {
        Task { @MainActor in
            guard let store = NativeShellStore.shared, UIApplication.shared.applicationState == .active else {
                do { try await StationStarter.start(source: source.rawValue); showNowPlaying() }
                catch {
                    do { try await StationStarter.start(); showNowPlaying() } catch { askToOpen(); return }
                    askToOpen("Откройте MORA, чтобы выбрать другую волну")
                }
                return
            }
            let current = store.ui.wave
            // The page's `wave` command toggles a playing wave: only show what already plays.
            if !(current.active == source && current.playing) {
                do { _ = try await store.call("wave", ["source": source.rawValue], timeout: 8) } catch { askToOpen(); return }
            }
            showNowPlaying()
        }
    }

    private func showNowPlaying() {
        guard let interface, interface.topTemplate !== CPNowPlayingTemplate.shared else { return }
        interface.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
    }

    private func askToOpen(_ message: String = "Откройте MORA на iPhone, чтобы начать") {
        guard let interface, interface.presentedTemplate == nil else { return }
        let ok = CPAlertAction(title: "Понятно", style: .cancel) { [weak interface] _ in interface?.dismissTemplate(animated: true, completion: nil) }
        interface.presentTemplate(CPAlertTemplate(titleVariants: [message], actions: [ok]), animated: true, completion: nil)
    }
}
