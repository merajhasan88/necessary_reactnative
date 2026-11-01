import CoreLocation
import Foundation
import Security
import UIKit

/// The SDK's native side on iOS, shared by its five modules: the installation key, the step-up
/// key, the collector, screen protection and the secure storage. Keychain, Secure Enclave and
/// collection work runs on one serial queue off the main thread; the screen covers and the
/// location prompt are UIKit's, on the main thread. The modules (the `.mm` files beside this one)
/// are React Native's side; nothing here depends on React Native.
@objc(NecessaryNative)
public final class NecessaryNative: NSObject, CLLocationManagerDelegate {
    public typealias Resolve = (Any?) -> Void
    public typealias Reject = (String, String) -> Void

    /// One per process: the keys, their locks and the covers belong to the app, whichever React
    /// Native runtime asks.
    @objc public static let shared = NecessaryNative(
        bundleIdentifier: Bundle.main.bundleIdentifier ?? "necessary")

    private let installationKeys: InstallationKeyManager
    private let stepUpKeys: StepUpKeyManager
    private let integrityProbes = IntegrityProbeManager()
    private let store: NecessaryStore
    private let worker = DispatchQueue(label: "necessary.native", qos: .userInitiated)
    private let storageWorker = DispatchQueue(label: "necessary.storage", qos: .userInitiated)
    /// The app's own request for the location permission, answered when the person chooses; a
    /// scan never asks.
    private var locationManager: CLLocationManager?
    private var pendingLocation: Resolve?
    /// While a secret is typed: iOS lets no app block screenshots, so the windows the person sees
    /// are covered whenever the screen is recorded, mirrored or sent to AirPlay.
    private var screenProtected = false
    /// Callers holding the protection: it lasts until the last one is done.
    private var screenHolders = 0
    /// The covers in place now, one per window covered.
    private var captureCovers: [UIView] = []
    /// What moves the covers: the capture starting or stopping, and a window or a scene coming or
    /// going -- so that a cover follows the window the person sees when that window is replaced,
    /// or appears only later.
    private static let coverEvents: [Notification.Name] = [
        UIScreen.capturedDidChangeNotification,
        UIWindow.didBecomeKeyNotification,
        UIWindow.didBecomeVisibleNotification,
        UIWindow.didBecomeHiddenNotification,
        UIScene.willEnterForegroundNotification,
        UIScene.didActivateNotification,
        UIScene.didDisconnectNotification,
    ]

    init(bundleIdentifier: String) {
        // The keys' aliases are built from the host app's bundle identifier.
        installationKeys = InstallationKeyManager(bundleIdentifier: bundleIdentifier)
        stepUpKeys = StepUpKeyManager(bundleIdentifier: bundleIdentifier)
        store = NecessaryStore(service: "\(bundleIdentifier).necessary.storage")
        super.init()
    }

    // MARK: - The installation key

    @objc(getOrCreateKeyWithResolve:reject:) public func getOrCreateKey(resolve: @escaping Resolve, reject: @escaping Reject) {
        let manager = installationKeys
        run(resolve, reject) { try manager.getOrCreateKey() }
    }

    @objc(signWithPayload:resolve:reject:) public func sign(payload: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        let manager = installationKeys
        run(resolve, reject) { try manager.signPayload(payload) }
    }

    @objc(deleteKeyWithResolve:reject:) public func deleteKey(resolve: @escaping Resolve, reject: @escaping Reject) {
        let manager = installationKeys
        run(resolve, reject) { try manager.deleteKey() }
    }

    /// The reinstall hint's source, the identifier for vendor: the same for every app of this
    /// vendor on the phone. The JavaScript side hashes it before it leaves the phone.
    @objc(reinstallHintIdentifierWithResolve:reject:) public func reinstallHintIdentifier(resolve: @escaping Resolve, reject: @escaping Reject) {
        DispatchQueue.main.async {
            resolve(UIDevice.current.identifierForVendor?.uuidString ?? "")
        }
    }

    // MARK: - The collector

    @objc(collectWithRequiredProbes:challengeNonce:optionalProbes:enabledMeasurements:resolve:reject:)
    public func collect(
        requiredProbes: [String],
        challengeNonce: String,
        optionalProbes: [String],
        enabledMeasurements: [String],
        resolve: @escaping Resolve,
        reject: @escaping Reject
    ) {
        let collector = integrityProbes
        let enabled = Set(enabledMeasurements)
        run(resolve, reject) {
            collector.collect(requiredProbes: requiredProbes, challengeNonce: challengeNonce,
                              optionalProbes: optionalProbes, enabledMeasurements: enabled)
        }
    }

    /// For the location and mock_location measurements: asks the person once, from a button on
    /// the app's own screen.
    @objc(requestLocationPermissionWithResolve:reject:) public func requestLocationPermission(resolve: @escaping Resolve, reject: @escaping Reject) {
        DispatchQueue.main.async {
            let manager = self.locationManager ?? CLLocationManager()
            self.locationManager = manager
            let state = self.locationState(manager)
            guard state == "undetermined", self.pendingLocation == nil else {
                resolve(state == "undetermined" ? "none" : state)
                return
            }
            self.pendingLocation = resolve
            manager.delegate = self
            manager.requestWhenInUseAuthorization()
        }
    }

    private func locationState(_ manager: CLLocationManager) -> String {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            return manager.accuracyAuthorization == .reducedAccuracy ? "approximate" : "precise"
        case .notDetermined:
            return "undetermined"
        default:
            return "none"
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let state = locationState(manager)
        guard state != "undetermined", let pending = pendingLocation else { return }
        pendingLocation = nil
        pending(state)
    }

    // MARK: - The step-up key

    @objc(getOrCreateStepUpKeyWithFactor:resolve:reject:) public func getOrCreateStepUpKey(factor: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        let manager = stepUpKeys
        run(resolve, reject) { try manager.getOrCreateKey(factor: factor) }
    }

    /// Off the main thread: the call blocks while the system prompt is up.
    @objc(signStepUpWithPayload:reason:resolve:reject:) public func signStepUp(payload: String, reason: String, resolve: @escaping Resolve,
                                 reject: @escaping Reject) {
        let manager = stepUpKeys
        run(resolve, reject) { try manager.signPayload(payload, reason: reason) }
    }

    @objc(deleteStepUpKeyWithResolve:reject:) public func deleteStepUpKey(resolve: @escaping Resolve, reject: @escaping Reject) {
        let manager = stepUpKeys
        run(resolve, reject) { try manager.deleteKey() }
    }

    // MARK: - Screen protection

    @objc(protectWithOn:resolve:reject:) public func protect(on: Bool, resolve: @escaping Resolve, reject: @escaping Reject) {
        DispatchQueue.main.async {
            if on {
                self.screenHolders += 1
            } else if self.screenHolders > 0 {
                self.screenHolders -= 1
            }
            self.setScreenProtection(self.screenHolders > 0)
            resolve(["held": self.screenHolders > 0, "secure": false,
                     "covered_while_captured": self.screenHolders > 0])
        }
    }

    private func setScreenProtection(_ on: Bool) {
        screenProtected = on
        for name in NecessaryNative.coverEvents {
            NotificationCenter.default.removeObserver(self, name: name, object: nil)
            if on {
                NotificationCenter.default.addObserver(
                    self, selector: #selector(coverEvent(_:)), name: name, object: nil)
            }
        }
        updateCaptureCovers()
    }

    @objc private func coverEvent(_ notification: Notification) {
        updateCaptureCovers()
    }

    /// Covers, in each of the app's scenes whose screen is captured, the window the person sees --
    /// its key window, or else its first visible window at the normal level -- and nothing else.
    /// The covers are made again at every change, so that none stays on a window replaced and none
    /// is missing from a window that appeared after the protection began.
    private func updateCaptureCovers() {
        for cover in captureCovers {
            cover.removeFromSuperview()
        }
        captureCovers = []
        guard screenProtected else { return }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes where scene.screen.isCaptured {
            guard let window = scene.windows.first(where: { $0.isKeyWindow })
                ?? scene.windows.first(where: { !$0.isHidden && $0.windowLevel == .normal })
            else { continue }
            let view = UIView(frame: window.bounds)
            view.backgroundColor = .black
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            window.addSubview(view)
            captureCovers.append(view)
        }
    }

    // MARK: - The secure storage and the random source

    @objc(readWithKey:resolve:reject:) public func read(key: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        let store = self.store
        run(resolve, reject, on: storageWorker) { try store.read(key) ?? NSNull() }
    }

    @objc(writeWithKey:value:resolve:reject:) public func write(key: String, value: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        let store = self.store
        run(resolve, reject, on: storageWorker) { try store.write(key, value: value) }
    }

    @objc(removeWithKey:resolve:reject:) public func remove(key: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        let store = self.store
        run(resolve, reject, on: storageWorker) { try store.remove(key) }
    }

    @objc(randomBytesWithCount:resolve:reject:) public func randomBytes(count: Int, resolve: @escaping Resolve, reject: @escaping Reject) {
        guard count >= 0, count <= 4096 else {
            reject("INVALID_ARGUMENT", "count must be from 0 to 4096.")
            return
        }
        var bytes = [UInt8](repeating: 0, count: count)
        let status = count == 0 ? errSecSuccess : SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            reject("RANDOM_FAILED", "SecRandomCopyBytes failed (OSStatus \(status)).")
            return
        }
        resolve(Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: ""))
    }

    // MARK: - Answers

    private func run(_ resolve: @escaping Resolve, _ reject: @escaping Reject,
                     on queue: DispatchQueue? = nil, _ operation: @escaping () throws -> Any) {
        (queue ?? worker).async {
            do {
                resolve(try operation())
            } catch let failure as InstallationKeyFailure {
                reject(failure.code, failure.message)
            } catch {
                reject("NATIVE_KEY_ERROR", error.localizedDescription)
            }
        }
    }
}

/// The installation ID and the pending step-up re-enrolment, as generic-password Keychain items:
/// readable after the first unlock, on this device only, never synchronized.
final class NecessaryStore {
    private let service: String

    init(service: String) {
        self.service = service
    }

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }

    func read(_ key: String) throws -> String? {
        var request = query(key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw InstallationKeyFailure(code: "STORAGE_UNREADABLE",
                                         message: "The Keychain could not read '\(key)' (OSStatus \(status)).")
        }
        guard let data = item as? Data, let text = String(data: data, encoding: .utf8) else {
            throw InstallationKeyFailure(code: "STORAGE_UNREADABLE",
                                         message: "The Keychain item '\(key)' is not UTF-8 text.")
        }
        return text
    }

    func write(_ key: String, value: String) throws -> Bool {
        let data = Data(value.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(key)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw InstallationKeyFailure(code: "STORAGE_WRITE_FAILED",
                                         message: "The Keychain could not write '\(key)' (OSStatus \(status)).")
        }
        return true
    }

    func remove(_ key: String) throws -> Bool {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw InstallationKeyFailure(code: "STORAGE_WRITE_FAILED",
                                         message: "The Keychain could not delete '\(key)' (OSStatus \(status)).")
        }
        return true
    }
}
