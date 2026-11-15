import UIKit
import Capacitor
import CoreSpotlight

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private static var coldLaunchClaimed = false
    private static let background = UIColor(red: 5 / 255, green: 13 / 255, blue: 10 / 255, alpha: 1)

    /// An AirPlay receiver shows this instead of a second copy of the app: the sound keeps playing on the iPhone.
    private static func externalDisplay() -> UIViewController {
        let controller = UIViewController()
        controller.view.backgroundColor = background
        let mark = UILabel()
        mark.text = "MORA"
        mark.textColor = UIColor(red: 74 / 255, green: 222 / 255, blue: 154 / 255, alpha: 1)
        mark.font = .systemFont(ofSize: 64, weight: .bold)
        mark.translatesAutoresizingMaskIntoConstraints = false
        let note = UILabel()
        note.text = "Играет на iPhone"
        note.textColor = .white.withAlphaComponent(0.6)
        note.font = .systemFont(ofSize: 20, weight: .medium)
        note.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(mark)
        controller.view.addSubview(note)
        NSLayoutConstraint.activate([
            mark.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor, constant: -18),
            note.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
            note.topAnchor.constraint(equalTo: mark.bottomAnchor, constant: 10),
        ])
        return controller
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        // AirPlay and other external displays connect a second scene. Building the whole app there would
        // give one process two shells, two Capacitor pages and two stores around one native server.
        guard session.role == .windowApplication else {
            window = UIWindow(windowScene: windowScene)
            window?.backgroundColor = Self.background
            window?.rootViewController = Self.externalDisplay()
            window?.makeKeyAndVisible()
            return
        }

        window = UIWindow(windowScene: windowScene)
        // During foreground scene connection UIApplication can still report .background.
        let showSplash = !Self.coldLaunchClaimed && !AppDelegate.backgroundLaunch
            && connectionOptions.urlContexts.isEmpty && connectionOptions.userActivities.isEmpty
            && connectionOptions.shortcutItem == nil
        Self.coldLaunchClaimed = true
        let root = MoraRootViewController()
        NativeDeepLink.splashVisible = showSplash
        window?.rootViewController = root
        window?.makeKeyAndVisible()
        if showSplash, let window { NativeSplashView.present(in: window) { [weak root] in root?.shell.ui.loaded == true } }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // A widget that launched the app: handled once the page is up.
        connectionOptions.urlContexts.forEach { NativeDeepLink.open($0.url) }
        if let shortcut = connectionOptions.shortcutItem { _ = AppDelegate.handleShortcut(shortcut) }
        connectionOptions.userActivities.forEach { handleSearch($0) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let ours = URLContexts.filter { $0.url.scheme == NativeDeepLink.scheme }
        ours.forEach { NativeDeepLink.open($0.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts.subtracting(ours))
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if handleSearch(userActivity) { return }
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    @discardableResult private func handleSearch(_ activity: NSUserActivity) -> Bool {
        guard activity.activityType == CSSearchableItemActionType,
              let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
              let url = URL(string: "mora://track/\(id)"), NativeTrackLink(url) != nil else { return false }
        NativeDeepLink.open(url)
        return true
    }
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(AppDelegate.handleShortcut(shortcutItem))
    }
}
