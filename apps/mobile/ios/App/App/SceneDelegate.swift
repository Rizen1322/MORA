import UIKit
import Capacitor
import CoreSpotlight

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private static var coldLaunchClaimed = false

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // During foreground scene connection UIApplication can still report .background.
        let showSplash = !Self.coldLaunchClaimed && !AppDelegate.backgroundLaunch
            && connectionOptions.urlContexts.isEmpty && connectionOptions.userActivities.isEmpty
            && connectionOptions.shortcutItem == nil
        Self.coldLaunchClaimed = true
        let root = MoraRootViewController()
        root.showLaunchSplash = showSplash
        NativeDeepLink.splashVisible = showSplash
        window?.rootViewController = root
        window?.makeKeyAndVisible()

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
