import Foundation

precondition(NativePlayerTime.text(0) == "0:00")
precondition(NativePlayerTime.text(65.9) == "1:05")
precondition(NativePlayerTime.text(3725) == "1:02:05")
precondition(NativePlayerTime.text(-3) == "0:00" && NativePlayerTime.text(.nan) == "0:00" && NativePlayerTime.text(.infinity) == "0:00")
print("Native player: time labels")

let prepared: [[String: Any]] = [["entryId": "b", "trackId": "track-b", "title": "B", "artist": "Y", "transition": ["triggerFrame": 1.0]],
                                 ["entryId": "c", "title": "C", "artist": "Z"]]
// The manifest still lists the audible and prepared entries; only its tail is new.
let manifest: [[String: Any]] = [["entryId": "a", "title": "A"], ["entryId": "b", "title": "B", "coverUrl": "https://img/b.jpg", "artwork": ["base64": "embedded-b"]],
                                 ["entryId": "c", "title": "C"], ["entryId": "d", "title": "D", "coverUrl": "http://img/d.jpg"], ["entryId": "e", "title": "E"]]
let rows = NativePlayerState.queue(current: "a", prepared: prepared, manifest: manifest)
precondition(rows.map(\.id) == ["b", "c", "d", "e"], "\(rows.map(\.id))")
precondition(rows[0].automix && !rows[1].automix && !rows[2].automix)
precondition(rows[0].cover == "https://img/b.jpg" && rows[2].cover == nil)
precondition(rows[0].trackId == "track-b" && rows[0].artwork == "embedded-b")
let local = NativePlayerState.queue(current: "a", prepared: [], manifest: [["entryId": "local", "trackId": "track-local", "artwork": ["base64": "embedded-local"]]])
precondition(local[0].trackId == "track-local" && local[0].cover == nil && local[0].artwork == "embedded-local")
precondition(NativePlayerState.queue(current: "", prepared: [], manifest: [["entryId": "x", "coverUrl": "/api/tracks/x/cover"]])[0].cover == "/api/tracks/x/cover")
// A stale manifest without known entries is shown whole; duplicates appear once.
precondition(NativePlayerState.queue(current: "x", prepared: [], manifest: manifest + [["entryId": "e"]]).map(\.id) == ["a", "b", "c", "d", "e"])
precondition(NativePlayerState.queue(current: "a", prepared: [], manifest: []).isEmpty)
print("Native player: queue rows")

var state = NativePlayerState(["active": true, "playing": true, "position": 300.0, "duration": 200.0, "entryId": "a",
    "currentTrack": ["title": "A", "artist": "X", "trackId": "track-a"], "blend": NSNull(), "upcoming": prepared, "manifestItems": manifest])
precondition(state.active && state.playing && !state.blending && state.title == "A" && state.position == 200)
precondition(state.trackId == "track-a")
precondition(state.nextLabel == "AutoMix · далее «B»" && state.automix)
state.upcoming.removeFirst()
precondition(state.nextLabel == "Далее: C" && !state.automix)
state.blending = true
precondition(state.nextLabel == "Уже входит в микс" && state.automix)
precondition(NativePlayerState([:]).nextLabel == nil && NativePlayerState([:]) == NativePlayerState())
print("Native player: state and «Далее» pill")

let mix = NativePlayerState(["active": true, "duration": 200.0, "transitionStart": 180.0,
    "upcoming": [["entryId": "b", "transition": ["durationFrames": 48000.0 * 30]]]])
precondition(mix.mixStart == 180 && mix.mixLength == 20, "window clipped to the track end")
precondition(NativePlayerState(["duration": 200.0, "transitionStart": 250.0]).mixStart == nil)
precondition(NativePlayerState(["duration": 200.0, "transitionStart": 10.0]).mixLength == 0)
print("Native player: AutoMix window")
