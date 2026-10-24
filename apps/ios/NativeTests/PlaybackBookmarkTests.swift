import XCTest
@testable import MORACore

final class PlaybackBookmarkTests: XCTestCase {
    func testRoundTripPreservesQueueOrderDuplicatesAndPosition() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mora-bookmark-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = UUID()
        let bookmark = PlaybackBookmark(queue: [id, UUID(), id], index: 2, position: 73.25)
        let store = PlaybackBookmarkStore(directory: directory)
        XCTAssertNil(try store.load())
        try store.save(bookmark)
        XCTAssertEqual(try store.load(), bookmark)
    }

    func testInvalidWriteDoesNotOverwritePreviousBookmark() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mora-bookmark-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PlaybackBookmarkStore(directory: directory)
        let original = PlaybackBookmark(queue: [UUID()], index: 0, position: 42)
        try store.save(original)
        XCTAssertThrowsError(try store.save(PlaybackBookmark(queue: original.queue, index: 5, position: 0)))
        XCTAssertEqual(try store.load(), original)
    }

    func testCorruptFileIsReportedAndPreserved() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mora-bookmark-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("playback.json")
        let invalid = Data("broken archive".utf8)
        try invalid.write(to: file)
        XCTAssertThrowsError(try PlaybackBookmarkStore(directory: directory).load())
        XCTAssertEqual(try Data(contentsOf: file), invalid)
    }

    func testRejectsInvalidBoundsAndUnknownVersion() {
        XCTAssertThrowsError(try PlaybackBookmark(queue: [], index: 0, position: 0).validate())
        XCTAssertThrowsError(try PlaybackBookmark(queue: [UUID()], index: -1, position: 0).validate())
        XCTAssertThrowsError(try PlaybackBookmark(queue: [UUID()], index: 0, position: -.infinity).validate())
        XCTAssertThrowsError(try PlaybackBookmark(queue: [UUID()], index: 0, position: -1).validate())
        var future = PlaybackBookmark(queue: [UUID()], index: 0, position: 0)
        future.version = 2
        XCTAssertThrowsError(try future.validate())
    }
}
