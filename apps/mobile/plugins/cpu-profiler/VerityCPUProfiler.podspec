Pod::Spec.new do |s|
  s.name = 'VerityCPUProfiler'
  s.version = '1.0.0'
  s.summary = 'Bounded, manually started Hermes sampling for diagnostic builds.'
  s.homepage = 'https://github.com/Heey-Global/verity'
  s.license = 'Apache-2.0'
  s.author = 'Verity contributors'
  s.platform = :ios, '27.0'
  s.source = { :git => 'https://github.com/Heey-Global/verity.git' }
  s.source_files = '*.{h,mm,swift}'
  s.dependency 'React-Core'
  s.dependency 'React-jsi'
  s.dependency 'hermes-engine'
  s.dependency 'EXUpdates'
  s.swift_version = '5.0'
  s.module_name = 'VerityCPUProfiler'
  s.pod_target_xcconfig = { 'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20' }
end
