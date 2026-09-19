// SPDX-License-Identifier: GPL-3.0-only
import Foundation
import UIKit
import AVFAudio
import ExpoModulesCore
import WebRTC

public final class VoiceDeckAudioModule: Module {
  private var discovery: NoKeyDiscovery?
  private let lock = NSRecursiveLock()
  private var captureId: String?
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("VoiceDeckAudio")
    Events("interrupted")
    AsyncFunction("discoverBridges") { (promise: Promise) in
      DispatchQueue.main.async {
        self.discovery?.finish()
        guard UIApplication.shared.applicationState == .active else { promise.resolve([String]()); return }
        self.discovery = NoKeyDiscovery(promise: promise)
        self.discovery?.start()
      }
    }
    Function("cancelDiscovery") {
      DispatchQueue.main.async { self.discovery?.finish() }
    }

    OnCreate { self.observeInterruptions() }
    OnDestroy { self.destroy() }

    // Arm before getUserMedia: a late permission reply cannot revive a cancelled capture.
    Function("arm") { () -> String in
      self.lock.lock()
      defer { self.lock.unlock() }
      let audio = RTCAudioSession.sharedInstance()
      audio.useManualAudio = true
      audio.isAudioEnabled = false
      let id = UUID().uuidString
      self.captureId = id
      return id
    }
    Function("activate") { (id: String) -> Bool in
      self.lock.lock()
      defer { self.lock.unlock() }
      guard self.captureId == id else { return false }
      RTCAudioSession.sharedInstance().isAudioEnabled = true
      return true
    }
    Function("stop") { (id: String) in
      self.lock.lock()
      defer { self.lock.unlock() }
      guard self.captureId == id else { return }
      self.captureId = nil
      RTCAudioSession.sharedInstance().isAudioEnabled = false
    }
  }

  private func observeInterruptions() {
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in self?.interrupt("background") })
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
      self?.interrupt("system")
      // Ended/shouldResume is deliberately ignored: only a new user action enables audio.
    })
    for name in [AVAudioSession.mediaServicesWereLostNotification, AVAudioSession.mediaServicesWereResetNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.interrupt("media-service") })
    }
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
      self?.interrupt("input-disconnected")
    })
  }

  private func interrupt(_ reason: String) {
    DispatchQueue.main.async { self.discovery?.finish() }
    lock.lock()
    let id = captureId
    captureId = nil
    if id != nil { RTCAudioSession.sharedInstance().isAudioEnabled = false }
    lock.unlock()
    // The native gate is closed even if JS is suspended or this event is delivered late.
    if let id { sendEvent("interrupted", ["captureId": id, "reason": reason]) }
  }

  private func destroy() {
    DispatchQueue.main.async { self.discovery?.finish() }
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
    lock.lock()
    captureId = nil
    RTCAudioSession.sharedInstance().isAudioEnabled = false
    lock.unlock()
  }
}

private final class NoKeyDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  let browser = NetServiceBrowser()
  var services: [NetService] = []
  var addresses: [String] = []
  var timer: Timer?
  var promise: Promise?
  init(promise: Promise) { self.promise = promise }
  func start() {
    browser.delegate = self
    browser.searchForServices(ofType: "_nokey._tcp.", inDomain: "local.")
    timer = Timer.scheduledTimer(withTimeInterval: 0.9, repeats: false) { [weak self] _ in self?.finish() }
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    guard promise != nil, services.count < 12 else { return }
    services.append(service); service.delegate = self; service.resolve(withTimeout: 0.7)
  }
  func netServiceDidResolveAddress(_ service: NetService) {
    guard promise != nil, let hostname = service.hostName, service.port > 0 else { return }
    let host = hostname.hasSuffix(".") ? String(hostname.dropLast()) : hostname
    if host.hasSuffix(".local") { addresses.append("http://\(host):\(service.port)") }
  }
  func finish() {
    timer?.invalidate(); timer = nil; browser.stop(); browser.delegate = nil
    for service in services { service.stop(); service.delegate = nil }
    services.removeAll(); let pending = promise; promise = nil; pending?.resolve(Array(Set(addresses)))
  }
}
