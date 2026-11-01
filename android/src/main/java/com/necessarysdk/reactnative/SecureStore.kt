package com.necessarysdk.reactnative

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The installation ID and the pending step-up re-enrolment, kept in the app's private
 * preferences, each value encrypted (AES-256-GCM) under a key AndroidKeyStore holds and never
 * exports. The key is made only where the keystore, answering, holds none (KeyPresence): made over
 * one the keystore could not reach, it would leave every stored value unreadable. A value that
 * cannot be decrypted is reported, never read as absent.
 */
internal class SecureStore(context: Context) {
    companion object {
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private const val PREFIX = "v1:"

        // One reader or writer at a time in the process, whichever runtime asks.
        private val lock = Any()
    }

    private val preferences =
        context.applicationContext.getSharedPreferences("com.necessarysdk.reactnative.storage", Context.MODE_PRIVATE)
    private val keyAlias = "${context.packageName}.necessary.storage.v1"
    private val probeAlias = "$keyAlias.probe"

    fun read(name: String): String? = synchronized(lock) {
        val stored = preferences.getString(name, null) ?: return null
        try {
            if (!stored.startsWith(PREFIX)) throw IllegalArgumentException("unknown format")
            val bytes = Base64.decode(stored.substring(PREFIX.length), Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, existingKey(), GCMParameterSpec(TAG_BITS, bytes, 0, 12))
            String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
        } catch (error: InstallationKeyFailure) {
            throw error
        } catch (error: Exception) {
            throw InstallationKeyFailure(
                "STORAGE_UNREADABLE",
                "The stored value '$name' could not be decrypted; it was kept.",
                error,
            )
        }
    }

    fun write(name: String, value: String): Boolean = synchronized(lock) {
        val cipher = try {
            Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, keyForWriting()) }
        } catch (error: GeneralSecurityException) {
            throw InstallationKeyFailure("STORAGE_WRITE_FAILED", "The value '$name' could not be encrypted.", error)
        }
        val iv = cipher.iv
        val sealed = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val encoded = PREFIX + Base64.encodeToString(iv + sealed, Base64.NO_WRAP)
        if (!preferences.edit().putString(name, encoded).commit()) {
            throw InstallationKeyFailure("STORAGE_WRITE_FAILED", "The value '$name' could not be written.")
        }
        true
    }

    fun remove(name: String): Boolean = synchronized(lock) {
        if (!preferences.edit().remove(name).commit()) {
            throw InstallationKeyFailure("STORAGE_WRITE_FAILED", "The value '$name' could not be removed.")
        }
        true
    }

    private fun keyStore(): KeyStore =
        try {
            KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        } catch (error: Exception) {
            throw InstallationKeyFailure("STORAGE_UNAVAILABLE", "AndroidKeyStore could not be opened.", error)
        }

    private fun existingKey(): SecretKey {
        val keyStore = keyStore()
        return keyStore.getKey(keyAlias, null) as? SecretKey
            ?: throw InstallationKeyFailure(
                "STORAGE_UNREADABLE",
                "The key the stored values are encrypted under is not in AndroidKeyStore.",
            )
    }

    private fun keyForWriting(): SecretKey {
        val keyStore = keyStore()
        val found = KeyPresence.of(object : KeyPresence.Keystore {
            override fun containsKey() = keyStore.containsAlias(keyAlias)
            override fun deleteProbe() = keyStore.deleteEntry(probeAlias)
        })
        when (found.answer) {
            KeyPresence.Answer.PRESENT -> return keyStore.getKey(keyAlias, null) as? SecretKey
                ?: throw InstallationKeyFailure(
                    "STORAGE_UNAVAILABLE",
                    "AndroidKeyStore holds the storage key's alias but gave no key.",
                )
            KeyPresence.Answer.UNAVAILABLE -> throw InstallationKeyFailure(
                "STORAGE_UNAVAILABLE",
                "AndroidKeyStore could not be reached for the storage key; nothing was written.",
                found.cause,
            )
            KeyPresence.Answer.ABSENT -> {
                val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
                generator.init(
                    KeyGenParameterSpec.Builder(
                        keyAlias,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build(),
                )
                return generator.generateKey()
            }
        }
    }
}
