import Foundation

var job = NativeDownloadJob(trackId: "one", title: "Трек", artist: "Исполнитель", album: "", duration: 180, expectedBytes: 1000)
assert(job.state == .queued)
job.receivedBytes = 400
assert(job.progress == 0.4)
assert(job.eta(elapsed: 4) == 6)
job.apply("pause")
assert(job.state == .paused)
job.apply("resume")
assert(job.state == .queued)
job.apply("cancel")
assert(job.state == .cancelled)
job.apply("resume")
assert(job.state == .cancelled)
let encoded = try JSONEncoder().encode([job])
let restored = try JSONDecoder().decode([NativeDownloadJob].self, from: encoded)
assert(restored == [job])
assert(NativeDownloadJob.retryDelay(attempt: 1) == 10)
assert(NativeDownloadJob.retryDelay(attempt: 99) == 300)
job.receivedBytes = 1400
assert(job.reservedBytes == 1400, "Unknown content length must reserve received bytes")
job.receivedBytes = 400
assert(job.reservedBytes == 1000, "Queued transfers keep their estimate reserved")

assert(NativeDownloadJob.Transfer(sourceKind: "direct", supportsBackground: true) == .background)
assert(NativeDownloadJob.Transfer(sourceKind: "yandex", supportsBackground: true) == .background)
assert(NativeDownloadJob.Transfer(sourceKind: "hls", supportsBackground: true) == .inApp)
assert(NativeDownloadJob.Transfer(sourceKind: "direct", supportsBackground: false) == .inApp)

var completion = NativeDownloadJob(trackId: "two", title: "Трек", artist: "", album: "", duration: 180, expectedBytes: 1000)
completion.state = .downloading
completion.finish(.failure(CocoaError(.fileWriteOutOfSpace)))
assert(completion.state == .failed && completion.error != nil, "A successful transfer that cannot be saved is retryable")
completion.finish(.success(1100))
assert(completion.state == .done && completion.progress == 1 && completion.receivedBytes == 1100 && completion.error == nil)
print("Native download queue passed")