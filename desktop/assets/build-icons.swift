// NoKey artwork: native vector paths, shared between iPhone, Mac and menu bar.
import AppKit
let root = URL(fileURLWithPath: CommandLine.arguments[1])
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> NSColor { NSColor(srgbRed: r/255, green: g/255, blue: b/255, alpha: 1) }
func mark() {
    let bubble = NSBezierPath()
    bubble.move(to: NSPoint(x:39,y:99)); bubble.line(to:NSPoint(x:89,y:99))
    bubble.curve(to:NSPoint(x:105,y:83),controlPoint1:NSPoint(x:98,y:99),controlPoint2:NSPoint(x:105,y:92))
    bubble.line(to:NSPoint(x:105,y:49)); bubble.curve(to:NSPoint(x:89,y:33),controlPoint1:NSPoint(x:105,y:40),controlPoint2:NSPoint(x:98,y:33))
    bubble.line(to:NSPoint(x:57,y:33)); bubble.line(to:NSPoint(x:36,y:21)); bubble.line(to:NSPoint(x:36,y:34))
    bubble.curve(to:NSPoint(x:23,y:50),controlPoint1:NSPoint(x:28,y:34),controlPoint2:NSPoint(x:23,y:42)); bubble.line(to:NSPoint(x:23,y:83))
    bubble.curve(to:NSPoint(x:39,y:99),controlPoint1:NSPoint(x:23,y:92),controlPoint2:NSPoint(x:30,y:99))
    bubble.lineWidth=7; bubble.lineJoinStyle = .round; bubble.stroke()
    let arrow=NSBezierPath(); arrow.move(to:NSPoint(x:84,y:77)); arrow.line(to:NSPoint(x:84,y:58)); arrow.line(to:NSPoint(x:48,y:58)); arrow.move(to:NSPoint(x:58,y:68)); arrow.line(to:NSPoint(x:48,y:58)); arrow.line(to:NSPoint(x:58,y:48)); arrow.lineWidth=7; arrow.lineCapStyle = .round; arrow.lineJoinStyle = .round; arrow.stroke()
}
func render(_ size: Int, _ kind: String, _ target: URL) throws {
    let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:rep)
    let transform=AffineTransform(scale:CGFloat(size)/1024); (transform as NSAffineTransform).concat()
    if kind != "tray" {
        let rect = kind == "ios" ? NSRect(x:0,y:0,width:1024,height:1024) : NSRect(x:64,y:76,width:896,height:896)
        let tile=NSBezierPath(roundedRect:rect,xRadius:kind == "ios" ? 0 : 194,yRadius:kind == "ios" ? 0 : 194)
        NSGraphicsContext.saveGraphicsState()
        if kind == "mac" { let shadow=NSShadow();shadow.shadowColor=NSColor.black.withAlphaComponent(0.16);shadow.shadowBlurRadius=28;shadow.shadowOffset=NSSize(width:0,height:-13);shadow.set() }
        color(241,241,232).setFill();tile.fill();NSGraphicsContext.restoreGraphicsState()
        NSGradient(starting:color(250,250,245),ending:color(226,230,218))!.draw(in:tile,angle:-65)
        if kind == "mac" {color(218,221,211).setStroke();tile.lineWidth=2;tile.stroke()}
    }
    NSGraphicsContext.saveGraphicsState()
    let translate=NSAffineTransform(); translate.translateX(by:kind == "tray" ? 0 : 64,yBy:kind == "tray" ? 0 : 50);translate.scale(by:kind == "tray" ? 8 : 7);translate.concat()
    if kind != "tray" {let shadow=NSShadow();shadow.shadowColor=color(98,106,89).withAlphaComponent(0.22);shadow.shadowOffset=NSSize(width:0,height:-1.2);shadow.shadowBlurRadius=1.6;shadow.set()}
    (kind == "tray" ? NSColor.black : color(67,74,64)).setStroke();mark()
    NSGraphicsContext.restoreGraphicsState();NSGraphicsContext.restoreGraphicsState()
    if kind == "ios" {
        let rgb = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        rgb.draw(rep.cgImage!, in: CGRect(x: 0, y: 0, width: size, height: size))
        let output = NSBitmapImageRep(cgImage: rgb.makeImage()!)
        let background = output.colorAt(x: 10, y: 10)!.usingColorSpace(.deviceRGB)!
        let symbol = output.colorAt(x: 220, y: 512)!.usingColorSpace(.deviceRGB)!
        precondition(background.redComponent > 0.8 && background.greenComponent > 0.8 && symbol.redComponent < 0.5,
            "NoKey icon render failed: expected a light background and dark symbol")
        try output.representation(using: .png, properties: [:])!.write(to: target)
    } else {
        try rep.representation(using:.png,properties:[:])!.write(to:target)
    }
}
try render(1024,"ios",root.appendingPathComponent("mobile/assets/images/icon-nokey.png"))
try render(1024,"mac",root.appendingPathComponent("desktop/assets/NoKey.png"))
try render(36,"tray",root.appendingPathComponent("desktop/assets/trayTemplate@2x.png"))
try render(18,"tray",root.appendingPathComponent("desktop/assets/trayTemplate.png"))
