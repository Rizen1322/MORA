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
