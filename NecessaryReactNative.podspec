require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "NecessaryReactNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = { :type => package["license"], :file => "LICENSE" }
  s.authors      = package["author"]
  s.platforms    = { :ios => "15.0" }
  s.source       = { :git => "https://github.com/merajhasan88/necessary_reactnative.git", :tag => s.version.to_s }

  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.resource_bundles = { "NecessaryReactNativePrivacy" => ["ios/PrivacyInfo.xcprivacy"] }
  s.swift_version = "5.0"
  s.frameworks = "Security", "LocalAuthentication", "CoreLocation", "CFNetwork", "UIKit"
  s.weak_frameworks = "CryptoKit"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  install_modules_dependencies(s)
end
