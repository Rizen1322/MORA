import Foundation

let old = Data(#"{"now":{"title":"Трек","artist":"Исполнитель"},"playing":false,"liked":[],"likedCount":0}"#.utf8)
let decoded = try JSONDecoder().decode(NativeWidgetData.self, from: old)
assert(decoded.now?.title == "Трек")
assert(decoded.updatedAt == nil)
var updated = decoded
updated.updatedAt = Date(timeIntervalSince1970: 1234)
let roundtrip = try JSONDecoder().decode(NativeWidgetData.self, from: JSONEncoder().encode(updated))
assert(roundtrip == updated)
print("Native widget compatibility passed")
