import Foundation

let state = NativeActivityState(trackId: "one", title: "Трек", artist: "Исполнитель", artwork: nil,
    isPlaying: true, position: 12, duration: 180, offline: true, liked: false)
let encoded = try JSONEncoder().encode(state)
assert(encoded.count < 4096)
let decoded = try JSONDecoder().decode(NativeActivityState.self, from: JSONEncoder().encode(state))
assert(decoded == state)
print("Native activity state passed")
