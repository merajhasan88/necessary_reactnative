package com.necessarysdk.reactnative

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray

// The SDK's five native modules, each a thin door to the one native side its runtime shares
// (NecessaryNative). The specs they implement are generated from src/native/*.ts.

class InstallationKeyModule internal constructor(
    context: ReactApplicationContext,
    private val native: NecessaryNative,
) : NativeNecessaryInstallationKeySpec(context) {
    override fun getName() = NAME
    override fun getOrCreateKey(promise: Promise) = native.getOrCreateKey(promise)
    override fun sign(payload: String, promise: Promise) = native.sign(payload, promise)
    override fun deleteKey(promise: Promise) = native.deleteKey(promise)
    override fun reinstallHintIdentifier(promise: Promise) = native.reinstallHintIdentifier(promise)

    companion object {
        const val NAME = "NecessaryInstallationKey"
    }
}

class IntegrityModule internal constructor(
    context: ReactApplicationContext,
    private val native: NecessaryNative,
) : NativeNecessaryIntegritySpec(context) {
    override fun getName() = NAME
    override fun collect(
        requiredProbes: ReadableArray,
        challengeNonce: String,
        optionalProbes: ReadableArray,
        enabledMeasurements: ReadableArray,
        promise: Promise,
    ) = native.collect(requiredProbes, challengeNonce, optionalProbes, enabledMeasurements, promise)
    override fun requestLocationPermission(promise: Promise) {
        native.requestLocationPermission(promise)
    }

    companion object {
        const val NAME = "NecessaryIntegrity"
    }
}

class StepUpKeyModule internal constructor(
    context: ReactApplicationContext,
    private val native: NecessaryNative,
) : NativeNecessaryStepUpKeySpec(context) {
    override fun getName() = NAME
    override fun getOrCreateKey(factor: String, mode: String, windowSeconds: Double, promise: Promise) =
        native.getOrCreateStepUpKey(factor, mode, windowSeconds.toInt(), promise)
    override fun sign(payload: String, reason: String, mode: String, promise: Promise) {
        native.signStepUp(payload, reason, mode, promise)
    }
    override fun deleteKey(promise: Promise) = native.deleteStepUpKey(promise)

    companion object {
        const val NAME = "NecessaryStepUpKey"
    }
}

class SecureScreenModule internal constructor(
    context: ReactApplicationContext,
    private val native: NecessaryNative,
) : NativeNecessarySecureScreenSpec(context) {
    override fun getName() = NAME
    override fun protect(on: Boolean, promise: Promise) {
        native.protect(on, promise)
    }

    companion object {
        const val NAME = "NecessarySecureScreen"
    }
}

class StorageModule internal constructor(
    context: ReactApplicationContext,
    private val native: NecessaryNative,
) : NativeNecessaryStorageSpec(context) {
    override fun getName() = NAME
    override fun read(key: String, promise: Promise) = native.read(key, promise)
    override fun write(key: String, value: String, promise: Promise) = native.write(key, value, promise)
    override fun remove(key: String, promise: Promise) = native.remove(key, promise)
    override fun randomBytes(count: Double, promise: Promise) = native.randomBytes(count.toInt(), promise)
    override fun invalidate() {
        native.invalidate()
        super.invalidate()
    }

    companion object {
        const val NAME = "NecessaryStorage"
    }
}
