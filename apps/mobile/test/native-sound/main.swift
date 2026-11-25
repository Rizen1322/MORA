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
    [3, 2.5, 1.5, 0, 0, 0, 0, 0.5, 1.5, 2], [3.5, 3, 1, 0, -1, -0.5, 0.5, 1.5, 2.5, 2],
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

func playback(_ patch: [String: Any]) -> [String: Any] {
    require(patch.count == 1, "Playback patch must not touch other settings groups")
    let sound = patch["sound"] as! [String: Any]
    require(sound.count == 1 && sound["tone"] == nil, "Playback patch must not touch tone or presets")
    return sound["playback"] as! [String: Any]
}

// Present optional fields & clamping on existing fixture
require(state.balance == 0.25 && state.mono && state.reverbMix == 0.2, "Tone stage fields parsed from settings")
require(state.speed == 1.2 && state.semitones == 0.0, "Playback speed clamped to 1.2 and omitted semitones defaults to 0")

// Minimal backwards-compatible fixture with only tone.enabled + tone.gains
let minimal = try NativeSoundState(["sound": ["tone": ["enabled": false, "gains": flat]]])
require(minimal.balance == 0.0 && !minimal.mono && minimal.reverbMix == 0.0, "Omitted tone stage fields fall back to neutral defaults")
require(minimal.speed == 1.0 && minimal.semitones == 0.0, "Omitted playback object falls back to neutral defaults")

// Reject booleans and non-finite doubles while clamping out-of-range values
let sanitized = try NativeSoundState([
    "sound": [
        "tone": ["enabled": true, "gains": flat, "balance": true, "mono": 1, "reverbMix": Double.nan],
        "playback": ["speed": false, "semitones": Double.infinity],
    ]
])
require(sanitized.balance == 0.0 && !sanitized.mono && sanitized.reverbMix == 0.0, "Boolean/non-finite optional tone fields fall back safely")
require(sanitized.speed == 1.0 && sanitized.semitones == 0.0, "Boolean/non-finite playback fields fall back safely")

let clamped = try NativeSoundState([
    "sound": [
        "tone": ["enabled": false, "gains": flat, "balance": -9.0, "mono": false, "reverbMix": 2.0],
        "playback": ["speed": 1.07, "semitones": 2.26],
    ]
])
require(clamped.balance == -1.0 && clamped.reverbMix == 0.35, "Tone balance and reverb clamp to valid ranges")
require(clamped.speed == 1.07 && clamped.semitones == 2.5, "Playback speed preserves hundredths and semitones round to half-step")

let extremePlayback = try NativeSoundState([
    "sound": [
        "tone": ["enabled": false, "gains": flat],
        "playback": ["speed": 0.4, "semitones": -9.5],
    ]
])
require(extremePlayback.speed == 0.8 && extremePlayback.semitones == -6.0, "Lower playback bounds clamp cleanly")

// Partial tone patches for balance, mono, reverbMix
let balActive = tone(try minimal.patch(.balance(0.27)))
require(balActive.count == 2 && balActive["balance"] as? Double == 0.25 && balActive["enabled"] as? Bool == true, "Non-zero balance rounds to 0.05 and activates tone")
let balClamped = tone(try minimal.patch(.balance(-9.0)))
require(balClamped["balance"] as? Double == -1.0 && balClamped["enabled"] as? Bool == true, "Extreme balance clamps to -1.0")
let balCenter = tone(try state.patch(.balance(-0.02)))
require(balCenter.count == 1 && balCenter["balance"] as? Double == 0.0, "Centering balance avoids -0.0 and omits enabled")

let monoOn = tone(try minimal.patch(.mono(true)))
require(monoOn.count == 2 && monoOn["mono"] as? Bool == true && monoOn["enabled"] as? Bool == true, "Enabling mono activates tone and omits other keys")
let monoOff = tone(try state.patch(.mono(false)))
require(monoOff.count == 1 && monoOff["mono"] as? Bool == false, "Disabling mono omits enabled and other tone keys")

let revActive = tone(try minimal.patch(.reverbMix(0.224)))
require(revActive.count == 2 && revActive["reverbMix"] as? Double == 0.22 && revActive["enabled"] as? Bool == true, "Positive reverbMix rounds to 0.01 and activates tone")
let revClamped = tone(try minimal.patch(.reverbMix(1.5)))
require(revClamped["reverbMix"] as? Double == 0.35 && revClamped["enabled"] as? Bool == true, "ReverbMix clamps at 0.35")
let revZero = tone(try state.patch(.reverbMix(-0.5)))
require(revZero.count == 1 && revZero["reverbMix"] as? Double == 0.0, "Negative reverbMix clamps to 0.0")

// Playback patches preserve the sibling field across fresh-GET rebasing
let activePlayback = try NativeSoundState([
    "sound": [
        "tone": ["enabled": true, "gains": flat],
        "playback": ["speed": 1.1, "semitones": 2.5],
    ]
])
let speedPatch = playback(try activePlayback.patch(.speed(0.954)))
require(speedPatch.count == 2 && speedPatch["speed"] as? Double == 0.95 && speedPatch["semitones"] as? Double == 2.5, "Speed edit rounds to 0.01 and preserves semitones")
let speedMax = playback(try activePlayback.patch(.speed(9.0)))
require(speedMax["speed"] as? Double == 1.2 && speedMax["semitones"] as? Double == 2.5, "Speed clamps at 1.2")
let speedMin = playback(try activePlayback.patch(.speed(0.1)))
require(speedMin["speed"] as? Double == 0.8 && speedMin["semitones"] as? Double == 2.5, "Speed clamps at 0.8")

let semiPatch = playback(try activePlayback.patch(.semitones(-3.24)))
require(semiPatch.count == 2 && semiPatch["semitones"] as? Double == -3.0 && semiPatch["speed"] as? Double == 1.1, "Semitones edit rounds to 0.5 and preserves speed")
let semiTie = playback(try activePlayback.patch(.semitones(-0.25)))
require(semiTie["semitones"] as? Double == 0.0, "Negative half-step tie matches Math.round without -0.0")
let semiClamped = playback(try activePlayback.patch(.semitones(-99.0)))
require(semiClamped["semitones"] as? Double == -6.0, "Semitones clamp at -6.0")

// Reset patches
let resetPlay = playback(try activePlayback.patch(.resetPlayback))
require(resetPlay.count == 2 && resetPlay["speed"] as? Double == 1.0 && resetPlay["semitones"] as? Double == 0.0, "Reset playback restores neutral speed and semitones")
let resetStage = tone(try state.patch(.resetTone))
require(resetStage.count == 3 && resetStage["balance"] as? Double == 0.0 && resetStage["mono"] as? Bool == false && resetStage["reverbMix"] as? Double == 0.0, "Reset tone restores neutral stage without forcing enabled")

// Non-finite patch rejections and JSON validity
for value in [Double.nan, Double.infinity, -Double.infinity] {
    rejects("Non-finite balance accepted") { _ = try state.patch(.balance(value)) }
    rejects("Non-finite reverbMix accepted") { _ = try state.patch(.reverbMix(value)) }
    rejects("Non-finite speed accepted") { _ = try state.patch(.speed(value)) }
    rejects("Non-finite semitones accepted") { _ = try state.patch(.semitones(value)) }
}
for edit in [NativeSoundState.Edit.balance(0.15), .mono(true), .reverbMix(0.25), .speed(1.1), .semitones(-2.5), .resetPlayback, .resetTone] {
    let data = try JSONSerialization.data(withJSONObject: activePlayback.patch(edit))
    require(!data.isEmpty, "Sound edit patch is valid JSON")
}

print("Native sound: stage balance/mono/reverb, playback speed/semitones, defaults, clamping, resets and partial patches passed")
