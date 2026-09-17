// SPDX-License-Identifier: GPL-3.0-only
import Foundation
import AVFAudio
import ExpoModulesCore
import WebRTC

public final class VoiceDeckAudioModule: Module {
  private let lock = NSRecursiveLock()
  private var captureId: String?
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("VoiceDeckAudio")
    Events("interrupted")

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
    lock.lock()
    let id = captureId
    captureId = nil
    if id != nil { RTCAudioSession.sharedInstance().isAudioEnabled = false }
    lock.unlock()
    // The native gate is closed even if JS is suspended or this event is delivered late.
    if let id { sendEvent("interrupted", ["captureId": id, "reason": reason]) }
  }

  private func destroy() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
    lock.lock()
    captureId = nil
    RTCAudioSession.sharedInstance().isAudioEnabled = false
    lock.unlock()
  }
}
