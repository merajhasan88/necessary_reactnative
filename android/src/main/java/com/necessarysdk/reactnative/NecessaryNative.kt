package com.necessarysdk.reactnative

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.lang.ref.WeakReference
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The SDK's native side on Android, one per React Native runtime and shared by its five modules:
 * the installation key, the step-up key, the collector, screen protection and the secure storage.
 * The keys and the collector run on one worker thread; the step-up prompt, the location prompt and
 * the window are the current activity's, on the main thread.
 */
internal class NecessaryNative(private val reactContext: ReactApplicationContext) :
    ActivityEventListener,
    LifecycleEventListener {

    companion object {
        private const val LOCATION_REQUEST = 4721
        private val random = SecureRandom()
    }

    private val context: Context = reactContext.applicationContext
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val storageWorker: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val installationKeys = InstallationKeyManager(context)
    private val integrityProbes = IntegrityProbeManager(context) { reactContext.currentActivity }
    private val stepUpKeys = StepUpKeyManager(context)
    private val secureStore = SecureStore(context)
    private val screenGuard = ScreenGuard()
    // The app's own request for the location permission, answered when the person chooses; the
    // collector itself never asks.
    private var pendingLocation: Promise? = null
    // The activity the window state belongs to: a new one, while the screen is protected, is
    // protected too.
    private var attached: WeakReference<Activity>? = null

    init {
        reactContext.addActivityEventListener(this)
        reactContext.addLifecycleEventListener(this)
    }

    // MARK: the installation key

    fun getOrCreateKey(promise: Promise) = runOffMainThread(promise) { installationKeys.getOrCreateKey() }

    fun sign(payload: String, promise: Promise) = runOffMainThread(promise) { installationKeys.signPayload(payload) }

    fun deleteKey(promise: Promise) = runOffMainThread(promise) { installationKeys.deleteKey() }

    // The reinstall hint's source, ANDROID_ID: scoped to the phone, the user and the app's signing
    // key. The JavaScript side hashes it before it leaves the phone; empty when the platform gives
    // none.
    fun reinstallHintIdentifier(promise: Promise) = runOffMainThread(promise) {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
    }

    // MARK: the collector

    fun collect(
        requiredProbes: ReadableArray,
        challengeNonce: String,
        optionalProbes: ReadableArray,
        enabledMeasurements: ReadableArray,
        promise: Promise,
    ) {
        val required = strings(requiredProbes)
        val optional = strings(optionalProbes)
        val enabled = strings(enabledMeasurements).toSet()
        runOffMainThread(promise) { integrityProbes.collect(required, challengeNonce, optional, enabled) }
    }

    // For the location and mock_location measurements: asks the person once, from a button on the
    // app's own screen.
    fun requestLocationPermission(promise: Promise) = mainHandler.post {
        val activity = reactContext.currentActivity
        if (locationState() == "precise" || pendingLocation != null || activity !is PermissionAwareActivity) {
            promise.resolve(locationState())
            return@post
        }
        pendingLocation = promise
        activity.requestPermissions(
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
            LOCATION_REQUEST,
            PermissionListener { requestCode, _, _ ->
                if (requestCode != LOCATION_REQUEST) return@PermissionListener false
                pendingLocation?.resolve(locationState())
                pendingLocation = null
                true
            },
        )
    }

    private fun locationState(): String = when {
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED -> "precise"
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED -> "approximate"
        else -> "none"
    }

    // MARK: the step-up key

    fun getOrCreateStepUpKey(factor: String, mode: String, windowSeconds: Int, promise: Promise) =
        runOffMainThread(promise) { stepUpKeys.getOrCreateKey(factor, mode, windowSeconds) }

    // On the main thread: it shows the system prompt, and the keystore signs inside the prompt's
    // callback.
    fun signStepUp(payload: String, reason: String, mode: String, promise: Promise) = mainHandler.post {
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "The step-up prompt needs a visible activity.")
            return@post
        }
        try {
            stepUpKeys.sign(activity, payload, reason, mode) { outcome ->
                outcome.fold(
                    { signature -> promise.resolve(signature) },
                    { error -> reportStepUpFailure(promise, error) },
                )
            }
        } catch (error: Throwable) {
            // Whatever failed before the prompt, said with its causes.
            reportStepUpFailure(promise, error)
        }
    }

    fun deleteStepUpKey(promise: Promise) = runOffMainThread(promise) { stepUpKeys.deleteKey() }

    // MARK: screen protection

    // On the main thread: it changes the window.
    fun protect(on: Boolean, promise: Promise) = mainHandler.post {
        val activity = reactContext.currentActivity
        if (on) {
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "Screen protection needs a visible activity.")
                return@post
            }
            attached = WeakReference(activity)
            screenGuard.acquire(windowState(activity))?.let { applyScreen(activity, it) }
        } else {
            // Counted even without a window, so a release is never lost.
            val change = screenGuard.release()
            if (activity != null && change != null) applyScreen(activity, change)
        }
        promise.resolve(Arguments.makeNativeMap(screenState(activity)))
    }

    /**
     * While a secret is typed: the window cannot be captured in screenshots, recordings or casts
     * (FLAG_SECURE); other apps' windows are not drawn over it (Android 12 and later,
     * HIDE_OVERLAY_WINDOWS, a normal permission); and a touch that passed through another app's
     * window is dropped. ScreenGuard decides when, and what the window gets back. The phone's own
     * screen-lock prompt is the system's window and needs none of this from the app.
     */
    private fun applyScreen(activity: Activity, change: ScreenGuard.Change) {
        val window = activity.window
        if (change.secure) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        if (overlaysHideable()) window.setHideOverlayWindows(change.hideOverlays)
        window.decorView.filterTouchesWhenObscured = change.dropsObscuredTouches
    }

    private fun overlaysHideable(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            context.checkSelfPermission("android.permission.HIDE_OVERLAY_WINDOWS") ==
            PackageManager.PERMISSION_GRANTED

    private fun windowState(activity: Activity) = ScreenGuard.WindowState(
        secure = (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0,
        dropsObscuredTouches = activity.window.decorView.filterTouchesWhenObscured,
    )

    /** What the window has now, and whether the SDK holds it. */
    private fun screenState(activity: Activity?): Map<String, Any> = mapOf(
        "held" to screenGuard.held,
        "secure" to (activity?.let { windowState(it).secure } ?: false),
        "overlays_hidden" to (screenGuard.held && overlaysHideable()),
        "obscured_touches_dropped" to (activity?.let { windowState(it).dropsObscuredTouches } ?: false),
    )

    // MARK: the secure storage and the random source

    fun read(name: String, promise: Promise) = runOn(storageWorker, promise) { secureStore.read(name) }

    fun write(name: String, value: String, promise: Promise) =
        runOn(storageWorker, promise) { secureStore.write(name, value) }

    fun remove(name: String, promise: Promise) = runOn(storageWorker, promise) { secureStore.remove(name) }

    fun randomBytes(count: Int, promise: Promise) {
        if (count < 0 || count > 4096) {
            promise.reject("INVALID_ARGUMENT", "count must be from 0 to 4096.")
            return
        }
        val bytes = ByteArray(count)
        random.nextBytes(bytes)
        promise.resolve(Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))
    }

    // MARK: the activity

    // Delivers the confirm-credential result the step-up key uses before Android 11.
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        stepUpKeys.onActivityResult(requestCode, resultCode)
    }

    override fun onNewIntent(intent: Intent) {}

    // A new activity while the screen is protected -- the old one recreated -- is protected too.
    override fun onHostResume() {
        val activity = reactContext.currentActivity ?: return
        if (attached?.get() === activity) return
        attached = WeakReference(activity)
        screenGuard.reattach(windowState(activity))?.let { applyScreen(activity, it) }
    }

    override fun onHostPause() {}

    // Gone for good: a step-up waiting for the confirm-credential result would never hear it, and
    // would hold every later approval at STEPUP_BUSY. A recreated activity still receives the
    // result, so a step-up waiting for it keeps waiting.
    override fun onHostDestroy() {
        val activity = attached?.get() ?: reactContext.currentActivity
        if (activity?.isChangingConfigurations == true) return
        stepUpKeys.cancelPendingConfirmation()
    }

    /** The runtime is going away: its threads with it. */
    fun invalidate() {
        reactContext.removeActivityEventListener(this)
        reactContext.removeLifecycleEventListener(this)
        stepUpKeys.cancelPendingConfirmation()
        worker.shutdown()
        storageWorker.shutdown()
    }

    // MARK: answers

    private fun strings(array: ReadableArray): List<String> =
        (0 until array.size()).mapNotNull { index -> array.getString(index) }

    private fun runOffMainThread(promise: Promise, operation: () -> Any?) = runOn(worker, promise, operation)

    private fun runOn(executor: ExecutorService, promise: Promise, operation: () -> Any?) {
        try {
            executor.execute {
                try {
                    promise.resolve(answer(operation()))
                } catch (error: InstallationKeyFailure) {
                    promise.reject(error.errorCode, error.report(::keystoreDetail))
                } catch (error: Throwable) {
                    // Name the exception and its cause: a release build's log output is suppressed on
                    // some phones, so the message shown in the app is the only diagnostic there is.
                    val detail = buildString {
                        append("The Android native operation failed: ")
                        append(Causes.chain(error, ::keystoreDetail))
                        append(" at ")
                        append(error.stackTrace.take(6).joinToString(" < ") {
                            "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}"
                        })
                    }
                    promise.reject("NATIVE_INTEGRITY_ERROR", detail)
                }
            }
        } catch (error: java.util.concurrent.RejectedExecutionException) {
            promise.reject("DETACHED", "The SDK's native side has been shut down with its runtime.")
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun answer(value: Any?): Any? = when (value) {
        is Map<*, *> -> Arguments.makeNativeMap(value as Map<String, Any?>)
        is List<*> -> Arguments.makeNativeArray(value)
        else -> value
    }

    /** A step-up signature that failed: its code, and its words with every cause beneath them. */
    private fun reportStepUpFailure(promise: Promise, error: Throwable) {
        if (error is InstallationKeyFailure) {
            promise.reject(error.errorCode, error.report(::keystoreDetail))
        } else {
            promise.reject(
                "NATIVE_STEPUP_ERROR",
                "The step-up signature failed: " + Causes.chain(error, ::keystoreDetail),
            )
        }
    }

    /**
     * AndroidKeyStore's own error code, which its exception's message may leave out: public from
     * Android 13 (API 33), with whether the keystore deems the failure transient.
     */
    private fun keystoreDetail(error: Throwable): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
        val keystore = error as? android.security.KeyStoreException ?: return null
        return "code ${keystore.numericErrorCode}" + if (keystore.isTransientFailure) ", transient" else ""
    }
}
