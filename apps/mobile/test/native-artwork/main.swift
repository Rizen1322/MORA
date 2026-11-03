import CoreGraphics
import Foundation
import ImageIO

guard let context = CGContext(data: nil, width: 1200, height: 600, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("Context") }
context.setFillColor(CGColor(red: 0.2, green: 0.8, blue: 0.4, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1200, height: 600))
let data = NSMutableData()
guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil),
      let image = context.makeImage() else { fatalError("PNG") }
CGImageDestinationAddImage(destination, image, nil)
precondition(CGImageDestinationFinalize(destination))
guard let decoded = NativeArtworkImage.decode((data as Data).base64EncodedString()) else { fatalError("Decode") }
precondition(decoded.width == 512 && decoded.height == 256)
precondition(NativeArtworkImage.decode("invalid") == nil)
precondition(NativeArtworkImage.decode(Data(repeating: 0, count: 3 * 1024 * 1024).base64EncodedString()) == nil)
print("Native artwork: PNG decode, aspect ratio, 512px bound, invalid/oversized rejection passed")
