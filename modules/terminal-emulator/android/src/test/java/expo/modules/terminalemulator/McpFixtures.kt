package expo.modules.terminalemulator

import java.io.File
import org.json.JSONObject

/**
 * Loads the shared TS/Kotlin fixtures under the repo's `__tests__/fixtures/`
 * (the same files the Jest parity tests read). Gradle runs unit tests with the
 * module directory as the working directory, so this walks up from there.
 */
object McpFixtures {
    fun load(name: String): JSONObject {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            val f = File(dir, "__tests__/fixtures/$name")
            if (f.isFile) return JSONObject(f.readText(Charsets.UTF_8))
            dir = dir.parentFile
        }
        throw IllegalStateException("fixture not found: $name")
    }
}
