import Foundation

/// Native player hooks that must work before the page is up (a Siri or widget cold start).
@MainActor enum NativePlaybackHooks {
    static func install(_ host: NativeMixHost) {
        // A Siri cold start has no page yet; keep reactions in the existing durable outbox.
        if host.onReaction == nil {
            host.onReaction = { id, desired in
                if let store = NativeShellStore.shared {
                    let value = store.reaction(id) == desired ? 0 : desired
                    store.react(id: id, value: value); return value
                }
                var outbox = NativeReactionOutbox()
                let value = outbox.pending[id] == desired ? 0 : desired
                outbox.set(id, value); return value
            }
            host.reactionState = { id in NativeShellStore.shared?.reaction(id) ?? NativeReactionOutbox().pending[id] ?? 0 }
        }
        host.onNowPlaying = { state, ended in NativeShellStore.shared?.nativePlaybackChanged(state, ended: ended) }
        NativePlaybackActions.handler = { [weak host] in
            guard let host, host.active else { return }
            _ = await withCheckedContinuation { done in host.command("toggle", source: "control") { done.resume(returning: $0) } }
        }
    }
}
