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
            bar.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.view.bottomAnchor.constraint(equalTo: tabs.tabBar.topAnchor, constant: -8),
        ])
        self.content = content; self.bar = bar
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
        let visible = shell.shown && !shell.ui.overlay && !NativeDeepLink.splashVisible
        content.view.isHidden = !shell.nativeContentVisible
        tabsOverlay.isHidden = !visible
        bar.view.isHidden = !visible || shell.miniTitle == nil
        if let index = NativeTab.allCases.firstIndex(of: shell.tab), tabs.selectedIndex != index { tabs.selectedIndex = index }
        view.bringSubviewToFront(tabsOverlay)
        view.bringSubviewToFront(bar.view)
        view.setNeedsLayout()
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let content, let bar else { return }
        tabs.view.layoutIfNeeded()
        let top = tabs.tabBar.convert(tabs.tabBar.bounds, to: view).minY
        let inset = tabsOverlay.isHidden ? 0 : max(0, view.safeAreaLayoutGuide.layoutFrame.maxY - top) + (bar.view.isHidden ? 0 : bar.view.frame.height + 8)
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
            _ = try await web.evaluateJavaScript("window.__waveOriginal=window.moraNativeUi;window.__waveSource=null;window.moraNativeUi=async(n,a)=>{if(n==='wave'){window.__waveSource=a.source;return;}return window.__waveOriginal(n,a);};0")
            NativeDeepLink.open(URL(string: "mora://wave?source=yandex")!)
            var waveLinkPassed = false
            for _ in 0..<40 {
                if try await web.evaluateJavaScript("window.__waveSource") as? String == "yandex" { waveLinkPassed = true; break }
                try await Task.sleep(for: .milliseconds(250))
            }
            try require(waveLinkPassed, "Wave deep link lost selected source")
            _ = try await web.evaluateJavaScript("window.moraNativeUi=window.__waveOriginal;0")
            report["waveLink"] = "mora://wave?source=yandex reached the wave command"
            try await wait { self.shell.sharedLibrary }
            _ = try await web.evaluateJavaScript("window.__nativePagesOriginal=window.moraNativeUi;window.__nativePageCalls=[];window.moraNativeUi=async(n,a)=>{if(n==='backup'||n==='page'&&/^#\\/(settings|downloads|sound|backups)(?:[?]|$)/.test(location.hash)){window.__nativePageCalls.push(n+':'+location.hash);throw Error('Native screen requested the page');}return window.__nativePagesOriginal(n,a);};0")
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
            let pageCalls = try await web.evaluateJavaScript("window.__nativePageCalls.length") as? Int ?? -1
            try require(pageCalls == 0, "Native screens/backups depended on the page")
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
                    if try await web.evaluateJavaScript("window.__uiQueries.includes(" + encoded + ")") as? Bool == true { return }
                    try await Task.sleep(for: .milliseconds(250))
                }
                let seen = try await web.evaluateJavaScript("JSON.stringify(window.__uiQueries)") as? String ?? "unknown"
                try require(false, "Search query missing; native=" + shell.searchQuery + "; bridge=" + seen)
            }
            _ = try await web.evaluateJavaScript("window.__uiQueries=[]; window.__uiOriginal=window.moraNativeUi; window.moraNativeUi=async(n,a)=>{if(n==='search'){window.__uiQueries.push(a.q);return {session:'fixture-'+a.source,tracks:[{id:'fixture',title:'Native Song',artist:'Native Artist',album:'Native Album',duration:180,explicit:true,ok:true}],artists:a.source==='yandex'?[{id:'77',title:'Native Artist',detail:'Исполнитель',path:'/catalog/artist/77'}]:[],albums:a.source==='yandex'?[{id:'88',title:'Native Album',detail:'2026',path:'/catalog/album/88'}]:[],more:false};}if(n==='page'&&location.hash.includes('/catalog/'))return{title:location.hash.includes('/artist/')?'Native Artist':'Native Album',sections:[{title:'Треки',rows:[{kind:'item',title:'Native Song',subtitle:'Native Artist',tag:'3:00'}]}]};if(n==='versionTarget')return{id:'fixture',title:'Native Song',artist:'Native Artist',album:'Native Album',duration:180,ok:true};if(n==='versionSearch')return{session:'versions-fixture',rows:[{key:'yandex:1',id:'ya-1',title:'Native Song Live',artist:'Native Artist',duration:180,ok:true,source:'Яндекс Музыка',tags:'live'}],errors:[]};return window.__uiOriginal(n,a);};0")
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
            _ = shell.receive(["path": "/search", "loaded": true, "wave": ["yandex": true]])
            shell.searchSource = "yandex"; shell.searchQuery = "Каталог"
            try await Task.sleep(for: .seconds(2))
            try await waitForQuery("Каталог")
            try await Task.sleep(for: .seconds(1))
            try capture("native-search-yandex")
            shell.go("/catalog/artist/77")
            try await wait { self.shell.ui.path == "/catalog/artist/77" }
            try await Task.sleep(for: .seconds(1))
            try require(shell.nativeContentVisible && shell.screen == .page, "Artist fell back to a web page")
            try capture("native-catalog-artist")
            shell.go("/catalog/album/88")
            try await wait { self.shell.ui.path == "/catalog/album/88" }
            try await Task.sleep(for: .seconds(1))
            try capture("native-catalog-album")
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
            let page = try await shell.call("waveSettings", ["source": "own"]) as? [String: Any]
            try require(page?["title"] as? String == "Настроить волну", "Wave settings failed to load")
            // The sheet's play action is a SwiftUI accessibility element, not a UIView, so it cannot be
            // asserted through the UIKit tree; simctl's screenshot of the sheet is the visual evidence.
            report["wave"] = "native sheet presented; Home route preserved; settings loaded"
            try capture("native-wave")
            shell.waveSettingsOpen = false
            try await wait { self.content?.presentedViewController == nil }
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
            report["player"] = "visual mixing fixture and animated queue; real shuffle, repeat all/one and AutoMix bridge commands passed"
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
            let encoded = try await NativePickedFile.base64(selected[0])
            _ = try await shell.call("act", ["name": "importAudio", "args": ["name": file.lastPathComponent, "base64": encoded]], timeout: 45)
            try await Task.sleep(for: .seconds(1))
            report["importMessage"] = shell.banner
            try await wait { self.shell.library.contains { !before.contains($0.id) && $0.duration > 0 } }
            shell.go("/library/tracks")
            try await wait { self.shell.ui.path == "/library/tracks" }
            try await Task.sleep(for: .seconds(1))
            try capture("native-import-library")
            report["import"] = "UIKit picker delegate, copied file read, real WAV upload and visible library row passed"
            let restoredTrack = shell.library.first { !before.contains($0.id) && $0.duration > 0 }!
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

/// Swift reads library data from the server's SQLite; the page still owns routing and commands.
final class NativeShellStore: ObservableObject {
    static weak var shared: NativeShellStore?
    @Published private(set) var library: [NativeTrack] = []
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
    private var stationWrite: DispatchWorkItem?
    private let stationIO = DispatchQueue(label: "ru.mora.station")
    private var station: NativeStationSnapshot?
    private var backupTimer: Timer?
    private var backingUp = false
    private var backupRevision = -1
    private let libraryIO = DispatchQueue(label: "ru.mora.library", qos: .userInitiated)
    private var libraryReader: NativeLibraryStore? // accessed only on libraryIO
    private var libraryReading = false
    private var librarySnapshot: NativeLibraryStore.Snapshot?
    private var libraryFailure: String?
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
    var liked: [NativeTrack] { NativeTrack.favorites(library) }

    var sharedLibrary: Bool { NativeServerApp.booted && NativeServerApp.shared != nil }

    func refreshLibrary() {
        guard sharedLibrary, !libraryReading else { return }
        libraryReading = true
        libraryIO.async { [weak self] in
            guard let self else { return }
            let result: Result<NativeLibraryStore.Snapshot?, Error> = Result {
                if self.libraryReader == nil { self.libraryReader = try NativeLibraryStore(path: NativeServerApp.root.appendingPathComponent("data/automix.sqlite").path) }
                return try self.libraryReader!.readIfChanged()
            }
            DispatchQueue.main.async {
                self.libraryReading = false
                switch result {
                case .success(let snapshot):
                    self.libraryFailure = nil
                    guard let snapshot else { return }
                    self.librarySnapshot = snapshot
                    self.library = snapshot.library
                    self.byId = Dictionary(uniqueKeysWithValues: snapshot.tracks.map { ($0.id, $0) })
                    self.playlists = snapshot.playlists
                    self.applyPendingReactions()
                    self.revision &+= 1
                    NativeSpotlight.update(self.library)
                    self.publishWidget()
                    if self.ui.loaded { self.offerBackupRestore() }
                case .failure(let error):
                    let message = error.localizedDescription
                    if self.libraryFailure != message { self.show("Медиатека: \(message)") }
                    self.libraryFailure = message
                }
            }
        }
    }

    func libraryPage() throws -> [String: Any]? {
        let parts = path.split(separator: "/")
        let local = path == "/history" || path == "/library/playlists" || (parts.count == 2 && parts[0] == "playlist")
        guard sharedLibrary, local else { return nil }
        guard let snapshot = librarySnapshot else { throw NativeLibraryStore.Failure(message: libraryFailure ?? "Медиатека загружается") }
        let current = NativeLibraryStore.Snapshot(tracks: Array(byId.values), library: library, playlists: playlists, entries: snapshot.entries, history: snapshot.history)
        let id = parts.last.flatMap { String($0).removingPercentEncoding } ?? ""
        return try current.page(path, sort: playlistSort[id] ?? "")
    }

    private func applyPendingReactions() {
        for (id, value) in reactions.pending {
            byId[id]?.reaction = value
            if let index = library.firstIndex(where: { $0.id == id }) { library[index].reaction = value }
        }
    }

    init() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.captureBackup() }
        backupTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in self?.captureBackup() }
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.stopPolling() }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.startPolling(); self?.flushReactions(); self?.sendNetwork() }
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.flushReactions() }
        network.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self, (path.status != .satisfied) != self.offline else { return }
                self.offline.toggle()
                self.show(self.offline ? "Нет сети — волна продолжится скачанными треками" : "Сеть снова доступна")
                self.sendNetwork()
            }
        }
        network.start(queue: DispatchQueue(label: "ru.mora.network"))
    }

    /// A snapshot from the page (main thread). Returns whether the shell is on screen.
    // Kept out of line: inlined into receive(), Swift 6.2's CopyPropagation pass crashes on these optional chains (Release).
    @inline(never) private static func trackChanged(_ old: NativeNow?, _ new: NativeNow?) -> Bool {
        old?.id != new?.id || old?.playing != new?.playing
    }

    func receive(_ value: [String: Any]) -> Bool {
        scheduleStation(value)
        if value["enable"] as? Bool == true { setShown(true, resync: false) }
        if sharedLibrary { refreshLibrary() }
        else { // Pre-migration OPFS fallback: there is no shared SQLite file yet.
            if let rows = value["library"] as? [[String: Any]] {
                library = rows.compactMap(NativeTrack.init)
                byId = Dictionary(library.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
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
        if next != ui { ui = next }
        // A push sent before the page saw native's own navigation must not jump back.
        if let pending, pending.path != next.path, Date().timeIntervalSince(pending.at) < 2 {} else {
            pending = nil
            if path != next.path { path = next.path }
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
        if name == "versions", let id = args["id"] as? String { presentVersions(id: id); return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { @MainActor in
            do { _ = try await call(name, args, timeout: 60) } catch let error as NativeShellError { show(error.localizedDescription) } catch {}
        }
    }

    func presentVersions(id: String, from parent: UIViewController? = nil) {
        Task { @MainActor in
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
            parent.present(controller, animated: true)
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
        byId[id]?.reaction = value
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
        refreshLibrary()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.refreshPlayer(); self?.refreshLibrary() }
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
                self.publishWidget()
            }
            let key = "\(next.entryId)|\(next.artworkReady)"
            if key != self.artworkKey {
                self.artworkKey = key
                self.artwork = (value["artwork"] as? MPMediaItemArtwork)?.image(at: CGSize(width: 120, height: 120))
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
        guard UIApplication.shared.applicationState != .active else { return }
        var next = NativePlayerState(state)
        if ended { next.playing = false }
        guard next.trackId != player.trackId || next.playing != player.playing else { return }
        player = next; publishWidget()
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .top) {
            Color.moraBackground.ignoresSafeArea()
                .sheet(isPresented: Binding(get: { !store.playlistTarget.isEmpty }, set: { if !$0 { store.playlistTarget = [] } })) {
                    NativePlaylistPicker(tracks: store.playlistTarget).environmentObject(store)
                }
            screen.id(store.path)
                .transition(.opacity.combined(with: .offset(x: reduceMotion ? 0 : 18)))
            if store.path != NativeRoute.root(store.tab) {
                // Pages are route switches, not NavigationStack pushes, so iOS gives them no back swipe: this edge does.
                Color.clear.frame(width: 18).frame(maxHeight: .infinity).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 12).onEnded { g in
                        if g.translation.width > 70 && abs(g.translation.height) < g.translation.width { store.back() }
                    })
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityHidden(true)
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
        .safeAreaInset(edge: .top, spacing: 0) {
            if store.offline {
                Label("Нет сети — играет то, что на iPhone", systemImage: "wifi.slash")
                    .font(.footnote.weight(.medium)).foregroundStyle(Color.moraGold)
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                    .background(Color.moraGold.opacity(0.12))
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.25), value: store.offline)
        .animation(.easeOut(duration: 0.25), value: store.banner)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .smooth(duration: 0.32), value: store.path)
        .transaction { if reduceMotion { $0.animation = nil; $0.disablesAnimations = true } }
        .foregroundStyle(.white)
        .tint(.moraMint)
        .environmentObject(store)
        .sheet(isPresented: $store.waveSettingsOpen) {
            NativePageView(waveSource: Binding(get: { store.waveSource ?? store.ui.wave.preferred }, set: { store.waveSource = $0 }))
                .environmentObject(store)
                .tint(.moraMint)
                .presentationDetents([.fraction(0.72), .large])
                .presentationDragIndicator(.visible)
                .preferredColorScheme(.dark)
        }
    }
    @ViewBuilder private var screen: some View {
        switch store.screen {
            case .home: NativeHomeView()
            case .more: NativeMoreView()
            case .liked: NativeTrackListView(title: "Любимое", type: "liked", tracks: store.liked)
            case .library:
                if store.path == "/library" { NativeLibraryView() }
                else { NativeTrackListView(title: "Песни", type: "library", tracks: store.library) }
            case .search: NativeSearchView()
            case .page:
                if store.sharedLibrary && store.path == "/settings" { NativeSettingsView() }
                else if store.sharedLibrary && store.path == "/downloads" { NavigationStack { NativeDownloadsView() } }
                else if store.sharedLibrary && store.path == "/sound" { NativeSoundView() }
                else if store.sharedLibrary && store.path == "/backups" { NativeBackupsView() }
                else { NativePageView() }
            case .web: Color.clear
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

    var body: some View {
        VStack(spacing: 8) {
            if let title = store.miniTitle { mini(title) }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 4)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge) // the bar keeps its height; screens scale fully
        .foregroundStyle(.white)
        .animation(UIAccessibility.isReduceMotionEnabled ? nil : .smooth(duration: 0.3), value: store.miniTitle)
        .animation(UIAccessibility.isReduceMotionEnabled ? nil : .smooth(duration: 0.2), value: store.miniPlaying)
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
                Image(systemName: store.miniPlaying ? "pause.fill" : "play.fill").contentTransition(.symbolEffect(.replace)).font(.title3).frame(width: 44, height: 44)
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
