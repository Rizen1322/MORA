import Foundation

// Self-check for NativeYandexCatalog.swift: search, home, artistPage pagination, albumPage disc sort,
// image sanitization, 401 credential refresh, clear() invalidation and strict input validation.

func fail(_ message: String) -> Never { fatalError("FAIL: " + message) }
func check(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
func jsonData(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }

// MARK: image & id validation

check(NativeYandexCatalog.isYandexTrackId("12345") && NativeYandexCatalog.isYandexTrackId("12345:678"), "yandex track ids")
check(!NativeYandexCatalog.isYandexTrackId("../etc"), "invalid track id rejected")
check(NativeYandexCatalog.image("avatars.yandex.net/get-music/%%", apiBase: "https://api.music.yandex.net") == "https://avatars.yandex.net/get-music/400x400", "image normalized to 400x400")
check(NativeYandexCatalog.image("https://evil.example/a.jpg", apiBase: "https://api.music.yandex.net") == nil, "non-yandex cover domain rejected")
check(NativeYandexCatalog.image("https://avatars.yandex.net/get-mp3/a.mp3", apiBase: "https://api.music.yandex.net") == nil, "audio path rejected as cover")
check(NativeYandexCatalog.image("https://avatars.yandex.net/a.jpg?token=1", apiBase: "https://api.music.yandex.net") == nil, "query string rejected on cover")

// MARK: catalog fixture flows

var tokenVersion = 1
var calls: [(method: String, path: String, auth: String)] = []

let catalog = NativeYandexCatalog(
    credentialsLoader: {
        ("tok-\(tokenVersion)", "https://api.music.yandex.net")
    },
    fetch: { request, _ in
        let url = request.url!
        let path = url.path + (url.query.map { "?\($0)" } ?? "")
        let auth = request.value(forHTTPHeaderField: "Authorization") ?? ""
        calls.append((request.httpMethod ?? "GET", path, auth))

        if path.hasPrefix("/search") {
            if auth == "OAuth tok-1" && url.absoluteString.contains("text=rotate") {
                tokenVersion = 2
                return (401, Data())
            }
            let result: [String: Any] = [
                "tracks": [
                    "total": 25, "perPage": 20,
                    "results": [
                        ["id": 100, "title": "Main Song", "durationMs": 180000, "albums": [["id": 500, "title": "LP", "year": 2024]], "artists": [["id": 42, "name": "Artist"]]],
                    ],
                ],
                "artists": ["results": [["id": 42, "name": "Artist", "genres": ["pop"], "cover": ["uri": "avatars.mds.yandex.net/get-music/%%"]]]],
                "albums": ["results": [["id": 500, "title": "LP", "year": 2024, "artists": [["id": 42, "name": "Artist"]]]]],
                "best": ["type": "track", "result": ["id": 101, "title": "Best Song", "version": "Live", "durationMs": 200000, "albums": [["id": 500, "title": "LP"]], "artists": [["id": 42, "name": "Artist"]]]],
            ]
            return (200, jsonData(["result": result]))
        }
        if path == "/account/status" {
            return (200, jsonData(["result": ["account": ["uid": 777]]]))
        }
        if path == "/users/777/likes/tracks" {
            return (200, jsonData(["result": ["library": ["tracks": [["id": "200", "albumId": "600"]]]]]))
        }
        if path == "/tracks" {
            return (200, jsonData(["result": [["id": 200, "title": "Liked Song", "durationMs": 150000, "albums": [["id": 600, "title": "Liked LP"]], "artists": [["id": 42, "name": "Artist"]]]]]))
        }
        if path == "/artists/42/brief-info" {
            return (200, jsonData(["result": [
                "artist": ["id": 42, "name": "Artist", "genres": ["rock"], "description": ["text": "<p>Bio &amp; notes</p>"]],
                "popularTracks": [["id": 100, "title": "Hit", "durationMs": 180000, "albums": [["id": 500, "title": "LP"]], "artists": [["id": 42, "name": "Artist"]]]],
                "similarArtists": [["id": 99, "name": "Similar"]],
            ]]))
        }
        if path.hasPrefix("/artists/42/direct-albums") {
            let p = path.contains("page=1") ? 1 : 0
            return (200, jsonData(["result": [
                "total": 25, "perPage": 20,
                "albums": [["id": p == 0 ? 500 : 501, "title": p == 0 ? "Album 1" : "Album 2", "year": 2020 + p]],
            ]]))
        }
        if path == "/albums/500/with-tracks" {
            return (200, jsonData(["result": [
                "id": 500, "title": "Deluxe LP", "year": 2024, "artists": [["id": 42, "name": "Artist"]],
                "description": "<b>Official</b> release",
                "volumes": [
                    [
                        ["id": 2, "title": "Second", "durationMs": 120000, "trackPosition": ["volume": 1, "index": 2], "artists": [["id": 42, "name": "Artist"]]],
                        ["id": 1, "title": "First", "durationMs": 100000, "trackPosition": ["volume": 1, "index": 1], "artists": [["id": 42, "name": "Artist"]]],
                    ],
                    [
                        ["id": 3, "title": "Disc 2", "durationMs": 140000, "trackPosition": ["volume": 2, "index": 1], "artists": [["id": 42, "name": "Artist"]]],
                    ],
                ],
            ]]))
        }
        return (404, Data())
    }
)

// Search & best promotion + pagination flag
let searchRes = try await catalog.search("hello", page: 0, type: "all")
let searchTracks = searchRes["tracks"] as? [[String: Any]] ?? []
check(searchTracks.count == 2 && searchTracks.first?["title"] as? String == "Best Song (Live)", "best promoted with version suffix")
check(((searchRes["hasMore"] as? [String: Bool])?["tracks"]) == true, "pager hasMore")

// Search hits cache on second call
let countBeforeCache = calls.count
_ = try await catalog.search("hello", page: 0, type: "all")
check(calls.count == countBeforeCache, "search cached for 120s")

// 401 refreshes credentials and retries once
let rotated = try await catalog.search("rotate", page: 0, type: "all")
check((rotated["tracks"] as? [[String: Any]])?.count == 2, "401 refreshed credentials and retried")
check(calls.last?.auth == "OAuth tok-2", "retried with refreshed token")

// Home
let homeRes = try await catalog.home()
check((homeRes["tracks"] as? [[String: Any]])?.first?["externalId"] as? String == "200:600", "home loads liked tracks")
check((homeRes["artists"] as? [[String: Any]])?.first?["id"] as? String == "42", "home extracts artist shelf")

// Artist page + HTML strip + page 1
let artist0 = try await catalog.artistPage("42", page: 0)
check((artist0["artist"] as? [String: Any])?["description"] as? String == "Bio & notes", "HTML tags stripped in description")
check(artist0["hasMoreAlbums"] as? Bool == true, "artist page 0 hasMoreAlbums")
let artist1 = try await catalog.artistPage("42", page: 1)
check((artist1["albums"] as? [[String: Any]])?.first?["title"] as? String == "Album 2" && artist1["hasMoreAlbums"] as? Bool == false, "artist page 1 pagination")

// Album page multi-disc sort
let album = try await catalog.albumPage("500")
let albumTracks = album["tracks"] as? [[String: Any]] ?? []
check(albumTracks.compactMap { $0["title"] as? String } == ["First", "Second", "Disc 2"], "album sorted by disc and track index")
check(album["description"] as? String == "Official release", "album description cleaned")

// clear() drops cache and credentials
let callsBeforeClear = calls.count
catalog.clear()
_ = try await catalog.albumPage("500")
check(calls.count > callsBeforeClear, "clear() evicted cached album")

// Validation rejections
do { _ = try await catalog.search("   "); fail("blank search accepted") } catch {}
do { _ = try await catalog.artistPage("abc"); fail("non-numeric artist accepted") } catch {}
do { _ = try await catalog.albumPage("abc"); fail("non-numeric album accepted") } catch {}

print("Native Yandex catalog: search, home, artist/album pagination, HTML stripping, image security and 401 refresh passed")
