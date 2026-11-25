import Foundation

// Self-check for NativeSoundCloud.swift: client_id discovery, artist profiles and search parsing with
// the same validation rules as the JS provider. Network is replaced by fixtures. Run by CI.

func fail(_ message: String) -> Never { fatalError("FAIL: " + message) }
func check(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }

var calls: [String] = []
let clientId = String(repeating: "a", count: 32)
let home = """
<html><head>
<script src="https://a-v2.sndcdn.com/assets/0-deadbeef.js"></script>
<script src="https://evil.example/assets/1.js"></script>
<script src="https://a-v2.sndcdn.com/assets/2-deadbeef.js"></script>
</head></html>
"""
let asset = "window.__sc={client_id:\"\(clientId)\"};"
let user: [String: Any] = ["kind": "user", "id": 777, "permalink": "artist",
                           "permalink_url": "https://soundcloud.com/artist", "username": "Artist",
                           "description": "Bio", "avatar_url": "https://i1.sndcdn.com/avatars-1-large.jpg?x=1"]
let good: [String: Any] = ["id": 1001, "kind": "track", "title": " Song ", "duration": 60000, "streamable": true,
                           "policy": "ALLOW", "permalink_url": "https://soundcloud.com/artist/song",
                           "artwork_url": "https://i1.sndcdn.com/artworks-1-large.png",
                           "user": ["id": 777, "username": "Artist", "permalink": "artist", "avatar_url": "https://i1.sndcdn.com/a-large.jpg"],
                           "publisher_metadata": ["artist": "Artist"],
                           "media": ["transcodings": [["format": ["protocol": "progressive"]]]]]
let encrypted: [String: Any] = ["id": 1002, "kind": "track", "title": "Locked", "duration": 60000,
                                "media": ["transcodings": [["format": ["protocol": "ctr-encrypted-hls"]]]]]
let privateTrack: [String: Any] = ["id": 1003, "kind": "track", "title": "Private", "duration": 60000, "sharing": "private"]
let short: [String: Any] = ["id": 1004, "kind": "track", "title": "Short", "duration": 10000]
let duplicate: [String: Any] = ["id": 1001, "kind": "track", "title": "Song", "duration": 60000]
let otherArtist: [String: Any] = ["id": 1005, "kind": "track", "title": "Other", "duration": 60000,
                                  "user": ["id": 888, "username": "Other", "permalink": "other"]]
let collection: [String: Any] = ["collection": [good, encrypted, privateTrack, short, duplicate, otherArtist]]

let cloud = NativeSoundCloud { url, limit in
    calls.append(url.absoluteString)
    let body: Data
    if url.host == "soundcloud.com", url.path == "/" { body = Data(home.utf8) }
    else if url.host == "a-v2.sndcdn.com", url.path.hasSuffix(".js") { body = Data(asset.utf8) }
    else if url.host == "api-v2.soundcloud.com", url.path == "/users/777" { body = json(user) }
    else if url.host == "api-v2.soundcloud.com", url.path == "/users/777/tracks" { body = json(collection) }
    else if url.host == "api-v2.soundcloud.com", url.path == "/search/tracks" { body = json(collection) }
    else { body = Data("missing".utf8) }
    if body.count > limit { throw NativeSoundCloud.Failure(message: "SoundCloud: слишком большой ответ") }
    return (200, body)
}

// MARK: artist

let artist = try await cloud.artist("777")
check(artist["title"] as? String == "Artist", "artist name")
check(artist["permalink"] as? String == "artist", "permalink")
check(artist["description"] as? String == "Bio", "description")
check(artist["coverUrl"] as? String == "https://i1.sndcdn.com/avatars-1-t500x500.jpg?x=1", "avatar becomes a 500px image")
let tracks = artist["tracks"] as? [[String: Any]] ?? []
check(tracks.count == 1, "only open, long public tracks of this artist remain")
let track = tracks[0]
check(track["id"] as? String == "1001" && track["title"] as? String == "Song", "track id and trimmed title")
check((track["duration"] as? NSNumber)?.doubleValue == 60, "milliseconds become seconds")
check(track["artist"] as? String == "Artist", "publisher artist wins")
check(track["artist_id"] as? String == "777", "artist link")
check(track["webpage_url"] as? String == "https://soundcloud.com/artist/song", "canonical page")
check((track["thumbnail"] as? String)?.hasSuffix("-t500x500.png") == true, "artwork thumbnail")
check(!(track["url"] as? String ?? "").isEmpty, "api url")
check(NativeSoundCloud.hasOpenStream(good) && !NativeSoundCloud.hasOpenStream(encrypted), "DRM detection")

let homeFetches = calls.filter { $0 == "https://soundcloud.com/" }.count
check(homeFetches == 1, "client id is discovered once")
check(calls.contains { $0.hasPrefix("https://a-v2.sndcdn.com/assets/2-deadbeef.js") }, "official asset inspected")

// MARK: search

calls.removeAll()
let found = try await cloud.search("  song  ", limit: 5)
let ids = Set(found.compactMap { $0["id"] as? String })
check(ids == ["1001", "1005"], "search keeps valid tracks from any artist and drops the rest")
check(calls.contains { $0.contains("/search/tracks") && $0.contains("client_id=\(clientId)") }, "search uses the cached client id")
check(!calls.contains("https://soundcloud.com/"), "search reuses the client id")

// MARK: rejections

do { _ = try await cloud.artist("not-a-number"); fail("invalid id accepted") } catch {}
let broken = NativeSoundCloud { _, _ in (200, Data("<html><script src=\"https://evil.example/x.js\"></script></html>".utf8)) }
do { _ = try await broken.artist("777"); fail("broken assets accepted") } catch {}
let huge = NativeSoundCloud { _, limit in (200, Data(repeating: 0x20, count: limit + 1)) }
do { _ = try await huge.search("song"); fail("oversized response accepted") } catch {}
let foreign = NativeSoundCloud { _, _ in (200, Data("x".utf8)) }
do { _ = try await foreign.artist("777"); fail("mismatched profile accepted") } catch {}

print("Native SoundCloud: client id, artist profile, search validation, DRM and size limits passed")
