package com.necessarysdk.reactnative

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import java.util.WeakHashMap

/** The SDK's five native modules, sharing one native side per React Native runtime. */
class NecessaryPackage : BaseReactPackage() {
    private val natives = WeakHashMap<ReactApplicationContext, NecessaryNative>()

    private fun nativeFor(context: ReactApplicationContext): NecessaryNative =
        synchronized(natives) { natives.getOrPut(context) { NecessaryNative(context) } }

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        when (name) {
            InstallationKeyModule.NAME -> InstallationKeyModule(reactContext, nativeFor(reactContext))
            IntegrityModule.NAME -> IntegrityModule(reactContext, nativeFor(reactContext))
            StepUpKeyModule.NAME -> StepUpKeyModule(reactContext, nativeFor(reactContext))
            SecureScreenModule.NAME -> SecureScreenModule(reactContext, nativeFor(reactContext))
            StorageModule.NAME -> StorageModule(reactContext, nativeFor(reactContext))
            else -> null
        }

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        listOf(
            InstallationKeyModule.NAME to InstallationKeyModule::class.java.name,
            IntegrityModule.NAME to IntegrityModule::class.java.name,
            StepUpKeyModule.NAME to StepUpKeyModule::class.java.name,
            SecureScreenModule.NAME to SecureScreenModule::class.java.name,
            StorageModule.NAME to StorageModule::class.java.name,
        ).associate { (name, className) ->
            name to ReactModuleInfo(name, className, false, false, false, true)
        }
    }
}
