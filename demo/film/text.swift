// Renders one line of on-screen type as a transparent PNG for the rough cut (cut.py): SF Pro, white, a soft shadow so
// it reads over footage.
//   swift demo/film/text.swift "AI voice" 34 out.png [#rrggbb] [medium|semibold]
import AppKit

let args = CommandLine.arguments
guard args.count >= 4, let size = Double(args[2]) else {
    FileHandle.standardError.write("usage: text.swift <text> <size> <out.png>\n".data(using: .utf8)!)
    exit(1)
}
let text = args[1]
let out = URL(fileURLWithPath: args[3])
func hex(_ s: String) -> NSColor {
    var v: UInt64 = 0
    Scanner(string: s.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
    return NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}
let color = args.count >= 5 ? hex(args[4]) : NSColor.white
let weight: NSFont.Weight = args.count >= 6 && args[5] == "medium" ? .medium : .semibold
let font = NSFont.systemFont(ofSize: CGFloat(size), weight: weight)
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.55)
shadow.shadowBlurRadius = CGFloat(size) * 0.35
shadow.shadowOffset = .zero
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .shadow: shadow, .kern: -0.2]
let str = NSAttributedString(string: text, attributes: attrs)
let pad = CGFloat(size)
let bounds = str.size()
let w = Int(ceil(bounds.width + pad * 2))
let h = Int(ceil(bounds.height + pad * 2))
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
                                 samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                 bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
str.draw(at: NSPoint(x: pad, y: pad))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: out)
