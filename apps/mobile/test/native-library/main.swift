import Foundation
import SQLite3

func require(_ condition: Bool, _ message: String) {
    precondition(condition, message)
}
let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mora-library-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: folder) }
let missing = folder.appendingPathComponent("missing.sqlite").path
do { _ = try NativeLibraryStore(path: missing); fatalError("Reader created a missing database") }
catch { require(!FileManager.default.fileExists(atPath: missing), "Missing database must not be created") }

var writer: OpaquePointer?
let path = folder.appendingPathComponent("automix.sqlite").path
require(sqlite3_open(path, &writer) == SQLITE_OK, "Writer open")
defer { sqlite3_close_v2(writer) }
func write(_ sql: String) {
    require(sqlite3_exec(writer, sql, nil, nil, nil) == SQLITE_OK, "Writer: \(String(cString: sqlite3_errmsg(writer)))")
}
write("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE tracks(id TEXT PRIMARY KEY,title TEXT,artist TEXT,album TEXT,duration REAL,status TEXT,added_at INTEGER,saved INTEGER,pinned INTEGER,cover_id TEXT,provider TEXT);
    CREATE TABLE reactions(track_id TEXT PRIMARY KEY,value INTEGER,updated_at INTEGER);
    CREATE TABLE track_sources(id INTEGER PRIMARY KEY,track_id TEXT,kind TEXT,provider TEXT,meta TEXT);
    CREATE TABLE track_bindings(track_id TEXT PRIMARY KEY,asset_id TEXT);
    CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT,updated_at INTEGER);
    CREATE TABLE playlist_tracks(id INTEGER PRIMARY KEY,playlist_id TEXT,track_id TEXT,position INTEGER);
    CREATE TABLE plays(id INTEGER PRIMARY KEY,track_id TEXT,started_at INTEGER,played_ms INTEGER,end_reason TEXT);
    INSERT INTO tracks VALUES('one','Песня ё','Артист','Альбом',180,'ok',10,1,0,'cover','local');
    INSERT INTO tracks VALUES('asset','Recording','Artist','',240,'ok',11,0,0,NULL,'youtube');
    INSERT INTO tracks VALUES('two','Другая','','',120,'ok',12,1,0,NULL,'yandex');
    INSERT INTO reactions VALUES('one',1,100),('two',1,200);
    INSERT INTO track_sources VALUES(1,'one','managed','local','{}'),(2,'asset','remote','youtube','{}'),
      (3,'two','remote','yandex','{"coverUrl":"https://avatars.mds.yandex.net/get-music/x"}');
    INSERT INTO track_bindings VALUES('one','asset');
    INSERT INTO playlists VALUES('p','Любимые',20);
    INSERT INTO playlist_tracks VALUES(12,'p','one',1),(11,'p','one',0),(13,'p','asset',2);
    INSERT INTO plays VALUES(1,'one',1000,5000,'skip'),(2,'asset',2000,10000,'transition');
    ALTER TABLE tracks ADD COLUMN album_artist TEXT NOT NULL DEFAULT '';
    ALTER TABLE tracks ADD COLUMN track_no INTEGER;
    ALTER TABLE tracks ADD COLUMN year INTEGER;
    ALTER TABLE tracks ADD COLUMN genre TEXT NOT NULL DEFAULT '';
    UPDATE tracks SET album_artist='Артист', track_no=3, year=1999, genre='Rock' WHERE id='one';
    ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tracks ADD COLUMN last_played_at INTEGER;
    UPDATE tracks SET play_count=12,last_played_at=3000 WHERE id='one';
    """)
let reader = try NativeLibraryStore(path: path)
let first = try reader.readIfChanged()!
require(first.tracks.count == 3 && first.library.map(\.id) == ["two", "one"], "Saved library excludes playback-only tracks")
require(first.tracks.first { $0.id == "one" }?.playCount == 12 && first.tracks.first { $0.id == "one" }?.lastPlayedAt == 3000, "Artist stations receive real listening statistics from SQLite")
require(first.tracks.first { $0.id == "one" }?.duration == 240, "Duration follows the bound recording")
require(first.tracks.first { $0.id == "one" }?.binding == "asset", "Binding preserved")
require(first.tracks.first { $0.id == "one" }?.offline == false, "Offline availability follows the bound remote asset")
require(first.tracks.first { $0.id == "one" }?.cover == "/api/covers/cover", "Local cover")
require(first.tracks.first { $0.id == "two" }?.cover == "https://avatars.mds.yandex.net/get-music/x", "Yandex cover")
require(first.tracks.first { $0.id == "asset" }?.offline == false, "Remote unpinned asset is not offline")
require(NativeTrack.favorites(first.library).map(\.id) == ["two", "one"], "Likes keep reaction timestamp order")
require(first.entries["p"]?.map(\.id) == [11, 12, 13], "Playlist order and duplicate track entries preserved")
require(first.playlists.first?.count == 3 && first.history.map(\.id) == [2, 1], "Playlist count and history order")
require(try reader.readIfChanged() == nil, "No new snapshot for an unchanged database")

func encoded(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? value
}
let albumsPage = NativePage(try first.page("/library/albums"))!
let albumRow = albumsPage.sections.first?.rows.first
require(albumsPage.title == "Альбомы" && albumsPage.style == "catalog", "Native albums title and style")
if case .item(let title, let subtitle, _, _, _, let path, _, _, _) = albumRow! {
    require(title == "Альбом" && (subtitle ?? "").contains("Артист"), "Album row shows the album artist")
    require(path == "/album/\(encoded("Артист"))/\(encoded("Альбом"))", "Album row links to its native page")
} else { fatalError("Album row is not an item") }
let artistsPage = NativePage(try first.page("/library/artists"))!
require(artistsPage.style == "catalog" && artistsPage.sections.first?.rows.count == 2, "Artists group saved tracks, unknown artist included")
let albumPage = NativePage(try first.page("/album/\(encoded("Артист"))/\(encoded("Альбом"))"))!
require(albumPage.title == "Альбом" && albumPage.style == "catalog" && albumPage.sections.last?.rows.count == 1, "Album page lists its saved track")
if let first = albumPage.sections.first?.rows.first, case .hero(let style, let title, let subtitle, _, _, let play, let shuffle) = first {
    require(style == "album" && title == "Альбом", "Album hero carries the album title")
    require((subtitle ?? "").contains("Артист · 1999 · 1 трек"), "Album hero shows artist, year and duration")
    require(play?.name == "playAll" && shuffle?.name == "playAll", "Album hero plays and shuffles")
} else { fatalError("Album hero row missing") }
require(!albumPage.menu.isEmpty, "Album page exposes actions in the toolbar menu")
let artistPage = NativePage(try first.page("/artist/\(encoded("Артист"))"))!
require(artistPage.title == "Артист" && artistPage.style == "catalog" && artistPage.sections.last?.rows.count == 1, "Artist page lists the artist's saved tracks")
require(artistPage.sections.count == 3, "Artist page has a hero, controls and tracks")
if let first = artistPage.sections.first?.rows.first, case .hero(let style, let title, let subtitle, _, _, let play, let shuffle) = first {
    require(style == "artist" && title == "Артист", "Artist hero carries the name")
    require((subtitle ?? "").contains("1 трек"), "Artist hero shows the track count")
    require(play?.name == "playAll" && shuffle?.name == "playAll", "Artist hero plays and shuffles")
} else { fatalError("Artist hero row missing") }
let artistControls = artistPage.sections.dropFirst().first?.rows.compactMap { row -> String? in
    if case .button(_, _, let act, _, _, _, _) = row { return act.name } else { return nil }
} ?? []
require(artistControls.contains("artistRadio") && artistControls.contains("likeAll"), "Artist controls keep radio and like-all")
let editor = NativePage(try first.page("/track-edit/one"))!
let editorFields = editor.sections.first?.rows.count
require(editor.title == "Сведения о треке" && editorFields == 6, "Track editor shows six metadata fields")
let saveRow = editor.sections.last?.rows.first
if case .button(_, _, let act, _, _, _, _) = saveRow! {
    require(act.name == "saveTrackMetadata" && (act.args["defaults"] as? [String: String])?["title"] == "Песня ё", "Track editor saves the prefilled metadata")
} else { fatalError("Track editor has no save button") }
if let artwork = editor.sections.last?.rows.last, case .file(_, _, let types, _, let act) = artwork {
    require(types == ["png", "jpeg", "webp"] && act.name == "setTrackArtwork", "Local track offers a native artwork picker")
} else { fatalError("Track editor has no artwork row") }
let page = try first.page("/playlist/p")!
let nativePage = NativePage(page)!
require(nativePage.style == "catalog" && !nativePage.menu.isEmpty, "Playlist page uses catalog style and toolbar menu")
if let first = nativePage.sections.first?.rows.first, case .hero(let style, let title, _, _, _, let play, let shuffle) = first {
    require(style == "album" && title == "Любимые", "Playlist hero carries title")
    require(play?.name == "playAll" && shuffle?.name == "playAll", "Playlist hero plays and shuffles")
} else { fatalError("Playlist hero row missing") }
require(nativePage.sections.last?.rows.count == 3, "Native playlist renders repeated entries and unsaved assets")
let history = NativePage(try first.page("/history"))!
require(history.sections.last?.rows.count == 2, "Native history includes playback-only tracks")
do { _ = try first.page("/playlist/missing"); fatalError("Missing playlist was accepted") } catch {}

write("BEGIN; UPDATE tracks SET title='Не видно' WHERE id='one'; UPDATE reactions SET value=-1 WHERE track_id='one';")
let uncommitted = try reader.readIfChanged(force: true)!
require(uncommitted.tracks.first { $0.id == "one" }?.title == "Песня ё", "Read-only connection sees only committed WAL data")
write("COMMIT")
let committed = try reader.readIfChanged()!
let changed = committed.tracks.first { $0.id == "one" }!
require(changed.title == "Не видно" && changed.reaction == -1, "Server commit refreshes metadata and reactions together")
write("UPDATE track_sources SET meta='{\"coverUrl\":\"https://untrusted.example/x\"}' WHERE track_id='two'")
let invalidCover = try reader.readIfChanged()!
require(invalidCover.tracks.first { $0.id == "two" }?.cover == nil, "Untrusted Yandex cover is rejected")
write("DELETE FROM plays; DELETE FROM playlist_tracks; DELETE FROM playlists;")
let cleared = try reader.readIfChanged()!
require(cleared.history.isEmpty && cleared.playlists.isEmpty && cleared.entries.isEmpty, "Deletes are reflected without page events")
require(cleared.remoteIndex.isEmpty, "Schema without external_id leaves remoteIndex empty")
write("ALTER TABLE track_sources ADD COLUMN external_id TEXT; UPDATE track_sources SET external_id='yt123456789' WHERE id=2; UPDATE track_sources SET external_id='200:600' WHERE id=3;")
let withRemote = try reader.readIfChanged()!
require(withRemote.remoteIndex["youtube:yt123456789"] == "asset" && withRemote.remoteIndex["yandex:200:600"] == "two", "Remote external_id index populated when column exists")
print("Native library: read-only WAL, commits, saved tracks, likes, bindings, duplicate entries, history and covers passed")
