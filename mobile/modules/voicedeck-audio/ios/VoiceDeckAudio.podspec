Pod::Spec.new do |s|
  s.name = 'VoiceDeckAudio'
  s.version = '0.1.0'
  s.summary = 'VoiceDeck explicit microphone session and system interruption handling'
  # Upstream project homepage; this local module is not independently published.
  s.homepage = 'https://github.com/Kappaemme-git/microdex'
  s.license = { :type => 'GPL-3.0-only' }
  s.author = 'VoiceDeck contributors'
  # Local-only pod, discovered in mobile/modules by Expo autolinking.
  s.source = { :path => '.' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.dependency 'JitsiWebRTC', '~> 124.0.0'
end
