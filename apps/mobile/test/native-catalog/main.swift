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
state.soundcloud = nil // the fixtures below replace the native provider
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

print("Native catalog: yandex artist and album, pagination, public and soundcloud pages, fixtures and id encoding passed")
