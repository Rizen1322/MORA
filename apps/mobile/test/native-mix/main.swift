import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let configs = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("configs.json"))) as! [[String: Any]]
var all: [[String: Any]] = []
var output = Data()
var maxMs = 0.0
for config in configs {
    let renderer = try NativeQueueRenderer(folder: directory, config: config)
    var blocks: [[String: Any]] = []
    for _ in 0..<240 {
        let began = ProcessInfo.processInfo.systemUptime
        let block = try renderer.render()
        maxMs = max(maxMs, (ProcessInfo.processInfo.systemUptime - began) * 1000)
        output.append(block.left); output.append(block.right)
        blocks.append(["frames": block.frames, "done": block.done,
            "marks": block.marks.map { ["offset": $0.frame, "index": $0.index, "position": $0.position] as [String: Any] },
            "events": block.events.map { $0["type"] as? String ?? "unknown" }])
        if block.done { break }
    }
    guard blocks.last?["done"] as? Bool == true else { fatalError("Native queue did not end") }
    all.append(["blocks": blocks])
}
try output.write(to: directory.appendingPathComponent("actual.f32le"))
try JSONSerialization.data(withJSONObject: all).write(to: directory.appendingPathComponent("actual.json"))
print("Native PCM files -> Swift mixer queue passed; max producer block \(maxMs) ms (macOS only)")
// A plan upgrade must preserve all later PCM tracks and reject a trigger that
// is already behind the source position rendered into the output queue.
let upgraded = try NativeQueueRenderer(folder: directory, config: configs[0])
let rawTracks = configs[0]["tracks"] as! [[String: Any]]
_ = try upgraded.render()
let acceptedUpgrade = try upgraded.upgrade(index: 1, track: rawTracks[1])
precondition(acceptedUpgrade)
precondition(upgraded.trackCount == 3)
var late = rawTracks[1], latePlan = late["transition"] as! [String: Any]
latePlan["triggerFrame"] = 0.0; late["transition"] = latePlan
let acceptedLateUpgrade = try upgraded.upgrade(index: 1, track: late)
precondition(!acceptedLateUpgrade)
var upgradedIndexes = Set<Int>()
for _ in 0..<240 {
    let block = try upgraded.render()
    upgradedIndexes.formUnion(block.marks.map { $0.index })
    if block.done { break }
}
precondition(upgradedIndexes.contains(2) && upgraded.trackCount == 3)
print("Native future plan upgrade: render horizon and three-track tail preserved")
