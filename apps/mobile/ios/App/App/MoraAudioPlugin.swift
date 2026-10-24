import AVFoundation
import Capacitor
import Security
import UIKit
import WebKit

/// Web view for MORA: inline WebAudio without a tap per sound, and the MoraAudio plugin.
class MoraBridgeViewController: CAPBridgeViewController {
    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // WebKit can mute a hidden page's audio. This preference is not public API: it is set
        // only when this WebKit has it, for a personally installed build (not for App Store review).
        if config.preferences.responds(to: NSSelectorFromString("_setRequiresPageVisibilityToPlayAudio:")) {
            config.preferences.setValue(false, forKey: "requiresPageVisibilityToPlayAudio")
        }
        return config
    }

    override open var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MoraAudioPlugin())
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
        webView?.isOpaque = false
        webView?.backgroundColor = UIColor(red: 5 / 255, green: 13 / 255, blue: 10 / 255, alpha: 1)
    }
}

/// WebKit owns Now Playing and remote commands. Native code handles genuine
/// interruptions, route changes and power notifications for the WebAudio player.
@objc(MoraAudioPlugin)
public class MoraAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MoraAudioPlugin"
    public let jsName = "MoraAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setPlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "power", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretKey", returnType: CAPPluginReturnPromise),
    ]

    private var playing = false
    private var webAudioSession = false
    private var resumeAfterInterruption = false

    override public func load() {
        let nc = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        nc.addObserver(self, selector: #selector(interruption(_:)), name: AVAudioSession.interruptionNotification, object: session)
        nc.addObserver(self, selector: #selector(routeChange(_:)), name: AVAudioSession.routeChangeNotification, object: session)
        nc.addObserver(self, selector: #selector(mediaReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: session)
        // Heat and Low Power Mode: the web side stills animations and defers optional work (Apple's
        // thermal guidance: from "serious" on, reduce CPU/GPU use, screen updates and animations).
        nc.addObserver(self, selector: #selector(powerChanged(_:)), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(powerChanged(_:)), name: .NSProcessInfoPowerStateDidChange, object: nil)
    }

    private func send(_ action: String) {
        notifyListeners("command", data: ["action": action])
    }

    @objc func setPlaybackState(_ call: CAPPluginCall) {
        let wasPlaying = playing
        playing = call.getBool("playing") ?? playing
        webAudioSession = call.getBool("webAudioSession") ?? webAudioSession
        // WebKit owns navigator.audioSession. Re-activating its session from another
        // process while it starts playback can interrupt the sound we just started.
        if playing && !wasPlaying && !webAudioSession { MoraAudioSession.activate() }
        call.resolve()
    }

    private func powerState() -> [String: Any] {
        let p = ProcessInfo.processInfo
        return ["thermal": p.thermalState.rawValue, "lowPower": p.isLowPowerModeEnabled]
    }

    @objc func power(_ call: CAPPluginCall) {
        call.resolve(powerState())
    }

    /// Key that seals provider tokens in the library database (AES-GCM in the web worker).
    @objc func secretKey(_ call: CAPPluginCall) {
        if let key = MoraKeychain.secretKey() { call.resolve(["key": key]) }
        else { call.reject("Keychain недоступен") }
    }

    @objc private func powerChanged(_ n: Notification) {
        notifyListeners("power", data: powerState())
    }

    @objc private func interruption(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            // "The app was suspended" is not a real interruption (Apple: ignore it); pausing on it
            // is what stopped playback by itself. Only a genuine one (call, Siri, alarm) pauses.
            if n.userInfo?[AVAudioSessionInterruptionWasSuspendedKey] as? Bool == true { return }
            if #available(iOS 16.0, *),
               let r = n.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt,
               AVAudioSession.InterruptionReason(rawValue: r) == .appWasSuspended { return }
            resumeAfterInterruption = playing
            send("pause")
        case .ended:
            let opts = AVAudioSession.InterruptionOptions(rawValue: n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            if resumeAfterInterruption && opts.contains(.shouldResume) {
                if !webAudioSession { MoraAudioSession.activate() }
                send("play")
            }
            resumeAfterInterruption = false
        @unknown default:
            break
        }
    }

    @objc private func routeChange(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        // headphones unplugged / Bluetooth gone: pause instead of playing out loud
        if reason == .oldDeviceUnavailable && playing { send("pause") }
    }

    @objc private func mediaReset(_ n: Notification) {
        if playing {
            if !webAudioSession { MoraAudioSession.activate() }
            send("play")
        }
    }
}

enum MoraKeychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "ru.mora.secrets",
        kSecAttrAccount as String: "library-key",
    ]

    /// 32 random bytes as hex, created once. This device only, readable after the first unlock:
    /// a locked phone playing in the background can still open the library.
    static func secretKey() -> String? {
        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 {
            return data.map { String(format: "%02x", $0) }.joined()
        }
        // Only a key that does not exist is created: a locked keychain must never replace it
        // (the tokens sealed with the old one would be lost).
        guard status == errSecItemNotFound else { return nil }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        var add = query
        add[kSecValueData as String] = Data(bytes)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

enum MoraAudioSession {
    private static let queue = DispatchQueue(label: "ru.mora.audio-session")
    /// Music app: plays with the screen locked, ignores the silent switch, AirPlay/Bluetooth allowed.
    /// Off the main thread: setActive can block the UI (Xcode warns "can lead to UI unresponsiveness").
    static func activate() {
        queue.async {
            let s = AVAudioSession.sharedInstance()
            do {
                // Same configuration WebKit applies for navigator.audioSession.type = 'playback':
                // a different policy here made the two re-configure (and interrupt) each other.
                if s.category != .playback || s.mode != .default || s.routeSharingPolicy != .default {
                    try s.setCategory(.playback, mode: .default, policy: .default, options: [])
                }
                try s.setActive(true)
            } catch {
                NSLog("[MORA] audio session: \(error)")
            }
        }
    }
}
