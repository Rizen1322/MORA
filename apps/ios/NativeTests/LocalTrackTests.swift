import XCTest
@testable import MORACore

final class LocalTrackTests: XCTestCase {
    private let track = LocalTrack(id: UUID(), fileName: "test.m4a", title: "Тёплый свет", artist: "Beyoncé", duration: 180, artworkName: nil, liked: false)

    func testSearchIgnoresCaseAccentsAndSurroundingWhitespace() {
        XCTAssertTrue(track.matches("  ТЁПЛЫЙ \n"))
        XCTAssertTrue(track.matches("beyonce"))
        XCTAssertTrue(track.matches("СВЕТ"))
        XCTAssertFalse(track.matches("другой трек"))
    }

    func testEmptySearchShowsTheCollection() {
        XCTAssertTrue(track.matches(""))
        XCTAssertTrue(track.matches(" \n "))
    }

    func testReadsTheExistingTrackArchiveShape() throws {
        let data = Data(#"{"id":"00000000-0000-0000-0000-000000000001","fileName":"existing.m4a","title":"Трек","artist":"Артист","duration":123.5,"liked":true}"#.utf8)
        let restored = try JSONDecoder().decode(LocalTrack.self, from: data)
        XCTAssertEqual(restored.title, "Трек")
        XCTAssertEqual(restored.duration, 123.5)
        XCTAssertTrue(restored.liked)
        XCTAssertNil(restored.artworkName)
    }

    func testPlaybackTimeHandlesLongTracksAndInvalidPositions() {
        XCTAssertEqual(playbackTime(0), "0:00")
        XCTAssertEqual(playbackTime(65.9), "1:05")
        XCTAssertEqual(playbackTime(90061), "1501:01")
        XCTAssertEqual(playbackTime(-1), "0:00")
        XCTAssertEqual(playbackTime(.nan), "0:00")
        XCTAssertEqual(playbackTime(.infinity), "0:00")
    }
}
