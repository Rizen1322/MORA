import Foundation
import JavaScriptCore

// Tests the actual Apple runtime, complementing the Windows ECMAScript parity tests.
let context = JSContext()!
var failure: String?
context.exceptionHandler = { _, error in failure = error?.toString() ?? "JavaScript error" }
context.evaluateScript(try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))
let request = #"{"a":{"id":"a","duration":180,"mixingAllowed":true,"analysis":null},"b":{"id":"b","duration":200,"mixingAllowed":true,"analysis":null}}"#
let result = context.objectForKeyedSubscript("MoraCore")?.invokeMethod("planJSON", withArguments: [request])
guard failure == nil, let text = result?.toString(), let data = text.data(using: .utf8),
      let plan = try JSONSerialization.jsonObject(with: data) as? [String: Any], plan["fromTrackId"] as? String == "a" else {
    fatalError(failure ?? "Planner JSON bridge failed")
}
print("Apple JavaScriptCore planner smoke passed:", plan["version"] ?? "unknown")
