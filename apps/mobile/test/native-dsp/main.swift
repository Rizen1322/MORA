import Foundation
import JavaScriptCore

// Offline portability check only. Never call a JSContext from an audio render callback.
enum CheckError: Error { case failed(String) }
guard CommandLine.arguments.count == 3 else { throw CheckError.failed("Expected bundle and output paths") }
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let vm = JSVirtualMachine()!
let context = JSContext(virtualMachine: vm)!
var exception: String?
context.exceptionHandler = { _, value in exception = value?.toString() ?? "Unknown JavaScript exception" }
context.evaluateScript(try String(contentsOf: sourceURL, encoding: .utf8), withSourceURL: sourceURL)
if let exception { throw CheckError.failed(exception) }
let result = context.evaluateScript("JSON.stringify(MoraDspCheck.run())")
if let exception { throw CheckError.failed(exception) }
guard let json = result?.toString(), let data = json.data(using: .utf8), !result!.isUndefined else {
    throw CheckError.failed("DSP check did not return JSON")
}
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
print("Native JavaScriptCore rendered existing MixerCore fixtures")
