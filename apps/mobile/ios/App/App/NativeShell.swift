import Combine
import MediaPlayer
import Network
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit
import WidgetKit

/// iPhone app root: the Capacitor web view with the native SwiftUI shell over it.
/// Three layers: the WKWebView (always in the window, so the page keeps running), the native screens
/// (hidden on routes that stay web) and the floating tab bar with the mini player.
/// The live WebView keeps its original parent. UIKit owns a full-size tab controller above it;
/// only its bar receives touches, while the native pages underneath remain interactive.
private final class NativeTabsOverlay: UIView {
    weak var bar: UITabBar?
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard let bar, !bar.isHidden else { return false }
        return bar.convert(bar.bounds, to: self).contains(point)
    }
}

final class MoraRootViewController: UIViewController, UITabBarControllerDelegate {
    let bridge = MoraBridgeViewController()
    let shell = NativeShellStore()
    private let tabs = UITabBarController()
    private let tabsOverlay = NativeTabsOverlay()
    private var content: UIViewController?
    private var bar: UIViewController?
    private var observer: AnyCancellable?
    private var lastShellLayout: (contentHidden: Bool, tabsHidden: Bool, barHidden: Bool, webOnly: Bool, tabIndex: Int)?
    /// The web layer may be the only thing on screen (web mode, or a route the page owns): native must keep a way back.
    private lazy var webExit: UIButton = {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: "chevron.backward"), for: .normal)
        button.tintColor = .white
        button.accessibilityLabel = "Вернуть нативный интерфейс"
        button.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        button.layer.cornerRadius = 14
        button.layer.maskedCorners = [.layerMinXMinYCorner, .layerMinXMaxYCorner]
        button.layer.masksToBounds = true
        button.addTarget(self, action: #selector(leaveWeb), for: .touchUpInside)
        return button
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = UIColor(Color.moraBackground)
        embed(bridge)
        bridge.view.frame = view.bounds
        bridge.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tabs.delegate = self
        tabs.viewControllers = NativeTab.allCases.enumerated().map { index, tab in
            let page = UIViewController()
            page.view.backgroundColor = .clear
            page.view.isOpaque = false
            page.tabBarItem = UITabBarItem(title: tab.item.0, image: UIImage(systemName: tab.item.1), tag: index)
            return page
        }
        tabs.view.backgroundColor = .clear
        tabs.view.isOpaque = false
        tabs.tabBar.tintColor = UIColor(Color.moraMint)
        tabsOverlay.backgroundColor = .clear
        tabsOverlay.isOpaque = false
        tabsOverlay.frame = view.bounds
        tabsOverlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tabsOverlay.bar = tabs.tabBar
        view.addSubview(tabsOverlay)
        embed(tabs, into: tabsOverlay)
        view.addSubview(webExit)
        webExit.isHidden = true
        tabs.view.frame = tabsOverlay.bounds
        tabs.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tabsOverlay.isHidden = true
        #if DEBUG
        // Start before bridge installation so a broken web bootstrap still produces a failing report.
        if ProcessInfo.processInfo.arguments.contains("--native-ui-check") { Task { await checkNativeUI() } }
        #endif
    }

    func installShell(host: NativeMixHost, webView: WKWebView?, diagnosticExport: @escaping @MainActor () async throws -> URL) {
        shell.host = host
        shell.diagnosticExport = diagnosticExport
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
        embed(content)
        content.view.frame = view.bounds
        content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let bar = UIHostingController(rootView: NativeShellBar(store: shell))
        bar.view.backgroundColor = .clear
        bar.overrideUserInterfaceStyle = .dark
        bar.sizingOptions = [.intrinsicContentSize]
        bar.safeAreaRegions = []
        embed(bar)
        bar.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            bar.view.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            bar.view.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14),
            bar.view.bottomAnchor.constraint(equalTo: tabs.tabBar.topAnchor, constant: -12),
        ])
        self.content = content; self.bar = bar
        shell.presenter = self
        observer = shell.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.layoutShell() } }
        layoutShell()
    }

    var miniPlayerSourceView: UIView? {
        guard let barView = bar?.view, !barView.isHidden, barView.window != nil else { return nil }
        return barView
    }

    private func embed(_ child: UIViewController, into container: UIView? = nil) {
        addChild(child)
        (container ?? view).addSubview(child.view)
        child.didMove(toParent: self)
    }
    private func layoutShell() {
        guard let content, let bar else { return }
        let visible = shell.shown && !shell.ui.overlay && !NativeDeepLink.splashVisible
        let contentHidden = !shell.nativeContentVisible
        let tabsHidden = !visible
        let barHidden = !visible || shell.miniTitle == nil
        // While native owns the screen the page hides its own navigation: a web-only layer needs a native way back.
        let webOnly = !shell.shown || shell.screen == .web
        let tabIndex = NativeTab.allCases.firstIndex(of: shell.activeTab) ?? tabs.selectedIndex
        let nextLayout = (contentHidden, tabsHidden, barHidden, webOnly, tabIndex)
        if let last = lastShellLayout, last == nextLayout { return }
        lastShellLayout = nextLayout
        content.view.isHidden = contentHidden
        tabsOverlay.isHidden = tabsHidden
        let animated = !UIAccessibility.isReduceMotionEnabled && view.window != nil
        if bar.view.isHidden != barHidden {
            if !barHidden {
                bar.view.isHidden = false
                if animated {
                    bar.view.alpha = 0
                    bar.view.transform = CGAffineTransform(translationX: 0, y: 12)
                    UIView.animate(withDuration: 0.24, delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: 0.4) {
                        bar.view.alpha = 1
                        bar.view.transform = .identity
                    }
                } else {
                    bar.view.alpha = 1
                    bar.view.transform = .identity
                }
            } else if animated {
                UIView.animate(withDuration: 0.18, animations: {
                    bar.view.alpha = 0
                    bar.view.transform = CGAffineTransform(translationX: 0, y: 12)
                }, completion: { _ in
                    let stillHidden = !(self.shell.shown && !self.shell.ui.overlay && !NativeDeepLink.splashVisible) || self.shell.miniTitle == nil
                    if stillHidden {
                        bar.view.isHidden = true
                        bar.view.transform = .identity
                    }
                })
            } else {
                bar.view.isHidden = true
            }
        }
        webExit.isHidden = !webOnly
        if webOnly { positionWebExit() }
        if tabs.selectedIndex != tabIndex { tabs.selectedIndex = tabIndex }
        view.bringSubviewToFront(tabsOverlay)
        view.bringSubviewToFront(bar.view)
        view.bringSubviewToFront(webExit)
        view.setNeedsLayout()
    }
    private func positionWebExit() {
        let height: CGFloat = 72, width: CGFloat = 30
        webExit.frame = CGRect(x: view.bounds.width - width, y: (view.bounds.height - height) / 2, width: width, height: height)
    }
    /// The page may be broken or reloading: this must never depend on a page command.
    @objc private func leaveWeb() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if !shell.shown { shell.setShown(true, resync: false) }
        if shell.screen == .web { shell.go("/") }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let content, let bar else { return }
        if !webExit.isHidden { positionWebExit() }
        tabs.view.layoutIfNeeded()
        let top = tabs.tabBar.convert(tabs.tabBar.bounds, to: view).minY
        let barHidden = !(shell.shown && !shell.ui.overlay && !NativeDeepLink.splashVisible) || shell.miniTitle == nil
        let inset = tabsOverlay.isHidden ? 0 : max(0, view.safeAreaLayoutGuide.layoutFrame.maxY - top) + (barHidden ? 0 : bar.view.frame.height + 12)
        if content.additionalSafeAreaInsets.bottom != inset { content.additionalSafeAreaInsets.bottom = inset }
    }
    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        guard NativeTab.allCases.indices.contains(tabs.selectedIndex) else { return }
        shell.select(NativeTab.allCases[tabs.selectedIndex])
    }
    override var childForStatusBarStyle: UIViewController? { bridge }
    override var childForStatusBarHidden: UIViewController? { bridge }
    override var childForHomeIndicatorAutoHidden: UIViewController? { bridge }
}

#if DEBUG
// Exercises the real SwiftUI/UIKit field and bridge in the simulator, without external catalog calls.
extension MoraRootViewController {
    @MainActor private func checkNativeUI() async {
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        // The empty-library backup fixture must not open the first-run restore alert over later checks.
        let restoreOffer = UserDefaults.standard.object(forKey: "mora.backup.offered")
        UserDefaults.standard.set(true, forKey: "mora.backup.offered")
        defer { UserDefaults.standard.set(restoreOffer, forKey: "mora.backup.offered") }
        func require(_ condition: Bool, _ message: String) throws {
            if !condition { throw NSError(domain: "NativeUI", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        func wait(_ condition: () -> Bool) async throws {
            for _ in 0..<240 {
                if condition() { return }
                try await Task.sleep(for: .milliseconds(250))
            }
            try require(false, "Timed out waiting for native UI")
        }
        func descendants(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(descendants) }
        func capture(_ name: String) throws {
            let window = view.window!
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            try image.pngData()!.write(to: folder.appendingPathComponent(name + ".png"))
        }
        var report: [String: Any] = [:]
        do {
            try await wait { self.shell.ui.loaded && self.shell.webView != nil }
            try await wait { !NativeDeepLink.splashVisible }
            try require(FileManager.default.fileExists(atPath: folder.appendingPathComponent("native-splash.png").path), "Cold-launch native splash screenshot missing")
            report["splash"] = "Native launch splash (NativeSplash.swift) captured from the window"
            let web = shell.webView!
            // Wave and playback commands are native since stage 4; the deep link exercises the native router.
            NativeDeepLink.open(URL(string: "mora://liked")!)
            try await wait { self.shell.path == "/liked" }
            report["waveLink"] = "mora://liked reached the native router without the page"
            shell.go("/")
            try await wait { self.shell.ui.path == "/" }
            try await wait { self.shell.sharedLibrary }
            try await Task.sleep(for: .seconds(1))
            try capture("native-home")
            _ = try await web.evaluateJavaScript("window.__nativePagesOriginal=window.moraNativeUi;window.__nativePageCalls=[];window.moraNativeUi=async(n,a)=>{if(n==='backup'||n==='page'&&/^#\\/(settings|downloads|sound|backups|sources|import|yandex-playlists|smart-playlists|smart-playlist|duplicates|statistics|diagnostics|wave)(?:[?]|$)/.test(location.hash)){window.__nativePageCalls.push(n+':'+location.hash+':'+JSON.stringify(a||{}));throw Error('Native screen requested the page');}return window.__nativePagesOriginal(n,a);};0")
            let originalSettings = try await NativeServerApp.request("GET", "/api/settings")
            let originalAutomix = (originalSettings["automix"] as? [String: Any])?["enabled"] as? Bool ?? true
            do {
                _ = try await NativeServerApp.request("PUT", "/api/settings", body: ["automix": ["enabled": !originalAutomix]])
                try await wait { self.shell.ui.playback.automix == !originalAutomix }
                shell.go("/settings")
                try await wait { self.shell.ui.path == "/settings" && self.shell.nativeContentVisible }
                try await Task.sleep(for: .seconds(2))
                try capture("native-settings")
            } catch {
                _ = try? await NativeServerApp.request("PUT", "/api/settings", body: ["automix": ["enabled": originalAutomix]])
                throw error
            }
            _ = try await NativeServerApp.request("PUT", "/api/settings", body: ["automix": ["enabled": originalAutomix]])
            try await wait { self.shell.ui.playback.automix == originalAutomix }
            report["settings"] = "SwiftUI settings rendered without a page description; native PUT synchronized playback over server events"
            let downloadFixture = NativeDownloadManager.shared.installVisualFixture()
            defer { NativeDownloadManager.shared.removeVisualFixture(downloadFixture) }
            shell.go("/downloads")
            try await wait { self.shell.ui.path == "/downloads" }
            try await Task.sleep(for: .seconds(2))
            try capture("native-downloads")
            shell.go("/sound")
            try await wait { self.shell.ui.path == "/sound" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-sound")
            report["sound"] = "SwiftUI EQ and preset controls rendered without a page description"
            shell.go("/sources")
            try await wait { self.shell.ui.path == "/sources" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-sources")
            report["sources"] = "SwiftUI account forms rendered against the JSC API without page descriptions or account changes"
            shell.go("/import")
            try await wait { self.shell.ui.path == "/import" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-import")
            shell.go("/smart-playlists")
            try await wait { self.shell.ui.path == "/smart-playlists" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-smart-playlists")
            report["smartPlaylists"] = "SwiftUI smart playlist list rendered against the JSC API without a page description"
            shell.go("/smart-playlist/new")
            try await wait { self.shell.ui.path == "/smart-playlist/new" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-smart-editor")
            report["smartEditor"] = "SwiftUI rule editor rendered without a page description"
            shell.go("/duplicates")
            try await wait { self.shell.ui.path == "/duplicates" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-duplicates")
            report["duplicates"] = "SwiftUI duplicate groups rendered without a page description"
            shell.go("/statistics")
            try await wait { self.shell.ui.path == "/statistics" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-statistics")
            report["statistics"] = "SwiftUI listening statistics rendered without a page description"
            shell.go("/diagnostics")
            try await wait { self.shell.ui.path == "/diagnostics" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-diagnostics")
            report["diagnostics"] = "SwiftUI AutoMix diagnostics rendered against the JSC API without a page description"
            var backupTask: Task<Bool, Never>?
            try await wait {
                if backupTask == nil { backupTask = self.shell.captureBackup() }
                return backupTask != nil
            }
            let backupSaved = await backupTask!.value
            try require(backupSaved, "The native automatic backup did not finish successfully")
            shell.go("/backups")
            try await wait { self.shell.ui.path == "/backups" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(2))
            try capture("native-backups")
            report["backups"] = "Automatic backup captured through the native server; SwiftUI backups rendered without page calls"
            let pageCalls = try await web.evaluateJavaScript("window.__nativePageCalls") as? [Any] ?? []
            try require(pageCalls.isEmpty, "Native screens/backups depended on the page: " + pageCalls.map { "\($0)" }.joined(separator: " | "))
            NativeDownloadManager.shared.removeVisualFixture(downloadFixture)
            _ = try await web.evaluateJavaScript("window.moraNativeUi=window.__nativePagesOriginal;0")
            report["downloads"] = "SwiftUI downloads rendered with an in-memory native progress fixture, without a page description"
            shell.go("/more")
            try await wait { self.shell.ui.path == "/more" }
            shell.setShown(false)
            var recoveryReady = false
            for _ in 0..<40 {
                recoveryReady = try await web.evaluateJavaScript("!document.getElementById('root').inert && [...document.querySelectorAll('button')].some(b=>b.textContent.includes('Включить нативный интерфейс'))") as? Bool == true
                if recoveryReady { break }
                try await Task.sleep(for: .milliseconds(250))
            }
            try require(recoveryReady, "Web fallback has no native UI recovery action")
            _ = try await web.evaluateJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Включить нативный интерфейс')).click();0")
            try await wait { self.shell.shown && self.shell.nativeContentVisible }
            report["nativeRecovery"] = "Switched to web fallback and returned through its real More-page button"
            func waitForQuery(_ query: String) async throws {
                let encoded = String(data: try JSONSerialization.data(withJSONObject: query, options: .fragmentsAllowed), encoding: .utf8)!
                for _ in 0..<40 {
                    if self.shell.catalog.recordedSearchQueries.contains(query) { return }
                    if try await web.evaluateJavaScript("window.__uiQueries.includes(" + encoded + ")") as? Bool == true { return }
                    try await Task.sleep(for: .milliseconds(250))
                }
                let seen = try await web.evaluateJavaScript("JSON.stringify(window.__uiQueries)") as? String ?? "unknown"
                try require(false, "Search query missing; native=" + shell.searchQuery + "; bridge=" + seen)
            }
            _ = try await web.evaluateJavaScript("window.__uiQueries=[]; window.__uiOriginal=window.moraNativeUi; window.moraNativeUi=async(n,a)=>{if(n==='search'){if(a.source==='yandex'){window.__yandexSearchPageCalls=(window.__yandexSearchPageCalls||0)+1;throw Error('Yandex search depended on the page');}window.__uiQueries.push(a.q);return {session:'fixture-'+a.source,tracks:[{id:'fixture',title:'Native Song',artist:'Native Artist',album:'Native Album',duration:180,explicit:true,ok:true}],artists:[],albums:[],more:false};}if(n==='page'&&/^#\\/catalog\\//.test(location.hash)){window.__catalogPageCalls=(window.__catalogPageCalls||0)+1;throw Error('Catalog depended on the page');}if(n==='versionTarget')return{id:'fixture',title:'Native Song',artist:'Native Artist',album:'Native Album',duration:180,ok:true};if(n==='versionSearch')return{session:'versions-fixture',rows:[{key:'yandex:1',id:'ya-1',title:'Native Song Live',artist:'Native Artist',duration:180,ok:true,source:'Яндекс Музыка',tags:'live'}],errors:[]};return window.__uiOriginal(n,a);};0")
            shell.go("/search")
            try await wait { self.shell.ui.path == "/search" && descendants(self.content!.view).contains { $0 is UISearchTextField } }
            try await Task.sleep(for: .seconds(2))
            let field = descendants(content!.view).compactMap { $0 as? UISearchTextField }.first!
            let inert = try await web.evaluateJavaScript("document.getElementById('root').inert && !document.activeElement.matches('input,textarea')") as? Bool == true
            try require(inert, "Hidden web search stole focus")
            try require(!field.isFirstResponder, "Search opened keyboard automatically")
            try require(field.becomeFirstResponder(), "Native search cannot receive focus")
            field.insertText("MORA")
            try await Task.sleep(for: .seconds(2))
            try require(field.text == "MORA", "Typed text is missing from native search")
            try await waitForQuery("MORA")
            report["nativeQuery"] = shell.searchQuery
            report["search"] = "typed MORA through UIKit into SwiftUI and bridge; no automatic focus"
            try capture("native-search")
            view.endEditing(true)
            shell.catalog.installSearchFixture("yandex", [
                "session": "native-yandex-fixture",
                "tracks": [["id": "fixture", "title": "Native Song", "artist": "Native Artist", "album": "Native Album", "duration": 180.0, "explicit": true, "ok": true]],
                "artists": [["id": "77", "title": "Native Artist", "detail": "Исполнитель", "path": "/catalog/artist/77"]],
                "albums": [["id": "88", "title": "Native Album", "detail": "2026", "path": "/catalog/album/88"]],
                "more": false,
            ])
            _ = shell.receive(["path": "/search", "loaded": true, "wave": ["yandex": true]])
            shell.searchSource = "yandex"; shell.searchQuery = "Каталог"
            try await wait { self.shell.catalog.recordedSearchQueries.contains("Каталог") }
            let yandexPageCalls = try await web.evaluateJavaScript("window.__yandexSearchPageCalls || 0") as? Int ?? -1
            try require(yandexPageCalls == 0, "Yandex search depended on the page")
            try await Task.sleep(for: .seconds(1))
            try capture("native-search-yandex")
            shell.catalog.removeSearchFixtures()
            shell.catalog.installFixture("/catalog/artist/77", ["title": "Native Artist", "style": "catalog", "sections": [
                ["rows": [["kind": "hero", "style": "artist", "title": "Native Artist", "subtitle": "Альтернатива · Хип-хоп", "play": ["name": "catalogPlay", "args": [:]], "shuffle": ["name": "catalogPlay", "args": ["shuffle": true]]]]],
                ["title": "Популярные треки", "rows": [["kind": "item", "title": "Native Song · 3:00", "subtitle": "Native Artist"]]],
                ["title": "Альбомы", "rows": [["kind": "shelf", "items": [["id": "88", "title": "Native Album", "detail": "2026", "path": "/catalog/album/88"]]]]]]])
            shell.catalog.installFixture("/catalog/album/88", ["title": "Native Album", "style": "catalog", "sections": [
                ["rows": [["kind": "hero", "style": "album", "title": "Native Album", "subtitle": "Native Artist", "detail": "2026 · 1 трек", "play": ["name": "catalogPlay", "args": [:]], "shuffle": ["name": "catalogPlay", "args": ["shuffle": true]]]]],
                ["rows": [["kind": "item", "title": "Native Song · 3:00", "subtitle": "Native Artist", "number": 1]]]]])
            shell.go("/catalog/artist/77")
            try await wait { self.shell.ui.path == "/catalog/artist/77" }
            try await Task.sleep(for: .seconds(1))
            try require(shell.nativeContentVisible && shell.screen == .page, "Artist fell back to a web page")
            try capture("native-catalog-artist")
            shell.go("/catalog/album/88")
            try await wait { self.shell.ui.path == "/catalog/album/88" }
            try await Task.sleep(for: .seconds(1))
            try capture("native-catalog-album")
            let catalogPageCalls = try await web.evaluateJavaScript("window.__catalogPageCalls || 0") as? Int ?? -1
            try require(catalogPageCalls == 0, "Catalog pages depended on the page description")
            shell.catalog.removeFixtures()
            _ = shell.receive(["path": "/catalog/album/88", "loaded": true, "wave": ["yandex": true]])
            shell.presentVersions(id: "fixture")
            try await wait { self.presentedViewController != nil }
            try await Task.sleep(for: .seconds(2))
            try capture("native-versions")
            presentedViewController?.dismiss(animated: false)
            try await wait { self.presentedViewController == nil }
            report["catalog"] = "native Yandex search, artist, album and version sheet rendered with fixtures"
            shell.go("/")
            try await wait { self.shell.ui.path == "/" }
            shell.waveSource = .own
            shell.go("/wave")
            try await wait { self.content?.presentedViewController != nil }
            try await Task.sleep(for: .seconds(2))
            try require(shell.path == "/" && shell.ui.path == "/", "Wave settings navigated away from Home")
            let page = try await shell.wave.settingsPage("own", request: { try await NativeServerApp.request($0, $1, body: $2) })
            try require(page["title"] as? String == "Настроить волну", "Wave settings failed to load")
            // The sheet's play action is a SwiftUI accessibility element, not a UIView, so it cannot be
            // asserted through the UIKit tree; simctl's screenshot of the sheet is the visual evidence.
            report["wave"] = "native sheet presented; Home route preserved; settings loaded"
            try capture("native-wave")
            shell.waveSettingsOpen = false
            try await wait { self.content?.presentedViewController == nil }
            // The shell opens the settings sheet for /wave; the page builder is asserted directly.
            let wavePage = try await shell.wave.page(source: "own", ui: shell.ui, byId: shell.byId, libraryCount: shell.library.count,
                                                    request: { try await NativeServerApp.request($0, $1, body: $2) })
            try require(wavePage["title"] as? String == "Моя волна", "Wave page failed to build")
            report["wavePage"] = "native wave page builder rendered from the queue slice without a page description"
            let player = NativePlayerModel(host: shell.host!)
            player.installVisualFixture()
            let sheet = UIHostingController(rootView: NativePlayerView(model: player))
            sheet.overrideUserInterfaceStyle = .dark
            sheet.modalPresentationStyle = .pageSheet
            player.controller = sheet
            present(sheet, animated: true)
            try await Task.sleep(for: .seconds(2))
            try capture("native-player-mixing")
            try await Task.sleep(for: .seconds(4))
            try capture("native-player-queue")
            player.playbackMode("repeat")
            try await wait { !player.changingMode }
            try require(player.actionError == nil && player.modes.repeatMode == "all", "Repeat queue did not reach controller")
            player.playbackMode("repeat")
            try await wait { !player.changingMode }
            try require(player.actionError == nil && player.modes.repeatMode == "one", "Repeat one did not reach controller")
            player.playbackMode("shuffle")
            try await wait { !player.changingMode }
            try require(player.actionError == nil && player.modes.shuffle, "Shuffle did not reach controller")
            player.playbackMode("automix")
            try await wait { !player.changingMode }
            try require(player.actionError == nil && !player.modes.automix, "AutoMix did not save settings")
            try capture("native-player-modes")
            NativeLyricsService.shared.installFixture("visual-a", NativeLyricsResult(
                status: "synced",
                lines: [
                    NativeLyricLine(time: 120, text: "Когда гаснут огни большого города"),
                    NativeLyricLine(time: 158, text: "Музыка держит нас на одной волне\nи не отпускает до самого рассвета"),
                    NativeLyricLine(time: 240, text: "Среди шума улиц слышен только этот бит"),
                    NativeLyricLine(time: 252, text: "Каждый переход звучит как одно дыхание"),
                    NativeLyricLine(time: 264, text: "Тёмный изумруд и мягкий свет в ночи"),
                    NativeLyricLine(time: 276, text: "Остаётся только слушать до конца"),
                ],
                plain: "Музыка держит нас на одной волне",
                source: "lrclib",
                matched: NativeLyricMatched(title: "Native Player", artist: "MORA", duration: 180)
            ))
            player.visualShowLyrics = true
            try await Task.sleep(for: .seconds(1))
            try capture("native-player-lyrics")
            player.visualShowLyrics = false
            NativeLyricsService.shared.removeFixtures()
            report["player"] = "visual mixing fixture, native lyrics panel and animated queue; real shuffle, repeat all/one and AutoMix passed"
            player.open("artist")
            try await wait { self.shell.ui.path == "/catalog/artist/77" && self.presentedViewController == nil }
            try await Task.sleep(for: .seconds(1))
            try capture("native-player-artist-link")
            shell.go("/import")
            try await wait { self.shell.ui.path == "/import" }
            let file = folder.appendingPathComponent("MORA Native Import.wav")
            try NativeProbeWave.make(track: 0, seconds: 1).write(to: file)
            let before = Set(shell.library.map(\.id))
            var selected: [URL] = [], cancelled = false
            let documentPicker = NativeDocumentPicker(types: [.audio], multiple: true) { result in
                switch result {
                case .success(let urls): selected = urls
                case .failure(let error): cancelled = (error as NSError).code == CocoaError.Code.userCancelled.rawValue
                }
            }
            let picker = documentPicker.controller
            documentPicker.documentPickerWasCancelled(picker)
            try require(cancelled, "File picker did not report cancellation")
            try require(picker.allowsMultipleSelection, "File picker lost multiple selection")
            documentPicker.present(from: self)
            try await wait { self.presentedViewController === picker && picker.viewIfLoaded?.window != nil && !picker.isBeingPresented }
            try await Task.sleep(for: .seconds(2))
            try capture("native-file-picker")
            documentPicker.documentPicker(picker, didPickDocumentsAt: [file])
            try await wait { selected == [file] && self.presentedViewController == nil }
            NativePickedFile.discardTemporaryCopy(file)
            try require(FileManager.default.fileExists(atPath: file.path), "Import removed the original document")
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
            try NativeProbeWave.make(track: 0, seconds: 1).write(to: temporary)
            NativePickedFile.discardTemporaryCopy(temporary)
            try require(!FileManager.default.fileExists(atPath: temporary.path), "Temporary document copy was not removed")
            let selectedFile = selected[0]
            let staged = try await Task.detached { try NativeImportFiles.stage(selectedFile, root: NativeServerApp.root) }.value
            _ = try await NativeServerApp.request("POST", "/api/mobile/import-file", body: ["file": staged.file, "name": staged.name], timeout: 45)
            try await Task.sleep(for: .seconds(1))
            report["importMessage"] = shell.banner
            try await wait { self.shell.library.contains { !before.contains($0.id) && $0.duration > 0 } }
            shell.go("/library/tracks")
            try await wait { self.shell.ui.path == "/library/tracks" }
            try await Task.sleep(for: .seconds(1))
            try capture("native-import-library")
            report["import"] = "UIKit picker delegate, private file copy, direct JSC WAV import and visible library row passed without base64 or page actions"
            let restoredTrack = shell.library.first { !before.contains($0.id) && $0.duration > 0 }!
            _ = try await web.evaluateJavaScript("window.__libraryOriginal=window.moraNativeUi;window.__libraryCalls=[];window.moraNativeUi=async(n,a)=>{if(n==='reactSaved'||n==='addToPlaylist'||n==='act'&&['createPlaylist','renamePlaylist','deletePlaylist','removeFromPlaylist','reorderPlaylist','exportPlaylist','clearHistory','likeAll'].includes(a.name)||n==='page'&&/^#\\/(history|library\\/playlists|playlist\\/)/.test(location.hash)){window.__libraryCalls.push(n);throw Error('Library action depended on page');}return window.__libraryOriginal(n,a);};0")
            let createdNatively = try await shell.executeLibraryAction("createPlaylist", ["value": "Native actions fixture"])
            try require(createdNatively, "Native playlist creation fell back to page")
            guard let playlist = shell.playlists.first(where: { $0.name == "Native actions fixture" }) else { throw NativeShellError.page }
            _ = try await shell.executeLibraryAction("addToPlaylist", ["playlistId": playlist.id, "ids": [restoredTrack.id, restoredTrack.id]])
            _ = try await shell.executeLibraryAction("renamePlaylist", ["id": playlist.id, "value": "Native renamed fixture"])
            try require(shell.playlists.first(where: { $0.id == playlist.id })?.name == "Native renamed fixture", "Renamed playlist snapshot was stale")
            try await wait { self.shell.ui.path == "/playlist/" + playlist.id }
            try await Task.sleep(for: .seconds(1))
            try capture("native-playlist-actions")
            _ = try await shell.executeLibraryAction("exportPlaylist", ["id": playlist.id])
            try await wait { self.presentedViewController is UIActivityViewController }
            try await Task.sleep(for: .seconds(1))
            try capture("native-playlist-export")
            presentedViewController?.dismiss(animated: false)
            try await wait { self.presentedViewController == nil }
            let contents = try await NativeServerApp.request("GET", "/api/playlists/" + playlist.id)
            let entries = (contents["entries"] as! [[String: Any]]).map { ($0["entryId"] as! NSNumber).intValue }
            try require(entries.count == 2 && entries[0] != entries[1], "Duplicate playlist occurrences were lost")
            _ = try await shell.executeLibraryAction("reorderPlaylist", ["id": playlist.id, "entries": entries, "from": 0, "to": 2])
            _ = try await shell.executeLibraryAction("removeFromPlaylist", ["id": playlist.id, "entry": entries[0]])
            let afterRemoval = try await NativeServerApp.request("GET", "/api/playlists/" + playlist.id)
            let keptEntries = afterRemoval["entries"] as! [[String: Any]]
            try require(keptEntries.count == 1 && (keptEntries[0]["entryId"] as? NSNumber)?.intValue == entries[1], "Removal deleted another playlist occurrence")
            func waitForSavedReaction(_ value: Int) async throws {
                for _ in 0..<40 {
                    let result = try await NativeServerApp.request("GET", "/api/library")
                    let tracks = result["tracks"] as? [[String: Any]] ?? []
                    if tracks.contains(where: { $0["id"] as? String == restoredTrack.id && ($0["reaction"] as? NSNumber)?.intValue == value }) { return }
                    try await Task.sleep(for: .milliseconds(250))
                }
                try require(false, "Native reaction did not reach SQLite")
            }
            shell.react(id: restoredTrack.id, value: 1)
            try await waitForSavedReaction(1)
            shell.react(id: restoredTrack.id, value: 0)
            try await waitForSavedReaction(0)
            _ = try await shell.executeLibraryAction("likeAll", ["ids": [restoredTrack.id, restoredTrack.id]])
            try await waitForSavedReaction(1)
            _ = try await NativeServerApp.request("POST", "/api/plays", body: ["trackId": restoredTrack.id, "context": "native-ui-check"])
            try await shell.refreshLibraryAfterMutation()
            shell.go("/history")
            try await wait { self.shell.ui.path == "/history" }
            try await Task.sleep(for: .seconds(1))
            try capture("native-history-actions")
            _ = try await shell.executeLibraryAction("clearHistory")
            let historyAfterClear = try await NativeServerApp.request("GET", "/api/history")
            try require((historyAfterClear["items"] as? [Any])?.isEmpty == true && shell.reaction(restoredTrack.id) == 1, "Clearing history changed likes or kept plays")
            _ = try await shell.executeLibraryAction("deletePlaylist", ["id": playlist.id])
            try require(!shell.playlists.contains(where: { $0.id == playlist.id }) && shell.byId[restoredTrack.id] != nil, "Deleting playlist deleted its track")
            let libraryCalls = try await web.evaluateJavaScript("window.__libraryCalls.length") as? Int ?? -1
            try require(libraryCalls == 0, "Native library actions depended on page")
            _ = try await web.evaluateJavaScript("window.moraNativeUi=window.__libraryOriginal;0")
            report["libraryActions"] = "Direct playlist create/add/rename/export/reorder/remove/delete, duplicate occurrence IDs, reactions/bulk likes and clear history passed with page commands forbidden"
            _ = try await shell.executeLibraryAction("saveTrackMetadata", [
                "id": restoredTrack.id,
                "defaults": ["title": "MORA Native Song", "artist": "MORA Artist", "album": "MORA Album",
                             "albumArtist": "MORA Artist", "genre": "Test", "year": "2026"]])
            try require(shell.byId[restoredTrack.id]?.album == "MORA Album", "Native metadata save was not applied")
            _ = try await web.evaluateJavaScript("window.__musicOriginal=window.moraNativeUi;window.__musicPageCalls=[];window.moraNativeUi=async(n,a)=>{if(n==='page'){window.__musicPageCalls.push(location.hash);throw Error('Music page depended on the page');}return window.__musicOriginal(n,a);};0")
            shell.go("/library")
            try await wait { self.shell.path == "/library" && self.shell.nativeContentVisible }
            try await Task.sleep(for: .seconds(1))
            try capture("native-library")
            let musicScreens: [(String, String)] = [("/library/albums", "native-albums"), ("/library/artists", "native-artists"),
                ("/album/MORA%20Artist/MORA%20Album", "native-album"), ("/artist/MORA%20Artist", "native-artist"),
                ("/track-edit/\(restoredTrack.id)", "native-track-editor")]
            for (path, shot) in musicScreens {
                shell.go(path)
                try await wait { self.shell.path == path && self.shell.nativeContentVisible }
                try await Task.sleep(for: .seconds(1))
                try capture(shot)
            }
            let musicCalls = try await web.evaluateJavaScript("window.__musicPageCalls") as? [Any] ?? []
            try require(musicCalls.isEmpty, "Music pages depended on the page: " + musicCalls.map { "\($0)" }.joined(separator: " | "))
            _ = try await web.evaluateJavaScript("window.moraNativeUi=window.__musicOriginal;0")
            report["musicPages"] = "Native album and artist lists, album and artist pages and the track editor rendered without page descriptions"
            let saved: [String: Any] = ["items": [["entryId": "restored-fixture", "trackId": restoredTrack.id, "origin": "user"]],
                "index": 0, "position": 0.25, "context": ["type": "library", "label": "Медиатека"], "shuffle": false, "repeat": "off", "volume": 1]
            _ = try await web.callAsyncJavaScript("const r = await fetch('/api/queue',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(saved)}); if(!r.ok)throw Error(r.status); return 0;", arguments: ["saved": saved], in: nil, contentWorld: .page)
            // The worker writes its database image up to 60 s later; leaving the page (pagehide) flushes it,
            // as going to the background does on a phone. A reload alone would drop the saved queue.
            _ = try await web.evaluateJavaScript("window.dispatchEvent(new Event('pagehide'));0")
            try await Task.sleep(for: .seconds(3))
            _ = try await web.evaluateJavaScript("location.reload();0")
            try await wait { self.shell.ui.now?.entryId == "restored-fixture" && self.shell.ui.loaded }
            try require(shell.ui.now?.playing == false, "Restore started music automatically")
            shell.openPlayer()
            try await wait { self.presentedViewController is UIHostingController<NativePlayerView> }
            try await Task.sleep(for: .seconds(2))
            guard let restoredPlayer = (presentedViewController as? UIHostingController<NativePlayerView>)?.rootView.model else { throw NativeShellError.page }
            try require(restoredPlayer.state.trackId == restoredTrack.id && restoredPlayer.state.active, "Restored native player lost track")
            try require(abs(restoredPlayer.state.position - 0.25) < 0.01 && !restoredPlayer.state.playing, "Restored player lost paused position")
            try require(!shell.ui.overlay, "Restore opened the web full player")
            try capture("native-restored-player")
            restoredPlayer.close("close")
            report["restore"] = "Persisted paused queue, WebContent reload and native player presentation without autoplay passed"
            report["status"] = "passed"
        } catch {
            report["status"] = "failed"; report["error"] = error.localizedDescription
            report["startup"] = ["loaded": shell.ui.loaded, "webViewAttached": shell.webView != nil,
                                 "shellInstalled": content != nil, "serverBooted": NativeServerApp.booted]
            report["nativeServerTrace"] = NativeServerApp.shared?.trace ?? []
        }
        try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent("native-ui-check.json"))
    }
}
#endif

enum NativeShellError: LocalizedError {
    case page, timeout
    var errorDescription: String? { self == .timeout ? "Медиатека не отвечает" : "Медиатека ещё загружается" }
}

final class NativePlaybackProgress: ObservableObject {
    @Published var position: Double = 0
    @Published var duration: Double = 0
    @Published var blending: Bool = false
    var fraction: Double { duration > 0 ? min(1, max(0, position / duration)) : 0 }
}

struct NativeCatalogPreview: Equatable {
    let path: String
    let title: String
    let detail: String
    let cover: String?
    let isArtist: Bool
}

/// Swift reads library data from the server's SQLite; the page still owns routing and commands.
final class NativeShellStore: ObservableObject {
    static weak var shared: NativeShellStore?
    /// Screens drawn in Swift: a page view left over from a route change must not ask WebContent for them.
    static let ownScreens: Set<String> = ["/settings", "/sources", "/downloads", "/sound", "/backups", "/statistics"]
    @Published private(set) var library: [NativeTrack] = []
    private(set) var byId: [String: NativeTrack] = [:]
    private(set) var cachedLiked: [NativeTrack] = []
    private(set) var offlineTrackCount = 0
    private(set) var recentlyPlayedTracks: [NativeTrack] = []
    private(set) var favoriteArtists: [(name: String, cover: String?)] = []
    private(set) var artistStations: [NativeArtistStation] = []
    let playbackProgress = NativePlaybackProgress()
    let imports = NativeImportState()
    let smart = NativeSmartState()
    let wave = NativeWaveState()
    let catalog = NativeCatalogState()
    let diagnostics = NativeDiagnosticsState()
    /// Bumped on every snapshot: native pages reload their description from the page.
    @Published private(set) var revision = 0
    private(set) var queue: [NativeQueuedTrack] = []
    @Published private(set) var playlists: [NativePlaylist] = []
    @Published private(set) var ui = NativeUiState()
    /// The route on screen: the page's, or the one native just asked for (until the page confirms it).
    @Published private(set) var path = "/"
    @Published var activeTab: NativeTab = .home
    @Published var tabPaths: [NativeTab: [String]] = [.home: [], .library: [], .search: []]
    @Published private(set) var onlineEpoch = 0
    @Published private(set) var shown = UserDefaults.standard.object(forKey: "mora.nativeShell") as? Bool ?? true
    @Published private(set) var player = NativePlayerState()
    @Published private(set) var artwork: UIImage?
    @Published var banner: String?
    @Published var catalogPreview: NativeCatalogPreview?
    weak var webView: WKWebView?
    weak var presenter: UIViewController?
    var host: NativeMixHost?
    private var timer: Timer?
    private var libraryPollTick = 0
    private var userPickedSearchSource = false
    private var artworkKey = ""
    private var bannerTask: DispatchWorkItem?
    private var reactions = NativeReactionOutbox()
    private var sendingReactions = false
    private var sheetOpen = false
    private var pending: (path: String, at: Date)?
    private var navHistory: [String] = []
    private var stationWrite: DispatchWorkItem?
    private let stationIO = DispatchQueue(label: "ru.mora.station")
    private var station: NativeStationSnapshot?
    private var backupTimer: Timer?
    private var backingUp = false
    private var backupRevision = -1
    private let libraryIO = DispatchQueue(label: "ru.mora.library", qos: .userInitiated)
    private var libraryReader: NativeLibraryStore? // accessed only on libraryIO
    private var libraryReading = false
    private(set) var librarySnapshot: NativeLibraryStore.Snapshot?
    private var savedIds: Set<String> = []
    private var libraryFailure: String?
    private var catalogPlayGeneration = 0
    var playlistSort: [String: String] = [:]
    var diagnosticExport: (@MainActor () async throws -> URL)?
    @MainActor func exportDiagnostics() async throws -> URL {
        guard let diagnosticExport else { throw NativeShellError.page }
        return try await diagnosticExport()
    }
    func remapReactions(_ mapping: [String: String]) { reactions.remap(mapping); flushReactions() }

    @discardableResult func captureBackup() -> Task<Bool, Never>? {
        guard (sharedLibrary || ui.loaded), !backingUp, sharedLibrary || revision != backupRevision else { return nil }
        backingUp = true
        let revision = self.revision
        return Task { @MainActor in
            let lease = UIApplication.shared.beginBackgroundTask(withName: "MORA backup", expirationHandler: nil)
            defer { self.backingUp = false; if lease != .invalid { UIApplication.shared.endBackgroundTask(lease) } }
            do {
                let text: String
                if self.sharedLibrary {
                    let backup = try await NativeServerApp.request("GET", "/api/backup/playlists?library=1")
                    text = String(decoding: try JSONSerialization.data(withJSONObject: backup), as: UTF8.self)
                } else {
                    guard let snapshot = try await self.call("backup", timeout: 15) as? String else { throw CocoaError(.fileReadCorruptFile) }
                    text = snapshot
                }
                try await Task.detached(priority: .utility) {
                    _ = try NativeBackupStore.save(text)
                    #if MORA_ICLOUD
                    _ = try NativeBackupStore.save(text, folder: NativeBackupStore.cloudFolder())
                    #endif
                }.value
                self.backupRevision = revision
                return true
            } catch { self.show("Бэкап: \(error.localizedDescription)"); return false }
        }
    }

    private func offerBackupRestore() {
        guard library.isEmpty, !UserDefaults.standard.bool(forKey: "mora.backup.offered"),
              (try? NativeBackupStore.files().isEmpty) == false else { return }
        Task { @MainActor in
            for _ in 0..<80 {
                if !NativeDeepLink.splashVisible { break }
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard let presenter = self.presenter, presenter.presentedViewController == nil else { return }
            let alert = UIAlertController(title: "Восстановить медиатеку?", message: "Найдены резервные копии настроек, плейлистов, лайков и истории.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Выбрать копию", style: .default) { _ in self.go("/backups") })
            alert.addAction(UIAlertAction(title: "Позже", style: .cancel))
            UserDefaults.standard.set(true, forKey: "mora.backup.offered")
            presenter.present(alert, animated: true)
        }
    }

    private func scheduleStation(_ value: [String: Any]) {
        guard let raw = value["station"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: raw),
              let incoming = try? JSONDecoder().decode(NativeStationPayload.self, from: data) else { return }
        let tracks = incoming.tracks.map { row -> NativeStationSnapshot.Track in
            var track = row
            track.localFile = NativeStationFiles.name(track.trackId)
            return track
        }
        var next = NativeStationSnapshot(context: incoming.context, source: incoming.source, index: incoming.index,
            position: incoming.position, settings: incoming.settings, tracks: tracks)
        next.contextId = incoming.contextId
        guard (try? next.validate()) != nil else { return }
        station = next
        guard stationWrite == nil else { return } // Throttle continuous position ticks rather than postponing forever.
        let task = DispatchWorkItem { [weak self] in
            guard let self, let snapshot = self.station else { return }
            self.stationWrite = nil
            self.stationIO.async {
                do { try NativeStationFiles.save(snapshot) }
                catch { NSLog("MORA station autosave failed: %@", error.localizedDescription) } // a background autosave must not toast every 1.5 s
            }
        }
        stationWrite = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: task)
    }

    @Published var searchQuery = ""
    @Published var searchSource = "all"
    @Published var searchScope = "all"
    @Published var waveSource: NativeWaveSource?
    @Published var waveSettingsOpen = false
    /// «Добавить в плейлист» from a track menu or a selection: the sheet picks a playlist for these tracks.
    @Published var playlistTarget: [NativeTrack] = []
    /// No usable network path: online searches and streams fail, downloads still play.
    @Published private(set) var offline = false
    private let network = NWPathMonitor()
    @MainActor var nativeContentVisible: Bool { shown && !ui.overlay && screen != .web && !NativeDeepLink.splashVisible }
    var screen: NativeScreen { NativeRoute.screen(path) }
    var tab: NativeTab { NativeRoute.tab(path) }
    var liked: [NativeTrack] { cachedLiked }

    private func rebuildLibraryCaches() {
        cachedLiked = NativeTrack.favorites(library)
        offlineTrackCount = library.filter(\.offline).count
        recentlyPlayedTracks = Array(
            library
                .filter { $0.lastPlayedAt > 0 && $0.ok }
                .sorted { $0.lastPlayedAt == $1.lastPlayedAt ? $0.id < $1.id : $0.lastPlayedAt > $1.lastPlayedAt }
                .prefix(4)
        )
        var seen = Set<String>()
        var artists: [(name: String, cover: String?)] = []
        for track in cachedLiked + library {
            let trimmed = track.artist.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed.lowercased()).inserted else { continue }
            artists.append((trimmed, track.cover))
            if artists.count >= 10 { break }
        }
        favoriteArtists = artists
        artistStations = NativeArtistStation.build(Array(byId.values))
    }

    func pickSearchSource(_ source: String) {
        userPickedSearchSource = true
        searchSource = source
    }

    private func syncDefaultSearchSource(yandexLinked: Bool) {
        if yandexLinked && !userPickedSearchSource && searchSource == "all" {
            searchSource = "yandex"
        } else if !yandexLinked && searchSource == "yandex" {
            searchSource = "all"
        }
    }

    func openCatalog(_ path: String, title: String, detail: String = "", cover: String? = nil, isArtist: Bool = false) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        catalogPreview = NativeCatalogPreview(path: path, title: title, detail: detail, cover: cover, isArtist: isArtist)
        go(path)
    }

    var sharedLibrary: Bool { NativeServerApp.booted && NativeServerApp.shared != nil }

    func refreshLibrary() {
        guard sharedLibrary, !libraryReading else { return }
        libraryReading = true
        readLibrary(force: false) { [weak self] _ in self?.libraryReading = false }
    }

    // Queue a fresh read behind any poll already in flight before showing the mutation's result.
    @MainActor func refreshLibraryAfterMutation() async throws {
        try await withCheckedThrowingContinuation { continuation in
            readLibrary(force: true) { continuation.resume(with: $0) }
        }
    }

    private func readLibrary(force: Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        libraryIO.async { [weak self] in
            guard let self else { completion(.failure(CancellationError())); return }
            let result: Result<NativeLibraryStore.Snapshot?, Error> = Result {
                if self.libraryReader == nil { self.libraryReader = try NativeLibraryStore(path: NativeServerApp.root.appendingPathComponent("data/automix.sqlite").path) }
                return try self.libraryReader!.readIfChanged(force: force)
            }
            DispatchQueue.main.async {
                switch result {
                case .success(let snapshot):
                    self.libraryFailure = nil
                    guard let snapshot else { completion(.success(())); return }
                    self.librarySnapshot = snapshot
                    self.library = snapshot.library
                    self.savedIds = Set(snapshot.library.map(\.id))
                    self.byId = Dictionary(uniqueKeysWithValues: snapshot.tracks.map { ($0.id, $0) })
                    self.playlists = snapshot.playlists
                    self.applyPendingReactions()
                    self.rebuildLibraryCaches()
                    self.revision &+= 1
                    NativeSpotlight.update(self.library)
                    self.publishWidget()
                    if self.ui.now == nil && NativeQueueController.shared.entries.isEmpty && !NativeMixHost.shared.active {
                        Task { @MainActor in await NativeQueueController.shared.restoreSavedQueueIfNeeded() }
                    }
                    if self.ui.loaded { self.offerBackupRestore() }
                    completion(.success(()))
                case .failure(let error):
                    let message = error.localizedDescription
                    if self.libraryFailure != message { self.show("Медиатека: \(message)") }
                    self.libraryFailure = message
                    completion(.failure(error))
                }
            }
        }
    }

    func libraryPage(for overridePath: String? = nil) throws -> [String: Any]? {
        let targetPath = overridePath ?? path
        let parts = targetPath.split(separator: "/")
        let local = targetPath == "/history" || targetPath == "/library/playlists" || targetPath == "/library/albums" || targetPath == "/library/artists"
            || (parts.count == 2 && (parts[0] == "playlist" || parts[0] == "artist" || parts[0] == "track-edit"))
            || (parts.count == 3 && parts[0] == "album")
        guard sharedLibrary, local else { return nil }
        guard let snapshot = librarySnapshot else { throw NativeLibraryStore.Failure(message: libraryFailure ?? "Медиатека загружается") }
        let current = NativeLibraryStore.Snapshot(tracks: Array(byId.values), library: library, playlists: playlists, entries: snapshot.entries, history: snapshot.history)
        let id = parts.last.flatMap { String($0).removingPercentEncoding } ?? ""
        return try current.page(targetPath, sort: playlistSort[id] ?? "")
    }

    private func applyPendingReactions() {
        for (id, value) in reactions.pending {
            byId[id]?.reaction = value
            if let index = library.firstIndex(where: { $0.id == id }) { library[index].reaction = value }
        }
    }

    init() {
        catalog.yandex = NativeYandexCatalog(credentialsLoader: {
            let res = try await NativeServerApp.request("GET", "/api/mobile/yandex-credentials")
            guard let token = res["token"] as? String, !token.isEmpty else {
                throw NativeYandexCatalog.Failure(statusCode: 409, message: "Подключите аккаунт Яндекс Музыки")
            }
            let apiBase = (res["apiBase"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "https://api.music.yandex.net"
            return (token, apiBase)
        })
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.captureBackup()
            Task { @MainActor in NativeQueueController.shared.saveCurrentPosition() }
        }
        backupTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in self?.captureBackup() }
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.stopPolling()
            Task { @MainActor in NativeQueueController.shared.saveCurrentPosition() }
        }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.startPolling(); self?.flushReactions(); self?.sendNetwork() }
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.flushReactions() }
        network.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self, (path.status != .satisfied) != self.offline else { return }
                self.offline.toggle()
                if !self.offline {
                    self.catalog.resetNetworkBreakers()
                    self.onlineEpoch &+= 1
                    NotificationCenter.default.post(name: NativeCovers.retryNotification, object: nil)
                    self.flushReactions()
                    self.show("Сеть снова доступна")
                }
                self.sendNetwork()
                Task { @MainActor in NativeQueueController.shared.handleNetworkChange(offline: self.offline) }
            }
        }
        network.start(queue: DispatchQueue(label: "ru.mora.network"))
        Task { @MainActor in
            NativeQueueController.shared.onStateChange = { [weak self] in
                Task { @MainActor in self?.syncQueueControllerState() }
            }
        }
    }

    @MainActor private func syncQueueControllerState() {
        let qc = NativeQueueController.shared
        let playing = qc.isWave && (player.playing || host?.active == true)
        // The page's snapshot knows nothing about the Swift queue: only override what the controller owns.
        if !qc.entries.isEmpty { self.queue = qc.entries.compactMap { NativeQueuedTrack(["entryId": $0.entryId, "trackId": $0.trackId]) } }
        if !qc.entries.isEmpty || NativeMixHost.shared.active {
            self.ui.playback.shuffle = qc.shuffle
            self.ui.playback.repeatMode = qc.repeatMode
            self.ui.playback.automix = qc.automixEnabled
            self.ui.playback.canShuffle = qc.entries.count > 1
        }
        if sharedLibrary || qc.waveSource != nil || qc.waveLoading || qc.waveError != nil || self.ui.wave.loading {
            self.ui.wave.loading = qc.waveLoading
            self.ui.wave.error = qc.waveError
            self.ui.wave.active = qc.waveSource.flatMap(NativeWaveSource.init(rawValue:))
            self.ui.wave.playing = playing
        }
        if let cur = qc.currentEntry, let track = byId[cur.trackId] {
            let pos = NativeMixHost.shared.active ? player.position : (qc.restoredPosition > 0 ? qc.restoredPosition : player.position)
            self.ui.now = NativeNow(id: track.id, title: track.title, artist: track.artist, label: qc.context.label,
                                    cover: track.cover, playing: player.playing, entryId: cur.entryId,
                                    position: pos, duration: track.duration)
        }
    }

    /// The wave sheet closed: a tuning change means the next wave must be built from scratch.
    @MainActor func waveSettingsDismissed() {
        guard wave.consumeChange() else { return }
        NativeQueueController.shared.resetForNewSettings()
        queue = []
        ui.now = nil
        ui.wave.active = nil
        ui.wave.playing = false
        ui.wave.loading = false
        ui.wave.error = nil
        show("Новая волна соберётся с этими настройками")
    }

    /// A snapshot from the page (main thread). Returns whether the shell is on screen.
    // Kept out of line: inlined into receive(), Swift 6.2's CopyPropagation pass crashes on these optional chains (Release).
    @inline(never) private static func trackChanged(_ old: NativeNow?, _ new: NativeNow?) -> Bool {
        old?.id != new?.id || old?.playing != new?.playing
    }

    func updateYandexConnection(_ linked: Bool) {
        ui.wave.yandex = linked
        syncDefaultSearchSource(yandexLinked: linked)
        if !linked && waveSource == .yandex { waveSource = nil }
        catalog.clearYandex()
    }

    func localCatalogTrack(provider: String, externalId: String) -> (trackId: String, saved: Bool, reaction: Int)? {
        guard let trackId = librarySnapshot?.remoteIndex["\(provider):\(externalId)"],
              byId[trackId] != nil else { return nil }
        return (trackId, savedIds.contains(trackId), reaction(trackId))
    }

    @MainActor func registerOptimisticCatalogTrack(id: String, raw: [String: Any], provider: String) {
        guard byId[id] == nil else { return }
        var dict: [String: Any] = [
            "id": id,
            "title": raw["title"] as? String ?? "",
            "artist": raw["artist"] as? String ?? "",
            "album": raw["album"] as? String ?? "",
            "duration": (raw["duration"] as? NSNumber)?.doubleValue ?? 0,
            "provider": provider,
            "sourceKind": "remote",
            "ok": raw["playable"] as? Bool != false,
        ]
        if let cover = (raw["coverUrl"] as? String) ?? (raw["cover"] as? String), !cover.isEmpty {
            dict["cover"] = cover
        }
        if let track = NativeTrack(dict) {
            byId[id] = track
        }
    }

    @MainActor func ensureCatalogTrack(_ track: [String: Any], provider: String, priority: Int = 0, awaitRefresh: Bool = true) async throws -> String {
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
            let res = try await NativeServerApp.request("POST", "/api/public/prepare",
                                                        body: ["provider": resolvedProvider, "externalId": externalId, "priority": priority], timeout: 120)
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

    @MainActor func playCatalogTracks(_ rawTracks: [[String: Any]], startIndex: Int, shuffle: Bool,
                                      context: NativeQueueController.Context) async throws {
        let selected = rawTracks.indices.contains(startIndex) ? rawTracks[startIndex] : nil
        let playable = rawTracks.filter { $0["playable"] as? Bool != false }
        guard !playable.isEmpty else { return }
        catalogPlayGeneration &+= 1
        let gen = catalogPlayGeneration

        var ordered: [[String: Any]]
        if shuffle {
            var list = playable
            if let selected, selected["playable"] as? Bool != false,
               let selectedId = (selected["externalId"] as? String) ?? (selected["id"] as? String),
               !selectedId.isEmpty,
               let idx = list.firstIndex(where: { (($0["externalId"] as? String) ?? ($0["id"] as? String)) == selectedId }) {
                let first = list.remove(at: idx)
                list.shuffle()
                list.insert(first, at: 0)
            } else {
                list.shuffle()
            }
            ordered = Array(list.prefix(25))
        } else {
            let clamped = max(0, min(rawTracks.count - 1, startIndex))
            let tail = rawTracks[clamped...].filter { $0["playable"] as? Bool != false }
            ordered = Array((tail.isEmpty ? playable : tail).prefix(25))
        }

        let first = ordered.removeFirst()
        let firstProvider = (first["audioProvider"] as? String) ?? (first["provider"] as? String) ?? "yandex"
        let firstId = try await ensureCatalogTrack(first, provider: firstProvider, priority: 0, awaitRefresh: false)
        guard gen == catalogPlayGeneration else { return }
        try await NativeQueueController.shared.play(trackIds: [firstId], at: 0, context: context)
        if shuffle != NativeQueueController.shared.shuffle {
            try? await NativeQueueController.shared.setMode("shuffle")
        }

        guard !ordered.isEmpty else { return }
        Task { @MainActor in
            var remaining = ordered
            var firstBatch = true
            while !remaining.isEmpty {
                let count = firstBatch ? 2 : 4
                firstBatch = false
                let chunk = Array(remaining.prefix(count))
                remaining.removeFirst(chunk.count)
                guard gen == self.catalogPlayGeneration,
                      NativeQueueController.shared.context == context,
                      NativeQueueController.shared.entries.contains(where: { $0.trackId == firstId }) else { return }
                var ids: [String] = []
                for item in chunk {
                    guard gen == self.catalogPlayGeneration else { return }
                    let p = (item["audioProvider"] as? String) ?? (item["provider"] as? String) ?? "yandex"
                    if let tid = try? await self.ensureCatalogTrack(item, provider: p, priority: 2) {
                        ids.append(tid)
                    }
                }
                if !ids.isEmpty,
                   gen == self.catalogPlayGeneration,
                   NativeQueueController.shared.context == context {
                    try? await NativeQueueController.shared.enqueue(trackIds: ids, next: false)
                }
            }
        }
    }

    @MainActor func executeCatalogPageAction(_ name: String, _ args: [String: Any]) async throws -> Bool {
        guard sharedLibrary else { return false }
        if name == "catalogPlay" {
            let tracks = args["tracks"] as? [[String: Any]] ?? []
            let ctxRaw = args["context"] as? [String: Any] ?? [:]
            let type = ctxRaw["type"] as? String == "artist" ? "artist" : "album"
            let label = (ctxRaw["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Каталог"
            let ctx = NativeQueueController.Context(type: type, id: ctxRaw["id"] as? String, label: label)
            let shuffle = args["shuffle"] as? Bool == true
            let index = shuffle ? -1 : ((args["index"] as? NSNumber)?.intValue ?? 0)
            try await playCatalogTracks(tracks, startIndex: index, shuffle: shuffle, context: ctx)
            return true
        }
        guard name == "catalogTrack", let track = args["track"] as? [String: Any] else { return false }
        let kind = args["kind"] as? String ?? ""
        let provider = (track["audioProvider"] as? String) ?? (track["provider"] as? String) ?? "yandex"
        let externalId = (track["externalId"] as? String) ?? (track["id"] as? String) ?? ""

        if (kind == "like" || kind == "dislike"), provider == "yandex",
           localCatalogTrack(provider: "yandex", externalId: externalId) == nil,
           !externalId.isEmpty {
            let currentReaction = (track["reaction"] as? NSNumber)?.intValue ?? 0
            let wanted = kind == "like" ? 1 : -1
            let next = currentReaction == wanted ? 0 : wanted
            let escaped = Self.catalogPathComponent(externalId)
            let res = try await NativeServerApp.request("POST", "/api/catalog/yandex/tracks/\(escaped)/reaction", body: ["value": next])
            let finalValue = (res["value"] as? NSNumber)?.intValue ?? next
            if let sync = res["sync"] as? [String: Any], let st = sync["status"] as? String, st == "error" || st == "pending" {
                show(sync["error"] as? String ?? "Реакция сохранена. Отправка в Яндекс продолжится автоматически.")
            }
            catalog.setExternalReaction(provider: "yandex", externalId: externalId, value: finalValue)
            return true
        }

        let trackId = try await ensureCatalogTrack(track, provider: provider, priority: kind == "download" ? 2 : 0)
        switch kind {
        case "next", "queue":
            try await NativeQueueController.shared.enqueue(trackIds: [trackId], next: kind == "next")
            show(kind == "next" ? "Сыграет следующим" : "Добавлено в очередь")
        case "like", "dislike":
            let wanted = kind == "like" ? 1 : -1
            let next = reaction(trackId) == wanted ? 0 : wanted
            react(id: trackId, value: next)
            catalog.invalidate()
        case "save":
            _ = try await NativeServerApp.request("POST", "/api/tracks/\(Self.catalogPathComponent(trackId))/save", body: ["saved": true])
            try? await refreshLibraryAfterMutation()
            catalog.invalidate()
            show("Сохранено в медиатеку")
        case "download":
            _ = try await NativeServerApp.request("POST", "/api/downloads", body: ["trackId": trackId])
            show("Добавлено в загрузки")
        default:
            throw NativeLibraryActions.Failure(message: "Неизвестное действие каталога")
        }
        return true
    }

    @MainActor func executeCatalogSearchAction(kind: String, trackId externalId: String, sessionId: String,
                                               playlist: String? = nil) async throws -> (go: String?, versions: String?, updated: NativeSearchResults?) {
        guard let session = catalog.searchSession(sessionId),
              let index = session.items.firstIndex(where: { (($0["externalId"] as? String) ?? ($0["id"] as? String)) == externalId }) else {
            throw NativeLibraryActions.Failure(message: "Результаты устарели. Повторите поиск.")
        }
        let item = session.items[index]
        let ctxType = (session.context["type"] as? String) ?? "search"
        let ctxLabel = (session.context["label"] as? String) ?? "Поиск"
        let ctx = NativeQueueController.Context(type: ctxType, id: session.context["id"] as? String, label: ctxLabel)

        if kind == "artist" || kind == "album" {
            let artistId = (item["artists"] as? [[String: Any]])?.first?["id"] as? String ?? (item["artistId"] as? String)
            let albumId = item["albumId"] as? String
            if kind == "artist", let artistId, !artistId.isEmpty {
                return ("/catalog/artist/\(Self.catalogPathComponent(artistId))", nil, nil)
            }
            if kind == "album", let albumId, !albumId.isEmpty {
                return ("/catalog/album/\(Self.catalogPathComponent(albumId))", nil, nil)
            }
            let fallbackQuery = kind == "artist" ? (item["artist"] as? String ?? "") : (item["album"] as? String ?? "")
            return ("/search?q=\(Self.catalogPathComponent(fallbackQuery))&src=\(session.source)", nil, nil)
        }
        if kind == "play" {
            try await playCatalogTracks(session.items, startIndex: index, shuffle: false, context: ctx)
            return (nil, nil, nil)
        }
        if kind == "radio" {
            let title = item["title"] as? String ?? ""
            let artist = item["artist"] as? String ?? ""
            let q = Self.catalogPathComponent("\(artist) \(title)".trimmingCharacters(in: .whitespaces))
            if !q.isEmpty,
               let ytSearch = try? await NativeServerApp.request("GET", "/api/search/ytmusic?q=\(q)"),
               let ytFirst = (ytSearch["items"] as? [[String: Any]])?.first(where: { $0["playable"] as? Bool != false }),
               let videoId = ytFirst["externalId"] as? String,
               let radioRes = try? await NativeServerApp.request("GET", "/api/public/radio/\(Self.catalogPathComponent(videoId))"),
               let radioItems = radioRes["items"] as? [[String: Any]], !radioItems.isEmpty {
                try await playCatalogTracks(radioItems, startIndex: 0, shuffle: false,
                                            context: NativeQueueController.Context(type: "online-radio", id: videoId, label: "Радио · \(title)"))
                return (nil, nil, nil)
            }
            let seedId = try await ensureCatalogTrack(item, provider: "yandex", priority: 0)
            let waveRes = try await NativeServerApp.request("POST", "/api/wave/next", body: ["currentId": seedId, "count": 4])
            let picks = (waveRes["picks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
            let list = [seedId] + picks.filter { $0 != seedId }
            try await NativeQueueController.shared.play(trackIds: list, at: 0,
                                                        context: NativeQueueController.Context(type: "wave", id: seedId, label: "Волна · \(title)"))
            return (nil, nil, nil)
        }

        let local = localCatalogTrack(provider: "yandex", externalId: externalId)
        if (kind == "like" || kind == "dislike"), local == nil {
            let current = (item["reaction"] as? NSNumber)?.intValue ?? 0
            let wanted = kind == "like" ? 1 : -1
            let next = current == wanted ? 0 : wanted
            let res = try await NativeServerApp.request("POST", "/api/catalog/yandex/tracks/\(Self.catalogPathComponent(externalId))/reaction", body: ["value": next])
            let finalValue = (res["value"] as? NSNumber)?.intValue ?? next
            if let sync = res["sync"] as? [String: Any], let st = sync["status"] as? String, st == "error" || st == "pending" {
                show(sync["error"] as? String ?? "Реакция сохранена. Отправка в Яндекс продолжится автоматически.")
            }
            let rawUpdated = catalog.updateSearchSessionTrack(sessionId: sessionId, externalId: externalId, reaction: finalValue,
                                                              lookup: { self.localCatalogTrack(provider: $0, externalId: $1) })
            return (nil, nil, rawUpdated.flatMap(NativeSearchResults.init))
        }

        let id = try await ensureCatalogTrack(item, provider: "yandex", priority: kind == "download" ? 2 : 0)
        switch kind {
        case "next", "queue":
            try await NativeQueueController.shared.enqueue(trackIds: [id], next: kind == "next")
            show(kind == "next" ? "Сыграет следующим" : "Добавлено в очередь")
            return (nil, nil, nil)
        case "versions":
            return (nil, id, nil)
        case "save":
            _ = try await NativeServerApp.request("POST", "/api/tracks/\(Self.catalogPathComponent(id))/save", body: ["saved": true])
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
            guard let playlist, playlists.contains(where: { $0.id == playlist }) else {
                throw NativeLibraryActions.Failure(message: "Плейлист не найден")
            }
            _ = try await NativeServerApp.request("POST", "/api/playlists/\(Self.catalogPathComponent(playlist))/tracks", body: ["trackIds": [id]])
            try? await refreshLibraryAfterMutation()
            show("Добавлено в плейлист")
            let rawUpdated = catalog.updateSearchSessionTrack(sessionId: sessionId, externalId: externalId, libraryTrackId: id, saved: true,
                                                              lookup: { self.localCatalogTrack(provider: $0, externalId: $1) })
            return (nil, nil, rawUpdated.flatMap(NativeSearchResults.init))
        case "like", "dislike":
            let wanted = kind == "like" ? 1 : -1
            let next = reaction(id) == wanted ? 0 : wanted
            react(id: id, value: next)
            catalog.invalidate()
            let rawUpdated = catalog.updateSearchSessionTrack(sessionId: sessionId, externalId: externalId, reaction: next, libraryTrackId: id,
                                                              lookup: { self.localCatalogTrack(provider: $0, externalId: $1) })
            return (nil, nil, rawUpdated.flatMap(NativeSearchResults.init))
        default:
            throw NativeLibraryActions.Failure(message: "Неизвестное действие")
        }
    }

    private static func catalogPathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? value
    }

    @MainActor func localTrackLinks(id: String) -> (album: String?, artists: [NativeCatalogLink])? {
        guard let track = byId[id] else { return nil }
        let source = track.artist.isEmpty ? "Неизвестный исполнитель" : track.artist
        let separated = source.replacingOccurrences(of: "\\s*[,;]\\s*|\\s+(?:feat\\.?|ft\\.?)\\s+", with: "\u{1}", options: .regularExpression)
        var seen = Set<String>(), names: [String] = []
        for name in separated.split(separator: "\u{1}").map({ $0.trimmingCharacters(in: .whitespaces) }) where !name.isEmpty {
            if seen.insert(name.lowercased()).inserted { names.append(name) }
        }
        if names.isEmpty { names = ["Неизвестный исполнитель"] }
        let artists = names.compactMap { name -> NativeCatalogLink? in
            let path = "/artist/\(Self.catalogPathComponent(name))"
            return NativeCatalogLink(["id": path, "title": name, "path": path])
        }
        let album: String?
        if !track.album.isEmpty {
            let credit = track.albumArtist.isEmpty ? (track.artist.isEmpty ? "—" : track.artist) : track.albumArtist
            album = "/album/\(Self.catalogPathComponent(credit))/\(Self.catalogPathComponent(track.album))"
        } else {
            album = nil
        }
        return (album, artists)
    }

    func receive(_ value: [String: Any]) -> Bool {
        scheduleStation(value)
        if value["enable"] as? Bool == true { setShown(true, resync: false) }
        if sharedLibrary { refreshLibrary() }
        else { // Pre-migration OPFS fallback: there is no shared SQLite file yet.
            if let rows = value["library"] as? [[String: Any]] {
                library = rows.compactMap(NativeTrack.init)
                byId = Dictionary(library.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                rebuildLibraryCaches()
                DispatchQueue.main.async { NativeSpotlight.update(self.library) }
            }
            if let rows = value["playlists"] as? [[String: Any]] { playlists = rows.compactMap(NativePlaylist.init) }
        }
        if let rows = value["queue"] as? [[String: Any]] { queue = rows.compactMap(NativeQueuedTrack.init) }
        let next = NativeUiState(value)
        if next.loaded && !ui.loaded && (!sharedLibrary || librarySnapshot != nil) { offerBackupRestore() }
        let widgetChanged = value["library"] != nil || value["playlists"] != nil || Self.trackChanged(ui.now, next.now)
        if next.loaded && !ui.loaded && offline { sendNetwork() } // a page that (re)loaded without a network
        if next.toast != ui.toast, let toast = next.toast, screen != .web { show(toast.text) }
        if next.path != ui.path || next.searchQuery != ui.searchQuery || next.searchSource != ui.searchSource || next.searchScope != ui.searchScope {
            if let query = next.searchQuery { searchQuery = query }
            if let source = next.searchSource { searchSource = source }
            if let scope = next.searchScope { searchScope = scope }
        }
        if next.wave.yandex != ui.wave.yandex { catalog.clearYandex() }
        if next != ui { ui = next }
        syncDefaultSearchSource(yandexLinked: next.wave.yandex)
        // Stage 4: the Swift queue controller owns playback; the page's snapshot must not reset wave/queue state.
        if sharedLibrary { Task { @MainActor in self.syncQueueControllerState() } }
        // A push sent before the page saw native's own navigation must not jump back.
        if let pending, pending.path != next.path, Date().timeIntervalSince(pending.at) < 2 {} else {
            pending = nil
            if path != next.path {
                syncStack(for: next.path)
                path = next.path
            }
        }
        applyPendingReactions()
        flushReactions()
        if widgetChanged { publishWidget() }
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
                continuation.resume(with: result.mapError(Self.pageFailure))
            }
            webView.callAsyncJavaScript("if (!window.moraNativeUi) throw new Error('page'); return await window.moraNativeUi(name, args)",
                                        arguments: ["name": name, "args": args], in: nil, in: .page) { result in
                finish(result.map { $0 is NSNull ? nil : $0 })
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(.failure(NativeShellError.timeout)) }
        }
    }

    /// WebKit's own text for a JS exception is generic; the page's message names the actual problem.
    private struct PageFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    /// A page command cancelled by a newer one (fast skipping, another station) is not a failure to show.
    struct PageCancelled: LocalizedError { var errorDescription: String? { "Отменено" } }
    private static func pageFailure(_ error: Error) -> Error {
        if error is CancellationError { return PageCancelled() }
        let userInfo = (error as NSError).userInfo
        if let text = userInfo["WKJavaScriptExceptionMessage"] as? String, !text.isEmpty {
            if text.lowercased().contains("abort") { return PageCancelled() }
            return PageFailure(message: text == "page" ? "Интерфейс ещё загружается — попробуйте ещё раз" : text)
        }
        if (error as NSError).domain == "WKErrorDomain" { return PageFailure(message: "Интерфейс не ответил — попробуйте ещё раз") }
        return error
    }
    static func isCancelled(_ error: Error) -> Bool {
        if case NativeMediaHTTP.Failure.cancelled = error { return true }
        return error is PageCancelled || error is CancellationError
    }

    /// A command: its own errors reach the listener as the page's toasts.
    func run(_ name: String, _ args: [String: Any] = [:]) {
        if name == "versions", let id = args["id"] as? String { presentVersions(id: id); return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { @MainActor in
            do {
                if try await executeLibraryAction(name, args) { return }
                if sharedLibrary, try await executeNativePlaybackCommand(name, args) { return }
                _ = try await call(name, args, timeout: 60)
            } catch {
                if Self.isCancelled(error) { return }
                MoraPlaybackJournal.record("native.page.failure", ["command": name])
                show(error.localizedDescription)
            }
        }
    }

    @MainActor func executeNativePlaybackCommand(_ name: String, _ args: [String: Any]) async throws -> Bool {
        let qc = NativeQueueController.shared
        switch name {
        case "wave":
            let source = args["source"] as? String ?? "own"
            try await qc.startWave(source: source, offline: offline)
            return true
        case "artistRadio":
            let artist = (args["artist"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !artist.isEmpty else { return true }
            try await qc.startArtistRadio(artist: artist, tracks: Array(byId.values))
            return true
        case "queue":
            let ids = (args["ids"] as? [String] ?? []).filter { !$0.isEmpty }
            guard !ids.isEmpty else { return true }
            try await qc.enqueue(trackIds: ids, next: args["next"] as? Bool == true)
            show(args["next"] as? Bool == true ? "Сыграет следующим" : "Добавлено в очередь")
            return true
        case "toggle":
            try await qc.command("toggle")
            return true
        case "next":
            if let ifId = args["ifTrackId"] as? String, !ifId.isEmpty {
                guard qc.isWave, qc.currentEntry?.trackId == ifId else { return true }
            }
            try await qc.command("nexttrack")
            return true
        case "playerCommand":
            let action = args["action"] as? String ?? ""
            try await qc.command(action, seekTime: (args["time"] as? NSNumber)?.doubleValue)
            return true
        case "queueEdit":
            let action = args["action"] as? String ?? ""
            let entry = args["entry"] as? String ?? ""
            try await qc.editQueue(action: action, entryId: entry, after: args["after"] as? String)
            return true
        case "playbackMode":
            let mode = args["mode"] as? String ?? ""
            try await qc.setMode(mode)
            return true
        default:
            return false
        }
    }

    func presentVersions(id: String, from parent: UIViewController? = nil) {
        Task { @MainActor in
            if sharedLibrary, let track = byId[id] {
                presentVersions(track, from: parent)
                return
            }
            do {
                guard let value = try await call("versionTarget", ["target": id]) as? [String: Any], let track = NativeTrack(value) else { throw NativeShellError.page }
                presentVersions(track, from: parent)
            } catch { show(error.localizedDescription) }
        }
    }

    private func presentVersions(_ track: NativeTrack, from parent: UIViewController? = nil) {
        Task { @MainActor in
            guard let parent = parent ?? presenter?.presentedViewController ?? presenter, parent.presentedViewController == nil, parent.viewIfLoaded?.window != nil else { return }
            let controller = UIHostingController(rootView: NativeVersionView(track: track, store: self))
            controller.modalPresentationStyle = .pageSheet
            controller.sheetPresentationController?.prefersGrabberVisible = true
            controller.overrideUserInterfaceStyle = .dark
            controller.view.backgroundColor = UIColor(Color.moraBackground)
            controller.view.tintColor = UIColor(Color.moraMint)
            parent.present(controller, animated: true)
        }
    }

    func navigationBinding(for tab: NativeTab) -> Binding<[String]> {
        Binding(
            get: { self.tabPaths[tab] ?? [] },
            set: { newStack in
                guard self.tabPaths[tab] != newStack else { return }
                self.tabPaths[tab] = newStack
                guard self.activeTab == tab else { return }
                let next = newStack.last ?? NativeRoute.root(tab)
                if self.path != next {
                    self.catalogPreview = nil
                    self.path = next
                    self.pending = (next, Date())
                    self.run("go", ["path": next])
                }
            }
        )
    }

    private func syncStack(for next: String) {
        if next.isEmpty || next == "/" {
            activeTab = .home
            tabPaths[.home] = []
            return
        }
        if next == "/library" {
            activeTab = .library
            tabPaths[.library] = []
            return
        }
        if next == "/search" || next == "/yandex" {
            activeTab = .search
            tabPaths[.search] = []
            return
        }
        guard NativeRoute.screen(next) != .web else { return }
        var stack = tabPaths[activeTab] ?? []
        if let existing = stack.lastIndex(of: next) {
            if existing != stack.count - 1 {
                stack = Array(stack.prefix(existing + 1))
                tabPaths[activeTab] = stack
            }
        } else {
            stack.append(next)
            if stack.count > 24 { stack.removeFirst() }
            tabPaths[activeTab] = stack
        }
    }

    func go(_ path: String) {
        presenter?.view.endEditing(true)
        if path == "/wave" { waveSettingsOpen = true; return }
        let url = URLComponents(string: path)
        if let query = url?.queryItems?.first(where: { $0.name == "q" })?.value { searchQuery = String(query.prefix(200)) }
        if path.hasPrefix("/yandex") { searchSource = "yandex" }
        else if let source = url?.queryItems?.first(where: { $0.name == "src" })?.value, ["all", "local", "ytmusic", "youtube", "soundcloud", "yandex"].contains(source) { searchSource = source }
        if let scope = url?.queryItems?.first(where: { $0.name == "type" })?.value, ["all", "track", "artist", "album"].contains(scope) { searchScope = scope }
        let next = path.components(separatedBy: "?")[0]
        if next != catalogPreview?.path { catalogPreview = nil }
        if !next.isEmpty && next != self.path {
            if navHistory.last != self.path {
                navHistory.append(self.path)
                if navHistory.count > 64 { navHistory.removeFirst() }
            }
        }
        syncStack(for: next)
        self.path = next
        pending = (self.path, Date())
        run("go", ["path": path])
    }
    func select(_ tab: NativeTab) {
        UIAccessibility.post(notification: .screenChanged, argument: nil)
        catalogPreview = nil
        activeTab = tab
        tabPaths[tab] = []
        navHistory.removeAll()
        go(NativeRoute.root(tab))
    }

    func play(_ list: [NativeTrack], at index: Int, type: String, label: String, id: String? = nil) {
        guard list.indices.contains(index), list[index].ok else { return }
        if sharedLibrary {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task { @MainActor in
                do {
                    try await NativeQueueController.shared.play(
                        trackIds: list.map(\.id),
                        at: index,
                        context: .init(type: type, id: id, label: label)
                    )
                } catch {
                    if !Self.isCancelled(error) { show(error.localizedDescription) }
                }
            }
            return
        }
        var args: [String: Any] = ["ids": list.map(\.id), "index": index, "type": type, "label": label]
        if let id { args["id"] = id }
        run("play", args)
    }
    /// The page's history: native pages sit on top of the route they were opened from.
    func back() {
        catalogPreview = nil
        if var stack = tabPaths[activeTab], !stack.isEmpty {
            stack.removeLast()
            tabPaths[activeTab] = stack
            let previous = stack.last ?? NativeRoute.root(activeTab)
            if navHistory.last == self.path || !navHistory.isEmpty { navHistory.removeLast() }
            self.path = previous
            pending = (previous, Date())
            run("go", ["path": previous])
        } else if let previous = navHistory.popLast() {
            syncStack(for: previous)
            self.path = previous
            pending = (previous, Date())
            run("go", ["path": previous])
        } else {
            pending = nil
            run("back")
        }
    }
    func queue(_ track: NativeTrack, next: Bool) {
        if sharedLibrary {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task { @MainActor in
                do {
                    try await NativeQueueController.shared.enqueue(trackIds: [track.id], next: next)
                    show(next ? "Сыграет следующим" : "Добавлено в очередь")
                } catch {
                    show(error.localizedDescription)
                }
            }
            return
        }
        run("queue", ["ids": [track.id], "next": next])
    }
    func react(_ track: NativeTrack, _ value: Int) {
        react(id: track.id, value: value)
    }
    func reaction(_ id: String) -> Int { reactions.pending[id] ?? byId[id]?.reaction ?? 0 }
    func react(id: String, value: Int) {
        guard !id.isEmpty, id.utf8.count <= 512, [-1, 0, 1].contains(value) else { return }
        reactions.set(id, value)
        byId[id]?.reaction = value
        if let index = library.firstIndex(where: { $0.id == id }) { library[index].reaction = value }
        rebuildLibraryCaches()
        if sharedLibrary && value != 0 {
            Task { @MainActor in NativeQueueController.shared.sendYandexReactionFeedback(trackId: id, value: value) }
        }
        flushReactions()
    }
    func likeAll(_ ids: [String]) {
        let todo = NativeLibraryReactions.toLike(ids) { byId[$0] == nil ? nil : reaction($0) }
        let kept = Set(ids).filter { byId[$0] != nil && reaction($0) < 0 }.count
        for id in todo { react(id: id, value: 1) }
        let summary = todo.isEmpty ? "Новых лайков нет — всё уже в любимом" : "В любимое добавлено: \(todo.count)"
        show(summary + (kept > 0 ? " · с дизлайком оставлено как есть: \(kept)" : ""))
    }
    private func flushReactions() {
        guard !sendingReactions, !offline, UIApplication.shared.applicationState == .active, sharedLibrary || webView != nil, !reactions.pending.isEmpty else { return }
        sendingReactions = true
        Task { @MainActor in
            defer { sendingReactions = false }
            do {
                try await NativeLibraryReactions.drain(next: {
                    self.reactions.pending.first.map { ($0.key, $0.value) }
                }, send: { id, value in
                    if self.sharedLibrary {
                        let result = try await NativeServerApp.request("POST", NativeLibraryReactions.path(id), body: ["value": value])
                        try NativeLibraryReactions.validate(result, value: value)
                        if value < 0, self.reaction(id) < 0, (self.player.trackId == id || self.ui.now?.id == id), (NativeQueueController.shared.isWave || self.ui.wave.active != nil) {
                            self.run("next", ["ifTrackId": id, "reason": "dislike"])
                        }
                    } else { _ = try await self.call("reactSaved", ["id": id, "value": value]) }
                }, acknowledge: { id, value in self.reactions.acknowledge(id, value) })
                if sharedLibrary { refreshLibrary() }
            } catch { show("Реакция сохранена на iPhone. Синхронизация повторится при открытии приложения.") }
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
        refreshLibrary()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.refreshPlayer()
            self.libraryPollTick &+= 1
            if self.libraryPollTick % 4 == 0 { self.refreshLibrary() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
    func stopPolling() { timer?.invalidate(); timer = nil }

    private func updatePlaybackProgress(_ next: NativePlayerState) {
        let changed = next.blending != playbackProgress.blending
            || abs(next.position - playbackProgress.position) >= 0.25
            || next.duration != playbackProgress.duration
            || (next.position == 0) != (playbackProgress.position == 0)
        guard changed else { return }
        playbackProgress.position = next.position
        playbackProgress.duration = next.duration
        playbackProgress.blending = next.blending
    }

    private func refreshPlayer() {
        guard let host, host.active else {
            if player.active {
                player = NativePlayerState(); artwork = nil; artworkKey = ""
                playbackProgress.position = 0; playbackProgress.duration = 0; playbackProgress.blending = false
            }
            return
        }
        host.playerState { [weak self] result in
            guard let self, case .success(let value) = result else { return }
            Task { @MainActor in NativeQueueController.shared.syncFromHost(value) }
            let next = NativePlayerState(value)
            let metaChanged = next.trackId != self.player.trackId || next.entryId != self.player.entryId || next.title != self.player.title || next.artist != self.player.artist || next.playing != self.player.playing || next.active != self.player.active
            self.updatePlaybackProgress(next)
            if metaChanged {
                self.player = next
                self.publishWidget()
            }
            let key = "\(next.entryId)|\(next.artworkReady)"
            if key != self.artworkKey {
                self.artworkKey = key
                let itemArtwork = value["artwork"] as? MPMediaItemArtwork
                Task.detached(priority: .userInitiated) { [weak self] in
                    let rendered = itemArtwork?.image(at: CGSize(width: 120, height: 120))
                    await MainActor.run {
                        guard let self, self.artworkKey == key else { return }
                        self.artwork = rendered
                    }
                }
            }
        }
    }

    /// The page's offline wave (lib/offline-wave.ts) follows this monitor; sent again on return to the foreground,
    /// since a suspended page misses the call.
    private func sendNetwork() {
        let offline = self.offline
        Task { @MainActor in _ = try? await call("network", ["offline": offline], timeout: 10) }
    }

    @MainActor func nativePlaybackChanged(_ state: [String: Any], ended: Bool) {
        NativeQueueController.shared.syncFromHost(state)
        // The mini player and the lock-screen widget read `player`: keep them current in the foreground too.
        var next = NativePlayerState(state)
        if ended { next.playing = false }
        let key = "\(next.entryId)|\(next.artworkReady)"
        if key != artworkKey, let itemArtwork = state["artwork"] as? MPMediaItemArtwork {
            artworkKey = key
            Task.detached(priority: .userInitiated) { [weak self] in
                let rendered = itemArtwork.image(at: CGSize(width: 120, height: 120))
                await MainActor.run {
                    guard let self, self.artworkKey == key else { return }
                    self.artwork = rendered
                }
            }
        }
        let metaChanged = next.trackId != player.trackId || next.playing != player.playing || next.title != player.title
            || next.artist != player.artist || next.active != player.active || next.entryId != player.entryId
        updatePlaybackProgress(next)
        guard metaChanged else { return }
        player = next
        publishWidget()
        if sharedLibrary || next.trackId != ui.now?.id { syncQueueControllerState() }
    }

    /// Home-screen widgets: the playing (or last) track and the newest likes; redrawn only when they change.
    private var widget: NativeWidgetData?
    private func publishWidget() {
        let liked = self.liked
        var next = NativeWidgetData(playing: miniPlaying, liked: liked.prefix(6).map { .init(title: $0.title, artist: $0.artist) }, likedCount: liked.count)
        next.playlists = playlists.map { .init(id: $0.id, name: $0.name) }
        if let title = miniTitle, !title.isEmpty { next.now = .init(title: title, artist: miniArtist) } else { next.now = widget?.now }
        next.updatedAt = widget?.updatedAt
        guard next != widget else { return }
        next.updatedAt = .now
        widget = next
        next.save()
        WidgetCenter.shared.reloadAllTimelines()
    }

    var nativePlaying: Bool { host?.active == true && player.active }
    func isCurrentTrack(_ id: String) -> Bool { nativePlaying ? player.trackId == id : ui.now?.id == id }
    var miniTitle: String? { nativePlaying ? player.title : ui.now?.title }
    var miniArtist: String { nativePlaying ? player.artist : ui.now?.artist ?? "" }
    var miniPlaying: Bool { nativePlaying ? player.playing : ui.now?.playing == true }
    var miniProgress: Double {
        guard nativePlaying, player.duration > 0 else { return 0 }
        return min(1, max(0, player.position / player.duration))
    }

    func togglePlayback() {
        if nativePlaying, let host {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            let action = player.playing ? "pause" : "play"
            if action == "pause" { Task { @MainActor in NativeQueueController.shared.saveCurrentPosition() } }
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
    func previous() {
        if nativePlaying, let host {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            host.command("previoustrack", source: "player") { [weak self] _ in self?.refreshPlayer() }
        } else { run("playerCommand", ["action": "previoustrack"]) }
    }
    func playlistCovers(for playlistId: String) -> [String] {
        var seen = Set<String>()
        var urls: [String] = []
        for entry in librarySnapshot?.entries[playlistId] ?? [] {
            guard let cover = byId[entry.trackId]?.cover, !cover.isEmpty, seen.insert(cover).inserted else { continue }
            urls.append(cover)
            if urls.count >= 4 { return urls }
        }
        if urls.isEmpty, let cover = playlists.first(where: { $0.id == playlistId })?.cover, !cover.isEmpty {
            return [cover]
        }
        return urls
    }
    /// A restored track opens natively before the audio engine starts.
    func openPlayer() {
        guard miniTitle != nil, let host, let presenter, presenter.presentedViewController == nil, !sheetOpen else { return }
        sheetOpen = true
        NativePlayerSheet.present(host: host, from: presenter) { [weak self] action in
            self?.sheetOpen = false
            if action == "more" { self?.run("player") }
        }
    }
}

/// Library covers come from the page (/api/... lives in its worker); remote ones over HTTPS.
enum NativeCovers {
    static let retryNotification = Notification.Name("ru.mora.coverRetry")
    private static let cache: NSCache<NSString, UIImage> = { let c = NSCache<NSString, UIImage>(); c.countLimit = 400; return c }()
    private static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 40 * 1024 * 1024, diskCapacity: 150 * 1024 * 1024, diskPath: "mora-covers")
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        cfg.httpMaximumConnectionsPerHost = 6
        cfg.timeoutIntervalForRequest = 12
        cfg.timeoutIntervalForResource = 25
        return URLSession(configuration: cfg)
    }()
    @MainActor private static var loading: [String: Task<UIImage?, Never>] = [:]

    static func cached(_ url: String?) -> UIImage? {
        guard let url else { return nil }
        return cache.object(forKey: url as NSString)
    }

    /// The page loads /api covers; the player sheet uses this without the shell's environment.
    @MainActor static func image(_ url: String) async -> UIImage? {
        if let image = cache.object(forKey: url as NSString) { return image }
        if let task = loading[url] { return await task.value }
        let isShared = NativeShellStore.shared?.sharedLibrary == true
        let task = Task<UIImage?, Never> {
            var data: Data?
            if url.hasPrefix("https://"), let remote = URL(string: url) {
                data = await Task.detached(priority: .userInitiated) {
                    guard let (bytes, resp) = try? await NativeCovers.session.data(from: remote) else { return nil }
                    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return nil }
                    return bytes
                }.value
            } else if url.hasPrefix("/api/") {
                if url.hasPrefix("/api/covers/"), isShared {
                    let fileName = String(url.dropFirst("/api/covers/".count))
                    if !fileName.contains("\n"), fileName.range(of: "^[a-f0-9]{40}\\.(jpg|png|webp)$", options: .regularExpression) != nil {
                        let coverURL = NativeServerApp.root.appendingPathComponent("data/covers/" + fileName)
                        data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: coverURL) }.value
                        if data?.isEmpty == true { data = nil }
                    }
                }
                if data == nil, let store = NativeShellStore.shared, let base64 = try? await store.call("cover", ["url": url]) as? String {
                    data = await Task.detached(priority: .userInitiated) { Data(base64Encoded: base64) }.value
                }
            }
            guard !Task.isCancelled, let rawData = data else { return nil }
            let image: UIImage? = await Task.detached(priority: .userInitiated) {
                guard let full = UIImage(data: rawData), full.size.width > 0, full.size.height > 0 else { return nil }
                let scale = min(1, 240 / max(full.size.width, full.size.height))
                return await full.byPreparingThumbnail(ofSize: CGSize(width: full.size.width * scale, height: full.size.height * scale)) ?? full
            }.value
            if let image { cache.setObject(image, forKey: url as NSString) }
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
    var monogram: String? = nil
    var aspectSquare: Bool = false
    @State private var loaded: UIImage?
    @State private var retryTick = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let cachedHit = image ?? NativeCovers.cached(url)
        let shown = cachedHit ?? loaded
        let artwork = ZStack {
            if let shown {
                Image(uiImage: shown).resizable().scaledToFill()
                    .transition(.opacity)
            } else {
                LinearGradient(colors: [Color.moraMint.opacity(0.24), Color.moraSurface], startPoint: .topLeading, endPoint: .bottomTrailing)
                if let initial = monogram?.trimmingCharacters(in: .whitespacesAndNewlines).first {
                    Text(String(initial).uppercased())
                        .font(.system(size: aspectSquare ? 42 : max(14, size * 0.40), weight: .bold, design: .rounded))
                        .foregroundStyle(Color.moraMint.opacity(0.92))
                } else {
                    Image(systemName: "music.note")
                        .font(.system(size: aspectSquare ? 38 : size * 0.36))
                        .foregroundStyle(.white.opacity(0.42))
                }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: shown != nil)
        Group {
            if aspectSquare {
                Color.clear.aspectRatio(1, contentMode: .fit)
                    .overlay { artwork }
            } else {
                artwork.frame(width: size, height: size)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .accessibilityHidden(true)
        .onReceive(NotificationCenter.default.publisher(for: NativeCovers.retryNotification)) { _ in
            if image == nil && url != nil && loaded == nil && NativeCovers.cached(url) == nil {
                retryTick &+= 1
            }
        }
        .task(id: "\(embedded ?? url ?? "")|\(retryTick)") {
            guard image == nil else { return }
            if let embedded {
                loaded = await Task.detached(priority: .userInitiated) {
                    NativeArtworkImage.decode(embedded).map { UIImage(cgImage: $0) }
                }.value
            } else if let url {
                if let hit = NativeCovers.cached(url) { loaded = hit; return }
                loaded = await NativeCovers.image(url)
            } else {
                loaded = nil
            }
        }
    }
}

struct NativeCollageCover: View {
    let urls: [String]
    var size: CGFloat = 48
    var radius: CGFloat = 8
    var monogram: String? = nil
    var aspectSquare: Bool = false

    var body: some View {
        if urls.count >= 4 {
            let tile = max(1, (size - 1.5) / 2)
            let grid = VStack(spacing: 1.5) {
                HStack(spacing: 1.5) {
                    tileCover(urls[0], tile: tile)
                    tileCover(urls[1], tile: tile)
                }
                HStack(spacing: 1.5) {
                    tileCover(urls[2], tile: tile)
                    tileCover(urls[3], tile: tile)
                }
            }
            .background(Color.moraBackground)
            Group {
                if aspectSquare {
                    Color.clear.aspectRatio(1, contentMode: .fit)
                        .overlay { grid }
                } else {
                    grid.frame(width: size, height: size)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .accessibilityHidden(true)
        } else {
            NativeCover(url: urls.first, size: size, radius: radius, monogram: monogram, aspectSquare: aspectSquare)
        }
    }

    @ViewBuilder private func tileCover(_ url: String, tile: CGFloat) -> some View {
        if aspectSquare {
            NativeCover(url: url, radius: 0, aspectSquare: true)
        } else {
            NativeCover(url: url, size: tile, radius: 0)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if store.offline {
                Text("Не в сети")
                    .font(.footnote.weight(.medium)).foregroundStyle(Color.moraGold)
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                    .background(Color.moraGold.opacity(0.12))
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            screen
                .overlay(alignment: .bottom) {
                    if let text = store.banner {
                        Text(text).font(.subheadline.weight(.medium)).multilineTextAlignment(.center)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .moraGlass(Capsule())
                            .padding(.horizontal, 20).padding(.bottom, 12)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                            .allowsHitTesting(false)
                            .accessibilityHidden(true) // announced when it appears
                    }
                }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: store.offline)
        .background(Color.moraBackground.ignoresSafeArea())
        .sheet(isPresented: Binding(get: { !store.playlistTarget.isEmpty }, set: { if !$0 { store.playlistTarget = [] } })) {
            NativePlaylistPicker(tracks: store.playlistTarget)
                .environmentObject(store)
                .presentationBackground(Color.moraBackground)
                .tint(.moraMint)
                .preferredColorScheme(.dark)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: store.banner)
        .transaction { if reduceMotion { $0.animation = nil; $0.disablesAnimations = true } }
        .foregroundStyle(.white)
        .tint(.moraMint)
        .environmentObject(store)
        .sheet(isPresented: $store.waveSettingsOpen) {
            NavigationStack {
                NativePageView(waveSource: Binding(get: { store.waveSource ?? store.ui.wave.preferred }, set: { store.waveSource = $0 }))
                    .onDisappear { store.waveSettingsDismissed() }
            }
            .environmentObject(store)
            .tint(.moraMint)
            .presentationDetents([.fraction(0.72), .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(Color.moraBackground)
            .preferredColorScheme(.dark)
        }
    }
    @ViewBuilder private var screen: some View {
        if store.screen == .web {
            Color.clear
        } else {
            NavigationStack(path: store.navigationBinding(for: store.activeTab)) {
                tabRootView(for: store.activeTab)
                    .navigationDestination(for: String.self) { destination in
                        destinationView(for: destination)
                    }
            }
            .id(store.activeTab)
        }
    }
    @ViewBuilder private func tabRootView(for tab: NativeTab) -> some View {
        switch tab {
        case .home: NativeHomeView()
        case .library: NativeLibraryView()
        case .search: NativeSearchView()
        }
    }
    @ViewBuilder private func destinationView(for route: String) -> some View {
        switch NativeRoute.screen(route) {
        case .home: NativeHomeView()
        case .more: NativeMoreView()
        case .liked: NativeTrackListView(title: "Любимое", type: "liked", tracks: store.liked)
        case .library:
            if route == "/library" { NativeLibraryView() }
            else { NativeTrackListView(title: "Песни", type: "library", tracks: store.library) }
        case .search: NativeSearchView()
        case .page:
            if store.sharedLibrary && NativeShellStore.ownScreens.contains(route) {
                switch route {
                case "/settings": NativeSettingsView()
                case "/sources": NativeSourcesView()
                case "/downloads": NativeDownloadsView()
                case "/sound": NativeSoundView()
                case "/statistics": NativeStatisticsView()
                default: NativeBackupsView()
                }
            } else {
                NativePageView(routePath: route)
            }
        case .web:
            Color.clear
        }
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
    @State private var dragOffset: CGFloat = 0
    @State private var verticalDrag: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 8) {
            if let title = store.miniTitle { mini(title) }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge) // the bar keeps its height; screens scale fully
        .foregroundStyle(.white)
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: store.miniTitle != nil)
        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: store.miniPlaying)
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
            .buttonStyle(MoraPressStyle())
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(title), \(store.miniArtist)")
            .accessibilityHint("Открыть плеер")
            Button { store.togglePlayback() } label: {
                Image(systemName: store.miniPlaying ? "pause.fill" : "play.fill").contentTransition(.symbolEffect(.replace)).font(.title3).frame(width: 44, height: 44)
            }
            .buttonStyle(MoraPressStyle())
            .accessibilityLabel(store.miniPlaying ? "Пауза" : "Играть")
            Button { store.next() } label: {
                Image(systemName: "forward.fill").font(.title3).frame(width: 44, height: 44)
            }
            .buttonStyle(MoraPressStyle())
            .accessibilityLabel("Следующий")
        }
        .padding(.leading, 8).padding(.trailing, 6)
        .frame(minHeight: 56)
        .overlay(alignment: .bottom) {
            if store.nativePlaying {
                NativeMiniProgressBar(progress: store.playbackProgress)
            }
        }
        .clipShape(Capsule())
        .moraGlass(Capsule())
        .offset(x: dragOffset, y: verticalDrag)
        .highPriorityGesture(
            DragGesture(minimumDistance: 16, coordinateSpace: .global)
                .onChanged { value in
                    if abs(value.translation.width) > abs(value.translation.height) {
                        dragOffset = max(-32, min(32, value.translation.width * 0.35))
                        verticalDrag = 0
                    } else if value.translation.height < 0 {
                        verticalDrag = max(-14, value.translation.height * 0.25)
                        dragOffset = 0
                    }
                }
                .onEnded { value in
                    if abs(value.translation.width) > abs(value.translation.height) {
                        if value.translation.width < -55 { store.next() }
                        else if value.translation.width > 55 { store.previous() }
                    } else if value.translation.height < -24 {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        store.openPlayer()
                    }
                    if reduceMotion {
                        dragOffset = 0
                        verticalDrag = 0
                    } else {
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.72)) {
                            dragOffset = 0
                            verticalDrag = 0
                        }
                    }
                }
        )
        .onDisappear { dragOffset = 0; verticalDrag = 0 }
        .environmentObject(store)
    }
}

private struct NativeMiniProgressBar: View {
    @ObservedObject var progress: NativePlaybackProgress
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if progress.fraction > 0 {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Color.white.opacity(0.08))
                    Rectangle()
                        .fill(
                            LinearGradient(
                                colors: progress.blending ? [.moraMint, .moraGold] : [.moraMint, .moraMint],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: geo.size.width * progress.fraction)
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: progress.fraction)
                }
            }
            .frame(height: 2)
            .allowsHitTesting(false)
        }
    }
}
