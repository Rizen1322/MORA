import Foundation

// Self-check for NativeCatalogState.swift: artist/album/public/soundcloud pages built from the JSC API,
// pagination and strict id encoding, without a page description. Run by .github/workflows/ios.yml.

func fail(_ message: String) -> Never { fatalError("FAIL: " + message) }
func check(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
func rows(_ section: [String: Any]) -> [[String: Any]] { section["rows"] as? [[String: Any]] ?? [] }
func sections(_ page: [String: Any]) -> [[String: Any]] { page["sections"] as? [[String: Any]] ?? [] }
func actRows(_ list: [[String: Any]], _ name: String) -> [[String: Any]] {
    list.filter { (($0["act"] as? [String: Any])?["name"] as? String) == name }
}

let state = NativeCatalogState()
state.soundcloud = nil // the fixtures below replace the native providers
state.publicCatalog = nil
state.yandex = nil
var requests: [(String, String)] = []
let track: [String: Any] = ["id": "tr1", "title": "Song", "artist": "Artist", "duration": 185.0, "coverUrl": "https://img/1"]
let request: NativeCatalogState.Request = { method, path, _ in
    requests.append((method, path))
    if path == "/api/catalog/yandex/artists/42?page=0" {
        return ["artist": ["name": "Artist", "imageUrl": "https://img/a", "genres": ["rock", "pop"], "description": "About"],
                "popularTracks": [track, ["id": "tr2", "title": "Two", "artist": "Artist", "duration": 200.0]],
                "albums": [["id": "al1", "title": "First", "year": 2020, "imageUrl": "https://img/al1"]],
                "similarArtists": [["id": "77", "name": "Similar", "imageUrl": "https://img/s"]],
                "hasMoreAlbums": true]
    }
    if path == "/api/catalog/yandex/artists/42?page=1" {
        return ["albums": [["id": "al1", "title": "First"], ["id": "al2", "title": "Second", "year": 2022]], "hasMoreAlbums": false]
    }
    if path == "/api/catalog/yandex/albums/43" {
        return ["album": ["title": "Album", "imageUrl": "https://img/al", "year": 2021, "artists": [["id": "42", "name": "Artist"]]],
                "tracks": [track, ["id": "tr2", "title": "Two", "artist": "Artist", "duration": 200.0]]]
    }
    if path.hasPrefix("/api/catalog/public/artists/") {
        return ["title": "Public Artist", "description": "Bio", "tracks": [track, ["id": "tr2", "title": "Two", "artist": "Public Artist"]],
                "albums": [["id": "pa", "title": "Public Album", "artist": "Public Artist", "coverUrl": "https://img/pa"]]]
    }
    if path == "/api/catalog/soundcloud/artists/sc" {
        return ["title": "SC Artist", "coverUrl": "https://img/sc", "tracks": [track], "source": "soundcloud", "limited": true]
    }
    if path.hasPrefix("/api/catalog/public/albums/") {
        return ["title": "Public Album", "coverUrl": "https://img/pa", "tracks": [track]]
    }
    throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "unexpected \(method) \(path)"])
}

check(NativeCatalogState.handles("/catalog/artist/42"), "yandex artist route")
check(NativeCatalogState.handles("/catalog/album/43"), "yandex album route")
check(NativeCatalogState.handles("/public/artist/pp"), "public artist route")
check(NativeCatalogState.handles("/soundcloud/artist/sc"), "soundcloud artist route")
check(!NativeCatalogState.handles("/catalog/artist"), "two-part catalog path stays with the router")
check(!NativeCatalogState.handles("/library/artists"), "library artists stay native library pages")
check(NativeCatalogState.supports("catalogMore") && !NativeCatalogState.supports("playAll"), "only pagination is owned")

// MARK: yandex artist

let artist = try await state.page("/catalog/artist/42", request: request)
check(artist["title"] as? String == "Artist", "artist title")
let artistSections = sections(artist)
check(artistSections.count == 5, "hero, popular, albums, similar and description")
let hero = rows(artistSections[0]).first ?? [:]
check((hero["play"] as? [String: Any])?["name"] as? String == "catalogPlay", "hero plays the popular tracks")
check(((hero["play"] as? [String: Any])?["args"] as? [String: Any])?["tracks"] as? [[String: Any]] != nil, "hero sends its tracks")
check((hero["subtitle"] as? String) == "rock · pop", "genres in the subtitle")
let popular = rows(artistSections[1])
check(popular.count == 2 && actRows(popular, "catalogPlay").count == 2, "popular track rows play the catalog")
let firstTrackAct = popular[0]["act"] as? [String: Any]
check((firstTrackAct?["args"] as? [String: Any])?["index"] as? Int == 0, "track index is passed")
let actions = popular[0]["actions"] as? [[String: Any]] ?? []
check(actions.contains { ($0["act"] as? [String: Any]).flatMap { ($0["args"] as? [String: Any])?["kind"] as? String } == "queue" }, "queue action")
check(actions.contains { ($0["act"] as? [String: Any]).flatMap { ($0["args"] as? [String: Any])?["kind"] as? String } == "save" }, "save action for unsaved tracks")
let albumsSection = rows(artistSections[2])
check(albumsSection.count == 2, "album shelf and the more button")
check((albumsSection[1]["act"] as? [String: Any])?["name"] as? String == "catalogMore", "more albums button")
check((albumsSection[1]["act"] as? [String: Any]).flatMap { ($0["args"] as? [String: Any])?["id"] as? String } == "42", "more albums keeps the id")
check(rows(artistSections[3]).first?["kind"] as? String == "shelf", "similar artists shelf")
check(rows(artistSections[4]).first?["title"] as? String == "About", "description section")

// MARK: pagination

try await state.execute("catalogMore", ["id": "42"], request: request)
let paginated = try await state.page("/catalog/artist/42", request: request)
let albumsAfter = rows(sections(paginated)[2])
check(albumsAfter.count == 1, "the more button disappears once albums end")
let shelf = albumsAfter[0]["items"] as? [[String: Any]] ?? []
check(shelf.count == 2 && shelf[1]["title"] as? String == "Second", "albums are merged without duplicates")
check(requests.contains { $0.1 == "/api/catalog/yandex/artists/42?page=1" }, "the next page is requested")

// MARK: yandex album

let album = try await state.page("/catalog/album/43", request: request)
check(album["title"] as? String == "Album", "album title")
let albumSections = sections(album)
check(albumSections.count == 3, "hero, tracks and artists")
check((rows(albumSections[0]).first?["detail"] as? String) == "2021 · 2 трека", "year and track count")
let numbered = rows(albumSections[1])
check(numbered.count == 2 && (numbered[0]["subtitle"] as? String) == "1. Artist", "album tracks are numbered")
check(((numbered[0]["act"] as? [String: Any])?["args"] as? [String: Any])?["context"] as? [String: Any] != nil, "album context")

// MARK: public and soundcloud

let publicArtist = try await state.page("/public/artist/pp", request: request)
check(publicArtist["title"] as? String == "Public Artist", "public artist title")
check(sections(publicArtist).count == 3, "public artist has tracks and albums")
let publicAlbums = rows(sections(publicArtist)[2]).first?["items"] as? [[String: Any]] ?? []
check(publicAlbums.first?["path"] as? String == "/public/album/pa", "public album links")

let soundcloud = try await state.page("/soundcloud/artist/sc", request: request)
check(soundcloud["title"] as? String == "SC Artist", "soundcloud title")
check((sections(soundcloud)[1]["footer"] as? String) == "Показаны записи, доступные в этом источнике.", "limited catalogue note")

// MARK: fixtures and strict ids

let fixtureState = NativeCatalogState()
fixtureState.installFixture("/catalog/artist/99", ["title": "Fixture", "sections": []])
let fixture = try await fixtureState.page("/catalog/artist/99", request: { _, path, _ in throw NSError(domain: "x", code: 1) })
check(fixture["title"] as? String == "Fixture", "the simulator fixture is used without a request")
fixtureState.removeFixtures()
do { _ = try await fixtureState.page("/catalog/artist/99", request: { _, _, _ in throw NSError(domain: "x", code: 2) }); fail("fixture survived removal") } catch {}

let unsafe = try await state.page("/public/artist/a%2Fb%3Fc", request: request)
check(requests.contains { $0.1 == "/api/catalog/public/artists/a%2Fb%3Fc" }, "ids are encoded as one path segment")
check(unsafe["title"] as? String == "Public Artist", "encoded id page loads")

do { _ = try await state.page("/catalog/artist", request: request); fail("two-part catalog path accepted") } catch {}
requests.removeAll()
try await state.execute("catalogMore", [:], request: request)
check(requests.isEmpty, "pagination without an id is a no-op")
let emptyPublic = try await state.page("/public/artist/empty", request: { _, path, _ in
    if path.hasPrefix("/api/catalog/public/artists/") { return ["title": "Empty", "tracks": []] }
    throw NSError(domain: "x", code: 3)
})
check(sections(emptyPublic).count == 2 && (sections(emptyPublic)[0]["rows"] as? [[String: Any]])?.first?["play"] == nil, "an empty catalogue page has no play button")

// MARK: Native Yandex & Public catalog providers (zero JSC requests)

func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }
let failRequest: NativeCatalogState.Request = { method, path, _ in
    fail("Native provider should have handled \(method) \(path)")
}

var yandexFetchCount = 0
let mockYandex = NativeYandexCatalog(
    credentialsLoader: { ("tok", "https://api.music.yandex.net") },
    fetch: { request, _ in
        yandexFetchCount += 1
        let url = request.url!
        let path = url.path + (url.query.map { "?\($0)" } ?? "")
        if path == "/artists/42/brief-info" {
            return (200, json(["result": [
                "artist": ["id": 42, "name": "Native YA Artist", "genres": ["indie"]],
                "popularTracks": [
                    ["id": 100, "title": "Saved Song", "durationMs": 180000, "albums": [["id": 500, "title": "LP"]], "artists": [["id": 42, "name": "Native YA Artist"]]],
                    ["id": 102, "title": "Unsaved Song", "durationMs": 210000, "albums": [["id": 500, "title": "LP"]], "artists": [["id": 42, "name": "Native YA Artist"]]],
                ],
                "similarArtists": [["id": 77, "name": "Similar"]],
            ]]))
        }
        if path.hasPrefix("/artists/42/direct-albums") {
            let p = path.contains("page=1") ? 1 : 0
            return (200, json(["result": [
                "total": 25, "perPage": 20,
                "albums": p == 0
                    ? [["id": 500, "title": "LP 1", "year": 2023]]
                    : [["id": 500, "title": "LP 1", "year": 2023], ["id": 501, "title": "LP 2", "year": 2025]],
            ]]))
        }
        if path == "/albums/500/with-tracks" {
            return (200, json(["result": [
                "id": 500, "title": "LP 1", "year": 2023,
                "artists": [["id": 42, "name": "Native YA Artist"]],
                "volumes": [[
                    ["id": 100, "title": "Saved Song", "durationMs": 180000, "artists": [["id": 42, "name": "Native YA Artist"]]],
                ]],
            ]]))
        }
        if path.hasPrefix("/search") {
            let p1 = path.contains("page=1")
            let tracks: [[String: Any]] = p1
                ? [
                    ["id": 100, "title": "Saved Song", "durationMs": 180000, "albums": [["id": 500, "title": "LP 1"]], "artists": [["id": 42, "name": "Native YA Artist"]]],
                    ["id": 103, "title": "Page 2 Song", "durationMs": 195000, "albums": [["id": 500, "title": "LP 1"]], "artists": [["id": 42, "name": "Native YA Artist"]]],
                ]
                : [
                    ["id": 100, "title": "Saved Song", "durationMs": 180000, "albums": [["id": 500, "title": "LP 1"]], "artists": [["id": 42, "name": "Native YA Artist"]]],
                    ["id": 102, "title": "Unsaved Song", "durationMs": 210000, "albums": [["id": 500, "title": "LP 1"]], "artists": [["id": 42, "name": "Native YA Artist"]]],
                ]
            return (200, json(["result": [
                "tracks": ["total": 25, "perPage": 20, "results": tracks],
                "artists": ["results": [["id": 42, "name": "Native YA Artist"]]],
                "albums": ["results": [["id": 500, "title": "LP 1", "year": 2023, "artists": [["id": 42, "name": "Native YA Artist"]]]]],
            ]]))
        }
        if path == "/account/status" { return (200, json(["result": ["account": ["uid": 777]]])) }
        if path == "/users/777/likes/tracks" { return (200, json(["result": ["library": ["tracks": [["id": "100", "albumId": "500"]]]]])) }
        if path == "/tracks" {
            return (200, json(["result": [
                ["id": 100, "title": "Saved Song", "durationMs": 180000, "albums": [["id": 500, "title": "LP 1"]], "artists": [["id": 42, "name": "Native YA Artist"]]],
            ]]))
        }
        return (404, Data())
    }
)

let ucArtistId = "UC1234567890123456789012"
let mpreAlbumId = "MPREb_12345678"
let mockPublic = NativePublicCatalog { req, _ in
    let body = (try? JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any]) ?? [:]
    let bid = body["browseId"] as? String ?? ""
    if bid == ucArtistId {
        return (200, json([
            "header": ["musicImmersiveHeaderRenderer": ["title": ["simpleText": "Native Public Artist"], "description": ["simpleText": "YTM Bio"]]],
            "contents": ["singleColumnBrowseResultsRenderer": ["tabs": [["tabRenderer": ["content": ["sectionListRenderer": ["contents": [
                ["musicShelfRenderer": ["contents": [[
                    "musicResponsiveListItemRenderer": [
                        "playlistItemData": ["videoId": "dQw4w9WgXcQ"],
                        "flexColumns": [
                            ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [["text": "Public Hit"]]]]],
                            ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [["text": "Native Public Artist"]]]]],
                        ],
                    ],
                ]]]],
                ["musicCarouselShelfRenderer": ["contents": [[
                    "musicTwoRowItemRenderer": [
                        "title": ["runs": [["text": "Public LP", "navigationEndpoint": ["browseEndpoint": ["browseId": mpreAlbumId, "browseEndpointContextSupportedConfigs": ["browseEndpointContextMusicConfig": ["pageType": "MUSIC_PAGE_TYPE_ALBUM"]]]]]]],
                        "subtitle": ["runs": [["text": "Native Public Artist"]]],
                    ],
                ]]]],
            ]]]]]]]],
        ]))
    }
    if bid == mpreAlbumId {
        return (200, json([
            "header": ["musicDetailHeaderRenderer": ["title": ["runs": [["text": "Public LP"]]]]],
            "contents": ["twoColumnBrowseResultsRenderer": ["secondaryContents": ["sectionListRenderer": ["contents": [[
                "musicShelfRenderer": ["contents": [[
                    "musicResponsiveListItemRenderer": [
                        "playlistItemData": ["videoId": "xyz12345678"],
                        "flexColumns": [
                            ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [["text": "Album Track"]]]]],
                            ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [["text": "Native Public Artist"]]]]],
                        ],
                    ],
                ]]],
            ]]]]]],
        ]))
    }
    return (404, Data())
}

let nativeState = NativeCatalogState()
nativeState.soundcloud = nil
nativeState.yandex = mockYandex
nativeState.publicCatalog = mockPublic

let lookup: NativeCatalogState.LocalTrackLookup = { provider, extId in
    if provider == "yandex" && extId == "100:500" { return ("lib-1", true, 1) }
    return nil
}

// Yandex artist page with localLookup & optimistic external reaction
let nativeArtist = try await nativeState.page("/catalog/artist/42", request: failRequest, localLookup: lookup)
check(nativeArtist["title"] as? String == "Native YA Artist", "native yandex artist title")
let popRows = rows(sections(nativeArtist)[1])
check(popRows.count == 2, "native yandex artist popular tracks")
let savedActs = (popRows[0]["actions"] as? [[String: Any]] ?? []).map { ($0["title"] as? String) ?? "" }
let unsavedActs = (popRows[1]["actions"] as? [[String: Any]] ?? []).map { ($0["title"] as? String) ?? "" }
check(!savedActs.contains("Сохранить в медиатеку") && savedActs.contains("Убрать лайк"), "saved track uses local lookup state")
check(unsavedActs.contains("Сохранить в медиатеку") && unsavedActs.contains("Нравится"), "unsaved track offers save and like")

let fetchesAfterArtist = yandexFetchCount
nativeState.setExternalReaction(provider: "yandex", externalId: "102:500", value: 1)
let withPending = try await nativeState.page("/catalog/artist/42", request: failRequest, localLookup: lookup)
let unsavedAfterReact = (rows(sections(withPending)[1])[1]["actions"] as? [[String: Any]] ?? []).map { ($0["title"] as? String) ?? "" }
check(yandexFetchCount == fetchesAfterArtist && unsavedAfterReact.contains("Убрать лайк"), "external reaction applies from cache without refetch")

try await nativeState.execute("catalogMore", ["id": "42"], request: failRequest)
let afterMore = try await nativeState.page("/catalog/artist/42", request: failRequest, localLookup: lookup)
let afterMoreAlbumRows = rows(sections(afterMore)[2])
check(afterMoreAlbumRows.count == 1 && (afterMoreAlbumRows[0]["items"] as? [[String: Any]])?.count == 2, "native yandex catalogMore merges without duplicates")

let nativeAlbum = try await nativeState.page("/catalog/album/500", request: failRequest, localLookup: lookup)
check(nativeAlbum["title"] as? String == "LP 1" && rows(sections(nativeAlbum)[1]).count == 1, "native yandex album rendered without JSC")

// Native Yandex search, pagination, empty-query home, session update & fixtures
let s0 = try await nativeState.searchYandex(query: "hello", scope: "all", more: false, previousSession: nil, request: failRequest, localLookup: lookup)
let sid0 = s0["session"] as? String ?? ""
check(!sid0.isEmpty && (s0["more"] as? Bool) == true && (s0["tracks"] as? [[String: Any]])?.count == 2, "yandex search page 0")
let s1 = try await nativeState.searchYandex(query: "hello", scope: "all", more: true, previousSession: sid0, request: failRequest, localLookup: lookup)
let sid1 = s1["session"] as? String ?? ""
let s1Tracks = s1["tracks"] as? [[String: Any]] ?? []
check(!sid1.isEmpty && (s1["more"] as? Bool) == false && s1Tracks.count == 3, "yandex search pagination deduplicated: \(s1Tracks.count)")
let updatedSession = nativeState.updateSearchSessionTrack(sessionId: sid1, externalId: "102:500", reaction: -1, libraryTrackId: "lib-2", saved: true)
let updatedUnsaved = (updatedSession?["tracks"] as? [[String: Any]])?.first { ($0["externalId"] as? String) == "102:500" }
check((updatedUnsaved?["reaction"] as? NSNumber)?.intValue == -1 && updatedUnsaved?["saved"] as? Bool == true, "search session track update reflected")

let homeRes = try await nativeState.searchYandex(query: "  ", scope: "all", more: false, previousSession: nil, request: failRequest, localLookup: lookup)
check((homeRes["tracks"] as? [[String: Any]])?.count == 1, "blank query loads yandex home feed")

nativeState.installSearchFixture("yandex", ["session": "fix", "tracks": [], "artists": [], "albums": [], "more": false])
_ = try await nativeState.searchYandex(query: "Запрос", scope: "all", more: false, previousSession: nil, request: failRequest)
check(nativeState.recordedSearchQueries == ["Запрос"], "search fixture records query")
nativeState.removeSearchFixtures()
check(nativeState.recordedSearchQueries.isEmpty, "removeSearchFixtures clears history")

nativeState.clearYandex()
check(nativeState.searchSession(sid1) == nil, "clearYandex evicts search sessions")
do {
    _ = try await nativeState.searchYandex(query: "hello", scope: "all", more: true, previousSession: sid1, request: failRequest)
    fail("stale search session must fail after clearYandex")
} catch {}

// Native Public Catalog artist & album without JSC
let nativePubArtist = try await nativeState.page("/public/artist/\(ucArtistId)", request: failRequest)
check(nativePubArtist["title"] as? String == "Native Public Artist" && rows(sections(nativePubArtist)[1]).count == 1, "native public artist without JSC")
let nativePubAlbum = try await nativeState.page("/public/album/\(mpreAlbumId)", request: failRequest)
check(nativePubAlbum["title"] as? String == "Public LP" && rows(sections(nativePubAlbum)[1]).count == 1, "native public album without JSC")

// SoundCloud raw track key normalization
let scNormalized = NativeCatalogState.enrichTracks([[
    "id": 999,
    "title": "SC Song",
    "artist": "SC Artist",
    "thumbnail": "https://i1.sndcdn.com/artworks-000.jpg",
    "artist_id": "555",
    "webpage_url": "https://soundcloud.com/a/b",
]], defaultProvider: "soundcloud", lookup: nil)
check(scNormalized.count == 1
    && scNormalized[0]["provider"] as? String == "soundcloud"
    && scNormalized[0]["externalId"] as? String == "999"
    && scNormalized[0]["coverUrl"] as? String == "https://i1.sndcdn.com/artworks-000.jpg"
    && scNormalized[0]["artistId"] as? String == "555"
    && scNormalized[0]["pageUrl"] as? String == "https://soundcloud.com/a/b"
    && scNormalized[0]["playable"] as? Bool == true, "SoundCloud track normalized for catalog actions")

// MARK: Public search (ytmusic, youtube, soundcloud)

var publicSearchRequests: [String] = []
let publicSearchRequest: NativeCatalogState.Request = { method, path, _ in
    check(method == "GET", "public search uses GET")
    publicSearchRequests.append(path)
    if path.hasPrefix("/api/search/ytmusic?") {
        return ["items": [
            [
                "externalId": "vid12345678",
                "title": "Public Track (Remix)",
                "artist": "Public Artist",
                "album": "Public Album",
                "duration": 215.0,
                "coverUrl": "https://i.ytimg.com/vi/vid12345678/hqdefault.jpg",
                "pageUrl": "https://music.youtube.com/watch?v=vid12345678",
                "playable": true,
                "source": "ytmusic",
                "audioProvider": "youtube",
                "kind": "song",
                "explicit": true,
                "labels": [["tag": "remix", "origin": "title"], ["tag": "explicit", "origin": "source"]],
                "artistId": ucArtistId,
                "albumId": mpreAlbumId,
                "libraryTrackId": NSNull(),
            ],
            [
                "externalId": "vid87654321",
                "title": "Second Song",
                "artist": "Other Artist",
                "album": "",
                "duration": 180.0,
                "playable": false,
                "source": "ytmusic",
                "audioProvider": "youtube",
                "explicit": false,
                "labels": [],
            ],
        ]]
    }
    if path.hasPrefix("/api/search/soundcloud?") {
        return ["items": [[
            "externalId": "987654321",
            "title": "SC Live Cut",
            "artist": "SC DJ",
            "album": "",
            "duration": 240.0,
            "coverUrl": "https://i1.sndcdn.com/artworks-987-t500x500.jpg",
            "playable": true,
            "source": "soundcloud",
            "audioProvider": "soundcloud",
            "explicit": false,
            "labels": [["tag": "live", "origin": "title"]],
            "artistId": "777",
        ]]]
    }
    if path.hasPrefix("/api/search/youtube?") {
        return ["items": []]
    }
    throw NSError(domain: "test", code: 9, userInfo: [NSLocalizedDescriptionKey: "unexpected public search \(path)"])
}

let publicLookup: NativeCatalogState.LocalTrackLookup = { provider, extId in
    if provider == "youtube" && extId == "vid12345678" { return ("loc-yt-1", true, 1) }
    if provider == "soundcloud" && extId == "987654321" { return ("loc-sc-1", false, -1) }
    return nil
}

nativeState.removeSearchFixtures()
let ytmSearch = try await nativeState.searchPublic(source: "ytmusic", query: "  Public Hit  ", request: publicSearchRequest, localLookup: publicLookup)
let ytmSid = ytmSearch["session"] as? String ?? ""
check(!ytmSid.isEmpty, "searchPublic creates a session")
check(nativeState.recordedSearchQueries == ["Public Hit"], "searchPublic records trimmed query")
check(publicSearchRequests.contains("/api/search/ytmusic?q=Public%20Hit"), "searchPublic encodes query and hits /api/search/ytmusic")
check((ytmSearch["more"] as? Bool) == false && (ytmSearch["artists"] as? [Any])?.isEmpty == true && (ytmSearch["albums"] as? [Any])?.isEmpty == true, "searchPublic returns standard empty shelves and more=false")
let ytmTracks = ytmSearch["tracks"] as? [[String: Any]] ?? []
check(ytmTracks.count == 2, "searchPublic returns all parsed tracks")
check(ytmTracks[0]["id"] as? String == "vid12345678"
    && ytmTracks[0]["externalId"] as? String == "vid12345678"
    && ytmTracks[0]["provider"] as? String == "youtube"
    && ytmTracks[0]["saved"] as? Bool == true
    && (ytmTracks[0]["reaction"] as? NSNumber)?.intValue == 1
    && ytmTracks[0]["localTrackId"] as? String == "loc-yt-1"
    && ytmTracks[0]["explicit"] as? Bool == true
    && ytmTracks[0]["tags"] as? String == "remix · explicit", "searchPublic normalizes labels, explicit, and localLookup state")
check(ytmTracks[1]["ok"] as? Bool == false && ytmTracks[1]["localTrackId"] == nil, "searchPublic preserves playable=false and omits missing localTrackId")
let storedYtmSession = nativeState.searchSession(ytmSid)
check(storedYtmSession?.source == "ytmusic" && storedYtmSession?.items.count == 2, "searchPublic stores SearchSession with source and items")

let scSearch = try await nativeState.searchPublic(source: "soundcloud", query: "Live Cut", request: publicSearchRequest, localLookup: publicLookup)
let scTracks = scSearch["tracks"] as? [[String: Any]] ?? []
check(scTracks.count == 1
    && scTracks[0]["provider"] as? String == "soundcloud"
    && scTracks[0]["saved"] as? Bool == false
    && (scTracks[0]["reaction"] as? NSNumber)?.intValue == -1
    && scTracks[0]["localTrackId"] as? String == "loc-sc-1"
    && scTracks[0]["tags"] as? String == "live", "searchPublic supports soundcloud with localLookup")

let updatedPublic = nativeState.updateSearchSessionTrack(sessionId: ytmSid, externalId: "vid87654321", reaction: 1, libraryTrackId: "loc-yt-2", saved: true, lookup: publicLookup)
let updatedSecond = (updatedPublic?["tracks"] as? [[String: Any]])?.first { ($0["externalId"] as? String) == "vid87654321" }
check(updatedSecond?["saved"] as? Bool == true && (updatedSecond?["reaction"] as? NSNumber)?.intValue == 1 && updatedSecond?["localTrackId"] as? String == "loc-yt-2", "updateSearchSessionTrack updates public search track")

// Fixture behavior for searchPublic: records trimmed non-empty query without calling request
nativeState.removeSearchFixtures()
nativeState.installSearchFixture("youtube", ["session": "fix-yt", "tracks": [["id": "fx1", "title": "Fixture Track", "artist": "FX", "album": "", "duration": 120.0, "ok": true]], "artists": [], "albums": [], "more": false])
let ytFixture = try await nativeState.searchPublic(source: "youtube", query: "  MORA  ", request: failRequest, localLookup: publicLookup)
check(ytFixture["session"] as? String == "fix-yt" && nativeState.recordedSearchQueries == ["MORA"], "searchPublic records trimmed query before returning fixture")
_ = try await nativeState.searchPublic(source: "youtube", query: "   ", request: failRequest, localLookup: publicLookup)
check(nativeState.recordedSearchQueries == ["MORA"], "blank query is not recorded")
nativeState.removeSearchFixtures()

do {
    _ = try await nativeState.searchPublic(source: "unknown", query: "test", request: failRequest, localLookup: publicLookup)
    fail("unsupported public search source accepted")
} catch {}

print("Native catalog: yandex/public/soundcloud native & JSC pages, public search, search pagination, local lookup, fixtures and id encoding passed")
