import Combine
import MediaPlayer
import SwiftUI
import UIKit
import WebKit

/// iPhone app root: the Capacitor web view with the native SwiftUI shell over it.
/// Three layers: the WKWebView (always in the window, so the page keeps running), the native screens
/// (hidden on routes that stay web) and the floating tab bar with the mini player.
/// Hidden layers take no touches, so there is no pass-through hit testing.
final class MoraRootViewController: UITabBarController, UITabBarControllerDelegate {
    let bridge = MoraBridgeViewController()
    let shell = NativeShellStore()
    private var content: UIViewController?
    private var bar: UIViewController?
    private var observer: AnyCancellable?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Color.moraBackground)
        delegate = self
        tabBar.tintColor = UIColor(Color.moraMint)
        viewControllers = NativeTab.allCases.enumerated().map { index, tab in
            let page = UIViewController()
            page.view.backgroundColor = .clear
            page.tabBarItem = UITabBarItem(title: tab.item.0, image: UIImage(systemName: tab.item.1), tag: index)
            return page
        }
        if #available(iOS 26.0, *) { setTabBarHidden(true, animated: false) }
        else { tabBar.isHidden = true }
        embed(bridge, into: selectedViewController?.view)
        bridge.view.frame = selectedViewController?.view.bounds ?? view.bounds
        bridge.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }

    /// Built on the page's first snapshot: until then (and if it never comes) the app is the web UI.
    func installShell(host: NativeMixHost, webView: WKWebView?) {
        shell.host = host
        host.onReaction = { [weak shell] id, desired in
            guard let shell else { return 0 }
            let value = shell.reaction(id) == desired ? 0 : desired
            shell.react(id: id, value: value)
            return value
        }
        host.reactionState = { [weak shell] in shell?.reaction($0) ?? 0 }
        NativeShellStore.shared = shell
        shell.webView = webView
        guard content == nil else { return }
        let content = UIHostingController(rootView: NativeShellContent(store: shell))
        content.view.backgroundColor = UIColor(Color.moraBackground)
        content.overrideUserInterfaceStyle = .dark
        embed(content, into: selectedViewController?.view)
        content.view.frame = selectedViewController?.view.bounds ?? view.bounds
        content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        let bar = UIHostingController(rootView: NativeShellBar(store: shell))
        bar.view.backgroundColor = .clear
        bar.overrideUserInterfaceStyle = .dark
        bar.sizingOptions = [.intrinsicContentSize]
        bar.safeAreaRegions = []
        embed(bar)
        bar.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            bar.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.view.bottomAnchor.constraint(equalTo: tabBar.topAnchor, constant: -8),
        ])
        self.content = content
        self.bar = bar
        shell.presenter = self
        observer = shell.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.layoutShell() } }
        layoutShell()
    }

    private func embed(_ child: UIViewController, into container: UIView? = nil) {
        addChild(child)
        (container ?? view).addSubview(child.view)
        child.didMove(toParent: self)
    }

    private func layoutShell() {
        guard let content, let bar else { return }
        let visible = shell.shown && !shell.ui.overlay
        content.view.isHidden = !visible || shell.screen == .web
        bar.view.isHidden = !visible || shell.miniTitle == nil
        if #available(iOS 26.0, *) { setTabBarHidden(!visible, animated: false) }
        else { tabBar.isHidden = !visible }
        if let index = NativeTab.allCases.firstIndex(of: shell.tab), selectedIndex != index { selectedIndex = index }
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // One live WebView and native screen move together under the selected system tab.
        if let surface = selectedViewController?.view {
            let layers: [UIViewController?] = [bridge, content]
            for child in layers.compactMap({ $0 }) {
                if child.view.superview !== surface { surface.addSubview(child.view) }
                child.view.frame = surface.bounds
            }
        }
        view.bringSubviewToFront(tabBar)
        guard let content, let bar else { return }
        view.bringSubviewToFront(bar.view)
        let inset = bar.view.isHidden ? 0 : bar.view.frame.height + 8
        if content.additionalSafeAreaInsets.bottom != inset { content.additionalSafeAreaInsets.bottom = inset }
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        guard NativeTab.allCases.indices.contains(selectedIndex) else { return }
        shell.select(NativeTab.allCases[selectedIndex])
        view.setNeedsLayout()
    }

    override var childForStatusBarStyle: UIViewController? { bridge }
    override var childForStatusBarHidden: UIViewController? { bridge }
    override var childForHomeIndicatorAutoHidden: UIViewController? { bridge }
}

enum NativeShellError: LocalizedError {
    case page, timeout
    var errorDescription: String? { self == .timeout ? "Медиатека не отвечает" : "Медиатека ещё загружается" }
}

/// Native side of lib/native-ui.ts. The page owns the data; this keeps its last snapshot.
final class NativeShellStore: ObservableObject {
    static weak var shared: NativeShellStore?
    @Published private(set) var library: [NativeTrack] = [] { didSet { byId = Dictionary(library.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) } }
    private(set) var byId: [String: NativeTrack] = [:]
    /// Bumped on every snapshot: native pages reload their description from the page.
    @Published private(set) var revision = 0
    private(set) var queue: [NativeQueuedTrack] = []
    @Published private(set) var playlists: [NativePlaylist] = []
    @Published private(set) var ui = NativeUiState()
    /// The route on screen: the page's, or the one native just asked for (until the page confirms it).
    @Published private(set) var path = "/"
    @Published private(set) var shown = UserDefaults.standard.object(forKey: "mora.nativeShell") as? Bool ?? true
    @Published private(set) var player = NativePlayerState()
    @Published private(set) var artwork: UIImage?
    @Published var banner: String?
    weak var webView: WKWebView?
    weak var presenter: UIViewController?
    var host: NativeMixHost?
    private var timer: Timer?
    private var artworkKey = ""
    private var bannerTask: DispatchWorkItem?
    private var reactions = NativeReactionOutbox()
    private var sendingReactions = false
    private var sheetOpen = false
    private var pending: (path: String, at: Date)?

    var screen: NativeScreen { NativeRoute.screen(path) }
    var tab: NativeTab { NativeRoute.tab(path) }
    var liked: [NativeTrack] { NativeTrack.favorites(library) }

    init() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.stopPolling() }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.startPolling(); self?.flushReactions() }
    }

    /// A snapshot from the page (main thread). Returns whether the shell is on screen.
    func receive(_ value: [String: Any]) -> Bool {
        if value["enable"] as? Bool == true { setShown(true, resync: false) }
        if let rows = value["library"] as? [[String: Any]] { library = rows.compactMap(NativeTrack.init) }
        if let rows = value["playlists"] as? [[String: Any]] { playlists = rows.compactMap(NativePlaylist.init) }
        if let rows = value["queue"] as? [[String: Any]] { queue = rows.compactMap(NativeQueuedTrack.init) }
        let next = NativeUiState(value)
        if next.toast != ui.toast, let toast = next.toast, screen != .web { show(toast.text) }
        if next != ui { ui = next }
        // A push sent before the page saw native's own navigation must not jump back.
        if let pending, pending.path != next.path, Date().timeIntervalSince(pending.at) < 2 {} else {
            pending = nil
            if path != next.path { path = next.path }
        }
        for (id, value) in reactions.pending {
            if let index = library.firstIndex(where: { $0.id == id }) { library[index].reaction = value }
        }
        flushReactions()
        revision &+= 1
        startPolling()
        return shown
    }

    func setShown(_ on: Bool, resync: Bool = true) {
        UserDefaults.standard.set(on, forKey: "mora.nativeShell")
        shown = on
        // The page shows or hides its own tab bar from the reply to its next push.
        if resync { run("resync") }
    }

    // MARK: page calls

    /// Runs `window.moraNativeUi(name, args)` in the page. Only works while WebContent runs, which is
    /// whenever the app is in the foreground; a timeout covers a page that is reloading.
    @MainActor func call(_ name: String, _ args: [String: Any] = [:], timeout: Double = 20) async throws -> Any? {
        guard let webView else { throw NativeShellError.page }
        return try await withCheckedThrowingContinuation { continuation in
            var done = false
            let finish: (Result<Any?, Error>) -> Void = { result in
                guard !done else { return }
                done = true
                continuation.resume(with: result)
            }
            webView.callAsyncJavaScript("if (!window.moraNativeUi) throw new Error('page'); return await window.moraNativeUi(name, args)",
                                        arguments: ["name": name, "args": args], in: nil, in: .page) { result in
                finish(result.map { $0 is NSNull ? nil : $0 })
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(.failure(NativeShellError.timeout)) }
        }
    }

    /// A command: its own errors reach the listener as the page's toasts.
    func run(_ name: String, _ args: [String: Any] = [:]) {
        if name == "versions", let id = args["id"] as? String, let track = byId[id] { presentVersions(track); return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { @MainActor in
            do { _ = try await call(name, args, timeout: 60) } catch let error as NativeShellError { show(error.localizedDescription) } catch {}
        }
    }

    func presentVersions(_ track: NativeTrack, from parent: UIViewController? = nil) {
        Task { @MainActor in
            guard let parent = parent ?? presenter?.presentedViewController ?? presenter, parent.presentedViewController == nil else { return }
            let controller = UIHostingController(rootView: NativeVersionView(track: track, store: self))
            controller.modalPresentationStyle = .pageSheet
            controller.sheetPresentationController?.prefersGrabberVisible = true
            controller.overrideUserInterfaceStyle = .dark
            parent.present(controller, animated: true)
        }
    }

    func go(_ path: String) {
        self.path = path.components(separatedBy: "?")[0]
        pending = (self.path, Date())
        run("go", ["path": path])
    }
    func select(_ tab: NativeTab) {
        UIAccessibility.post(notification: .screenChanged, argument: nil)
        go(NativeRoute.root(tab))
    }

    func play(_ list: [NativeTrack], at index: Int, type: String, label: String, id: String? = nil) {
        guard list.indices.contains(index), list[index].ok else { return }
        var args: [String: Any] = ["ids": list.map(\.id), "index": index, "type": type, "label": label]
        if let id { args["id"] = id }
        run("play", args)
    }
    /// The page's history: native pages sit on top of the route they were opened from.
    func back() {
        pending = nil
        run("back")
    }
    func queue(_ track: NativeTrack, next: Bool) { run("queue", ["ids": [track.id], "next": next]) }
    func react(_ track: NativeTrack, _ value: Int) {
        react(id: track.id, value: value)
    }
    func reaction(_ id: String) -> Int { reactions.pending[id] ?? byId[id]?.reaction ?? 0 }
    func react(id: String, value: Int) {
        guard !id.isEmpty, [-1, 0, 1].contains(value) else { return }
        reactions.set(id, value)
        if let index = library.firstIndex(where: { $0.id == id }) { library[index].reaction = value }
        flushReactions()
    }
    private func flushReactions() {
        guard !sendingReactions, UIApplication.shared.applicationState == .active, webView != nil, !reactions.pending.isEmpty else { return }
        sendingReactions = true
        Task { @MainActor in
            defer { sendingReactions = false }
            for (id, value) in reactions.pending {
                do {
                    _ = try await call("reactSaved", ["id": id, "value": value])
                    reactions.acknowledge(id, value)
                } catch { show("Реакция сохранена на iPhone. Синхронизация повторится при открытии приложения."); break }
            }
        }
    }

    func show(_ text: String) {
        banner = text
        UIAccessibility.post(notification: .announcement, argument: text)
        bannerTask?.cancel()
        let task = DispatchWorkItem { [weak self] in self?.banner = nil }
        bannerTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: task)
    }

    // MARK: mini player

    /// Native playback state, polled once a second while the app is in the foreground; the page's
    /// `now` stands in when the web engine plays.
    func startPolling() {
        guard timer == nil, UIApplication.shared.applicationState != .background else { return }
        refreshPlayer()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.refreshPlayer() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
    func stopPolling() { timer?.invalidate(); timer = nil }

    private func refreshPlayer() {
        guard let host, host.active else {
            if player.active { player = NativePlayerState(); artwork = nil; artworkKey = "" }
            return
        }
        host.playerState { [weak self] result in
            guard let self, case .success(let value) = result else { return }
            let next = NativePlayerState(value)
            if next.title != self.player.title || next.artist != self.player.artist || next.playing != self.player.playing || next.active != self.player.active {
                self.player = next
            }
            let key = "\(next.entryId)|\(next.artworkReady)"
            if key != self.artworkKey {
                self.artworkKey = key
                self.artwork = (value["artwork"] as? MPMediaItemArtwork)?.image(at: CGSize(width: 120, height: 120))
            }
        }
    }

    var nativePlaying: Bool { host?.active == true && player.active }
    var miniTitle: String? { nativePlaying ? player.title : ui.now?.title }
    var miniArtist: String { nativePlaying ? player.artist : ui.now?.artist ?? "" }
    var miniPlaying: Bool { nativePlaying ? player.playing : ui.now?.playing == true }

    func togglePlayback() {
        if nativePlaying, let host {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            let action = player.playing ? "pause" : "play"
            player.playing.toggle()
            host.command(action, source: "player") { [weak self] _ in self?.refreshPlayer() }
        } else { run("toggle") }
    }
    func next() {
        if nativePlaying, let host {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            host.command("nexttrack", source: "player") { [weak self] _ in self?.refreshPlayer() }
        } else { run("next") }
    }
    /// The stage-1 SwiftUI player while native playback runs; the web full player otherwise.
    func openPlayer() {
        guard nativePlaying, let host, let presenter, presenter.presentedViewController == nil, !sheetOpen else { run("player"); return }
        sheetOpen = true
        NativePlayerSheet.present(host: host, from: presenter) { [weak self] action in
            self?.sheetOpen = false
            if action == "more" { self?.run("player") }
        }
    }
}

/// Library covers come from the page (/api/... lives in its worker); remote ones over HTTPS.
enum NativeCovers {
    private static let cache: NSCache<NSString, UIImage> = { let c = NSCache<NSString, UIImage>(); c.countLimit = 400; return c }()
    @MainActor private static var loading: [String: Task<UIImage?, Never>] = [:]

    /// The page loads /api covers; the player sheet uses this without the shell's environment.
    @MainActor static func image(_ url: String) async -> UIImage? {
        if let image = cache.object(forKey: url as NSString) { return image }
        if let task = loading[url] { return await task.value }
        let task = Task<UIImage?, Never> { @MainActor in
            var data: Data?
            if url.hasPrefix("https://"), let remote = URL(string: url) {
                data = try? await URLSession.shared.data(from: remote).0
            } else if url.hasPrefix("/api/"), let store = NativeShellStore.shared, let base64 = try? await store.call("cover", ["url": url]) as? String {
                data = Data(base64Encoded: base64)
            }
            // Thumbnails only: full-size embedded covers would cost megabytes each in a long list.
            guard let data, let full = UIImage(data: data), full.size.width > 0, full.size.height > 0 else { return nil }
            let scale = min(1, 240 / max(full.size.width, full.size.height))
            let image = await full.byPreparingThumbnail(ofSize: CGSize(width: full.size.width * scale, height: full.size.height * scale)) ?? full
            cache.setObject(image, forKey: url as NSString)
            return image
        }
        loading[url] = task
        let image = await task.value
        loading[url] = nil
        return image
    }
}

struct NativeCover: View {
    let url: String?
    var size: CGFloat = 48
    var radius: CGFloat = 8
    var image: UIImage? = nil
    var embedded: String? = nil
    @State private var loaded: UIImage?

    var body: some View {
        ZStack {
            if let shown = image ?? loaded {
                Image(uiImage: shown).resizable().scaledToFill()
            } else {
                Color.moraMint.opacity(0.1)
                Image(systemName: "music.note").font(.system(size: size * 0.36)).foregroundStyle(.white.opacity(0.4))
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .accessibilityHidden(true)
        .task(id: embedded ?? url) {
            loaded = nil
            guard image == nil else { return }
            if let embedded, let decoded = NativeArtworkImage.decode(embedded) {
                loaded = UIImage(cgImage: decoded)
            } else if let url {
                loaded = await NativeCovers.image(url)
            }
        }
    }
}

extension View {
    /// iOS 26 Liquid Glass; a material with a hairline before it.
    @ViewBuilder func moraGlass<S: Shape>(_ shape: S) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.tint(Color.moraBackground.opacity(0.35)).interactive(), in: shape)
        } else {
            self.background(.ultraThinMaterial, in: shape).overlay(shape.stroke(Color.white.opacity(0.1)))
        }
    }
}

/// The native screens; `.web` shows nothing (the layer is hidden and the page shows through).
struct NativeShellContent: View {
    @ObservedObject var store: NativeShellStore

    var body: some View {
        ZStack(alignment: .top) {
            Color.moraBackground.ignoresSafeArea()
            switch store.screen {
            case .home: NativeHomeView()
            case .more: NativeMoreView()
            case .liked: NativeTrackListView(title: "Любимое", type: "liked", tracks: store.liked)
            case .library:
                if store.path == "/library" { NativeLibraryView() }
                else { NativeTrackListView(title: "Песни", type: "library", tracks: store.library) }
            case .search: NativeSearchView()
            case .page: NativePageView()
            case .web: Color.clear
            }
            if let text = store.banner {
                Text(text).font(.subheadline.weight(.medium)).multilineTextAlignment(.center)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .moraGlass(Capsule())
                    .padding(.horizontal, 24).padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityHidden(true) // announced when it appears
            }
        }
        .animation(.easeOut(duration: 0.25), value: store.banner)
        .foregroundStyle(.white)
        .tint(.moraMint)
        .environmentObject(store)
    }
}

extension NativeTab {
    var item: (String, String) {
        switch self {
        case .home: return ("Главная", "house")
        case .library: return ("Медиатека", "books.vertical")
        case .search: return ("Поиск", "magnifyingglass")
        }
    }
}

/// System tabs with the native mini player above them.
struct NativeShellBar: View {
    @ObservedObject var store: NativeShellStore

    var body: some View {
        VStack(spacing: 8) {
            if let title = store.miniTitle { mini(title) }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 4)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge) // the bar keeps its height; screens scale fully
        .foregroundStyle(.white)
    }

    private func mini(_ title: String) -> some View {
        HStack(spacing: 10) {
            Button { store.openPlayer() } label: {
                HStack(spacing: 10) {
                    NativeCover(url: store.nativePlaying ? nil : store.ui.now?.cover, size: 40, radius: 20, image: store.nativePlaying ? store.artwork : nil)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title.isEmpty ? "MORA" : title).font(.subheadline.weight(.semibold)).lineLimit(1)
                        if !store.miniArtist.isEmpty {
                            Text(store.miniArtist).font(.caption).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(title), \(store.miniArtist)")
            .accessibilityHint("Открыть плеер")
            Button { store.togglePlayback() } label: {
                Image(systemName: store.miniPlaying ? "pause.fill" : "play.fill").font(.title3).frame(width: 44, height: 44)
            }
            .accessibilityLabel(store.miniPlaying ? "Пауза" : "Играть")
            Button { store.next() } label: {
                Image(systemName: "forward.fill").font(.title3).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Следующий")
        }
        .padding(.leading, 8).padding(.trailing, 6)
        .frame(minHeight: 56)
        .moraGlass(Capsule())
        .environmentObject(store)
    }
}
