import Foundation

func require(_ condition: Bool, _ message: String) { precondition(condition, message) }
func rejects(_ message: String, _ operation: () throws -> Void) {
    do { try operation(); fatalError(message) } catch {}
}
func settings(_ gains: [Double], enabled: Bool = false, presets: [[String: Any]] = []) -> [String: Any] {
    ["sound": ["tone": ["enabled": enabled, "gains": gains, "preampDb": -3, "autoHeadroom": false, "balance": 0.25, "mono": true, "reverbMix": 0.2],
               "presets": presets, "playback": ["speed": 1.25], "futureSoundOption": "keep"],
     "automix": ["enabled": false], "ui": ["motion": "reduced"]]
}
func tone(_ patch: [String: Any]) -> [String: Any] {
    require(patch.count == 1, "EQ patch must not touch other settings groups")
    let sound = patch["sound"] as! [String: Any]
    require(sound.count == 1, "EQ patch must not replace presets, playback or unknown sound fields")
    return sound["tone"] as! [String: Any]
}
let flat = Array(repeating: 0.0, count: 10)
let state = try NativeSoundState(settings(flat))
require(NativeSoundState.bands == [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], "Core EQ frequency order")
require(NativeSoundState.maxDB == 12 && state.gains == flat && !state.enabled, "EQ range and disabled state")
require(NativeSoundState.bandLabel(31) == "31 Гц" && NativeSoundState.bandLabel(1000) == "1 кГц" && NativeSoundState.bandLabel(16000) == "16 кГц", "Band labels")
require(state.presets.map(\.name) == ["Ровно", "Больше баса", "Вокал", "Тихое прослушивание", "Электроника"], "Built-in preset order")
require(state.presets.map(\.gains) == [
    flat, [4, 3.5, 2.5, 1, 0, 0, 0, 0, 0, 0], [-1.5, -1, 0, 0.5, 1.5, 2.5, 2.5, 1.5, 0, -0.5],
    [3, 2.5, 1.5, 0, 0, 0, 0, 0, 0.5, 1.5, 2], [3.5, 3, 1, 0, -1, -0.5, 0.5, 1.5, 2.5, 2],
], "Core built-in gains")
require(state.selectedPreset == 0, "Disabled EQ still identifies its saved preset")

let on = tone(try state.patch(.enabled(true)))
require(on.count == 1 && on["enabled"] as? Bool == true, "Enable patch leaves gains and all other tone fields untouched")
let disabled = tone(try state.patch(.enabled(false)))
require(disabled["enabled"] as? Bool == false, "Disable patch")
for (input, expected) in [(1.24, 1.0), (1.25, 1.5), (-1.25, -1.0), (-0.25, 0.0), (-0.26, -0.5), (99.0, 12.0), (-99.0, -12.0)] {
    let changed = tone(try state.patch(.band(3, input)))
    let gains = changed["gains"] as! [Double]
    require(changed.count == 2 && changed["enabled"] as? Bool == true, "Band edit enables EQ, omitting all other tone fields")
    require(gains[3] == expected && gains.enumerated().allSatisfy { $0.offset == 3 || $0.element == 0 }, "Half-decibel rounding, clamping and band isolation")
}
let external = try NativeSoundState(settings([0, 7, 0, 0, 0, 0, 0, 0, 0, 0], enabled: true))
let rebased = tone(try external.patch(.band(0, 3)))
require((rebased["gains"] as? [Double]) == [3, 7, 0, 0, 0, 0, 0, 0, 0, 0], "Applying to a fresh GET preserves external edits to other bands")
require(state.gains == flat, "Patch construction does not mutate the screen's snapshot")

let customGains = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
let custom = try NativeSoundState(settings(customGains, presets: [["name": "Мой", "gains": customGains], ["name": "Ровно", "gains": flat]]))
require(custom.presets.count == 7 && custom.selectedPreset == 5, "Custom presets follow built-ins, including duplicate names")
let selected = tone(try state.patch(.preset(custom.presets[5])))
require(selected["enabled"] as? Bool == true && selected["gains"] as? [Double] == customGains, "Selecting a custom preset preserves its tenth-decibel values")
let presetJSON = try JSONSerialization.data(withJSONObject: state.patch(.preset(state.presets[1])))
let decoded = try JSONSerialization.jsonObject(with: presetJSON) as! [String: Any]
require((tone(decoded)["gains"] as? [Double]) == state.presets[1].gains, "Patch is valid JSON")
let unlisted = try NativeSoundState(settings(Array(repeating: 1.0, count: 10)))
require(unlisted.selectedPreset == nil, "An edited curve displays Свой")
let closeToFlat = try NativeSoundState(settings(Array(repeating: 0.04, count: 10)))
let farFromFlat = try NativeSoundState(settings(Array(repeating: 0.06, count: 10)))
require(closeToFlat.selectedPreset == 0 && farFromFlat.selectedPreset == nil, "Preset matching uses the existing 0.05dB tolerance")

for index in [-1, 10] { rejects("Invalid band accepted") { _ = try state.patch(.band(index, 0)) } }
for value in [Double.nan, Double.infinity, -Double.infinity] { rejects("Invalid gain accepted") { _ = try state.patch(.band(0, value)) } }
rejects("Invalid preset accepted") { _ = try state.patch(.preset(.init(name: "Bad", gains: [0]))) }
rejects("Out-of-range preset accepted") { _ = try state.patch(.preset(.init(name: "Bad", gains: Array(repeating: 13, count: 10)))) }
rejects("Missing sound accepted") { _ = try NativeSoundState([:]) }
rejects("Incorrect band count accepted") { _ = try NativeSoundState(settings([0])) }
rejects("Non-finite server gains accepted") { _ = try NativeSoundState(settings(Array(repeating: .nan, count: 10))) }
rejects("Out-of-range server gains accepted") { _ = try NativeSoundState(settings(Array(repeating: 13, count: 10))) }
rejects("Boolean gain accepted") {
    _ = try NativeSoundState(["sound": ["tone": ["enabled": true, "gains": [true, 0, 0, 0, 0, 0, 0, 0, 0, 0]]]])
}
print("Native sound: EQ bands, built-in/custom presets, half-decibel edits, partial patches and fresh-state rebasing passed")
