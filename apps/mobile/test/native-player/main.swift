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
precondition(rows[0].cover?.absoluteString == "https://img/b.jpg" && rows[2].cover == nil)
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
