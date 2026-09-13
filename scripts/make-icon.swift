// Draws the app icon (1024×1024 PNG): the Android app's music note over a "compress" chevron,
// on an indigo rounded square sized to the macOS icon grid.
//   swift scripts/make-icon.swift build/icon.png
// electron-builder turns this PNG into .icns (macOS) and .ico (Windows).
import AppKit
import CoreGraphics

let size = 1024
let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/icon.png"

let space = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("no context") }

// Flip to a top-left origin so the Android vector coordinates can be used as-is.
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: 1, y: -1)

// Rounded square: 824 px with a 100 px margin, per Apple's icon grid.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)

// Soft drop shadow under the tile.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: 10), blur: 28, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.28))
ctx.addPath(tilePath)
ctx.setFillColor(CGColor(red: 0.23, green: 0.2, blue: 0.69, alpha: 1))
ctx.fillPath()
ctx.restoreGState()

// Indigo gradient fill (#6D66F2 top → #3A33B0 bottom).
ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()
let gradient = CGGradient(colorsSpace: space, colors: [
    CGColor(red: 0x6D / 255.0, green: 0x66 / 255.0, blue: 0xF2 / 255.0, alpha: 1),
    CGColor(red: 0x3A / 255.0, green: 0x33 / 255.0, blue: 0xB0 / 255.0, alpha: 1),
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
ctx.restoreGState()

// Artwork from ic_launcher_foreground.xml (108-unit viewport), centred on the tile.
let scale: CGFloat = 8.6
let centre = CGPoint(x: 55, y: 60.25)
func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    CGPoint(x: 512 + (x - centre.x) * scale, y: 512 + (y - centre.y) * scale)
}

let note = CGMutablePath()
note.move(to: p(60, 30))
note.addLine(to: p(60, 56.5))
note.addCurve(to: p(54, 55), control1: p(58.3, 55.6), control2: p(56.2, 55))
note.addCurve(to: p(43, 64), control1: p(47.9, 55), control2: p(43, 59))
note.addCurve(to: p(54, 73), control1: p(43, 69), control2: p(47.9, 73))
note.addCurve(to: p(65, 64), control1: p(60.1, 73), control2: p(65, 69))
note.addLine(to: p(65, 40))
note.addLine(to: p(74, 40))
note.addLine(to: p(74, 30))
note.closeSubpath()

let chevron = CGMutablePath()
chevron.move(to: p(36, 78))
chevron.addLine(to: p(54, 86))
chevron.addLine(to: p(72, 78))
chevron.addLine(to: p(72, 82.5))
chevron.addLine(to: p(54, 90.5))
chevron.addLine(to: p(36, 82.5))
chevron.closeSubpath()

ctx.addPath(note)
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fillPath()
ctx.addPath(chevron)
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.7))
ctx.fillPath()

guard let image = ctx.makeImage() else { fatalError("no image") }
let rep = NSBitmapImageRep(cgImage: image)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath)")
