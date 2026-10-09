Pod::Spec.new do |s|
  s.name           = 'T3SecureChannel'
  s.version        = '1.0.0'
  s.summary        = "Native pieces of T3 Code's end-to-end encrypted channel."
  s.description    = 'ChaCha20-Poly1305 that Hermes is too slow for, and the loopback listener encrypted routes are reached through.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
