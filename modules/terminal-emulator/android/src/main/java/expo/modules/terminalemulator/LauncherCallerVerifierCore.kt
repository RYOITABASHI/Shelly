package expo.modules.terminalemulator

/**
 * Who is calling LauncherIngressProvider (fact sheet §2, F2/F3, A3). Pure:
 * the Android facts come in through [Facts].
 *
 * The caller is the Binder calling UID, resolved by PackageManager to EXACTLY
 * one package (a shared UID with several packages is refused), which must be
 * the registered package of the origin's TrustedCallerStore entry and be
 * signed by one of its pinned certificates (hasSigningCertificate with
 * CERT_INPUT_SHA256, API 28+; older is refused). Nothing the caller sends —
 * getCallingPackage(), Bundle keys naming an app or "approved" — is ever an
 * input here. Only a pass yields a principal (origin `launcher`); a failure
 * yields a short code for the audit line and never reaches the caller.
 */
object LauncherCallerVerifierCore {
    const val MIN_SDK = 28

    interface Facts {
        fun sdkInt(): Int
        /** PackageManager.getPackagesForUid(uid); null when unresolvable. */
        fun packagesForUid(uid: Int): Array<String>?
        /** PackageManager.hasSigningCertificate(pkg, sha256, CERT_INPUT_SHA256). */
        fun hasCert(packageName: String, sha256: ByteArray): Boolean
    }

    sealed class Result {
        data class Verified(val principal: IngressDecision.Principal, val certDigest: String, val entry: TrustedCallerStore.Entry) : Result()
        /** [code] is for the audit line only (^[a-z_]{1,32}$). */
        data class Failed(val code: String) : Result()
    }

    /** Never throws: any exception is `verify_error`. */
    fun verify(uid: Int, entry: TrustedCallerStore.Entry?, f: Facts): Result = try {
        when {
            entry == null -> Result.Failed("verify_no_caller")
            !TrustedCallerStore.isValidEntry(entry) -> Result.Failed("verify_no_caller")
            f.sdkInt() < MIN_SDK -> Result.Failed("verify_api_level")
            else -> {
                val pkgs = f.packagesForUid(uid)
                when {
                    pkgs == null || pkgs.isEmpty() -> Result.Failed("verify_uid")
                    pkgs.size != 1 -> Result.Failed("verify_shared_uid")
                    pkgs[0] != entry.packageName -> Result.Failed("verify_package")
                    else -> {
                        val matched = entry.pins.firstOrNull { pin ->
                            val bytes = TrustedCallerStore.pinBytes(pin)
                            bytes != null && f.hasCert(entry.packageName, bytes)
                        }
                        if (matched == null) Result.Failed("verify_signature")
                        else Result.Verified(TrustedCallerStore.principalOf(entry), matched, entry)
                    }
                }
            }
        }
    } catch (e: Exception) {
        Result.Failed("verify_error")
    }
}
