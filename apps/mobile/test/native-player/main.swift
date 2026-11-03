import Foundation

precondition(NativePlayerTime.text(0) == "0:00")
precondition(NativePlayerTime.text(65.9) == "1:05")
precondition(NativePlayerTime.text(3725) == "1:02:05")
precondition(NativePlayerTime.text(-3) == "0:00" && NativePlayerTime.text(.nan) == "0:00" && NativePlayerTime.text(.infinity) == "0:00")
print("Native player: time labels")

let prepared: [[String: Any]] = [["entryId": "b", "title": "B", "artist": "Y", "transition": ["triggerFrame": 1.0]],
                                 ["entryId": "c", "title": "C", "artist": "Z"]]
// The manifest still lists the audible and prepared entries; only its tail is new.
let manifest: [[String: Any]] = [["entryId": "a", "title": "A"], ["entryId": "b", "title": "B", "coverUrl": "https://img/b.jpg"],
                                 ["entryId": "c", "title": "C"], ["entryId": "d", "title": "D", "coverUrl": "http://img/d.jpg"], ["entryId": "e", "title": "E"]]
let rows = NativePlayerState.queue(current: "a", prepared: prepared, manifest: manifest)
precondition(rows.map(\.id) == ["b", "c", "d", "e"], "\(rows.map(\.id))")
precondition(rows[0].automix && !rows[1].automix && !rows[2].automix)
precondition(rows[0].cover == "https://img/b.jpg" && rows[2].cover == nil)
precondition(NativePlayerState.queue(current: "", prepared: [], manifest: [["entryId": "x", "coverUrl": "/api/tracks/x/cover"]])[0].cover == "/api/tracks/x/cover")
// A stale manifest without known entries is shown whole; duplicates appear once.
precondition(NativePlayerState.queue(current: "x", prepared: [], manifest: manifest + [["entryId": "e"]]).map(\.id) == ["a", "b", "c", "d", "e"])
precondition(NativePlayerState.queue(current: "a", prepared: [], manifest: []).isEmpty)
print("Native player: queue rows")

var state = NativePlayerState(["active": true, "playing": true, "position": 300.0, "duration": 200.0, "entryId": "a",
    "currentTrack": ["title": "A", "artist": "X"], "blend": NSNull(), "upcoming": prepared, "manifestItems": manifest])
precondition(state.active && state.playing && !state.blending && state.title == "A" && state.position == 200)
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

precondition(NativePlayerState(["currentTrack": ["trackId": "t1"]]).trackId == "t1")
let b = NativePlayerRow(id: "b", title: "", artist: "", automix: false, cover: nil)
let c = NativePlayerRow(id: "c", title: "", artist: "", automix: false, cover: nil)
let d = NativePlayerRow(id: "d", title: "", artist: "", automix: false, cover: nil)
// Move: the edited order shows until the host reports it.
let moved = NativeQueueEdit(order: ["c", "b", "d"])
precondition(moved.apply([b, c, d]).map(\.id) == ["c", "b", "d"] && !moved.landed([b, c, d]) && moved.landed([c, b, d]))
// Remove/swap: the row stays hidden; a Wave refill appended after the edit still counts as landed.
let removed = NativeQueueEdit(order: ["b", "c"], removed: ["d"])
precondition(removed.apply([b, c, d]).map(\.id) == ["b", "c"] && !removed.landed([b, c, d]) && removed.landed([b, c, NativePlayerRow(id: "e", title: "", artist: "", automix: false, cover: nil)]))
let swapped = NativeQueueEdit(order: [], removed: ["b"])
precondition(swapped.apply([b, c, d]).map(\.id) == ["c", "d"] && swapped.landed([d, c]))
print("Native player: pending queue edits")
