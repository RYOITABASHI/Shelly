package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** council-facade's on-device launch spec parser (ManagedServices.ExternalSpec). */
class ExternalSpecTest {
    private val home = "/data/user/0/x/files/home"

    private val validJson = """
        {
          "v": 1,
          "root": "council-spike",
          "script": "dist/http/server.js",
          "env": {
            "COUNCIL_HTTP_TOKEN": {"fromFile": true},
            "COUNCIL_HOME": "council-spike-home",
            "COUNCIL_PAIRING_ARM": "1"
          }
        }
    """.trimIndent()

    @Test
    fun parsesAMinimalValidSpecAndAppliesDefaults() {
        val r = ExternalSpec.parse(validJson, home)
        assertEquals("ok", r.reason)
        val launch = r.launch!!
        assertEquals("council-spike/dist/http/server.js", launch.script)
        assertEquals("council-spike", launch.workDir)
        assertEquals(emptyList<String>(), launch.args)
        assertEquals(ManagedServices.DEFAULT_ENV, launch.env)

        val env = launch.extraEnv.filterIsInstance<ManagedServices.EnvVar.Literal>().associate { it.name to it.value }
        assertEquals("$home/council-spike-home", env["COUNCIL_HOME"])
        assertEquals("host:operator", env["COUNCIL_PRINCIPAL"]) // default
        assertEquals("host:operator", env["COUNCIL_HUMAN_PRINCIPALS"]) // default
        assertEquals("8790", env["COUNCIL_HTTP_PORT"]) // default
        assertEquals("1", env["COUNCIL_PAIRING_ARM"])
        assertEquals("codex_exec", env["COUNCIL_CODEX_COMMAND"]) // fixed, not from the file
        assertEquals("--skip-git-repo-check -", env["COUNCIL_CODEX_ARGS"]) // fixed, not from the file
        assertEquals("claude_exec", env["COUNCIL_CLAUDE_COMMAND"]) // fixed, not from the file
        assertFalse(env.containsKey("COUNCIL_CLAUDE_ARGS")) // council-tool's claude preset (-p)
        assertFalse(launch.extraEnv.any { it.name == "CLAUDE_CODE_OAUTH_TOKEN" }) // the runner loads it, never this env

        val secret = launch.extraEnv.filterIsInstance<ManagedServices.EnvVar.FromFile>().single()
        assertEquals("COUNCIL_HTTP_TOKEN", secret.name)
        assertEquals("$home/council-spike-home/.http-token", secret.path)

        val health = r.health!!
        assertEquals(8790, health.port)
        assertEquals(ExternalSpec.HEALTH_TIMEOUT_MS, health.timeoutMs)
        assertEquals(ExternalSpec.HEALTH_STALE_MS, health.staleMs)
    }

    @Test
    fun honorsExplicitOverridesOfTheDefaultableKeys() {
        val json = """
            {
              "v": 1, "root": "council-spike", "script": "dist/http/server.js",
              "env": {
                "COUNCIL_HTTP_TOKEN": {"fromFile": true},
                "COUNCIL_HOME": "council-spike-home",
                "COUNCIL_PAIRING_ARM": "1",
                "COUNCIL_PRINCIPAL": "host:owner",
                "COUNCIL_HUMAN_PRINCIPALS": "host:owner,host:hayato",
                "COUNCIL_HTTP_PORT": "9001"
              }
            }
        """.trimIndent()
        val r = ExternalSpec.parse(json, home)
        assertEquals("ok", r.reason)
        val env = r.launch!!.extraEnv.filterIsInstance<ManagedServices.EnvVar.Literal>().associate { it.name to it.value }
        assertEquals("host:owner", env["COUNCIL_PRINCIPAL"])
        assertEquals("host:owner,host:hayato", env["COUNCIL_HUMAN_PRINCIPALS"])
        assertEquals("9001", env["COUNCIL_HTTP_PORT"])
        assertEquals(9001, r.health!!.port)
    }

    @Test
    fun refusesAMissingOrOversizedFile() {
        assertNull(ExternalSpec.parse(null, home).launch)
        assertEquals("missing", ExternalSpec.parse(null, home).reason)
        val huge = validJson + " ".repeat(ExternalSpec.MAX_BYTES.toInt())
        assertEquals("too_large", ExternalSpec.parse(huge, home).reason)
    }

    @Test
    fun refusesBrokenOrUnknownShapedJson() {
        assertEquals("bad_json", ExternalSpec.parse("not json", home).reason)
        assertEquals("bad_json", ExternalSpec.parse("", home).reason)
        assertEquals("unknown_key", ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{},"extra":"x"}""", home,
        ).reason)
        assertEquals("bad_version", ExternalSpec.parse(
            """{"v":2,"root":"council-spike","script":"dist/http/server.js","env":{}}""", home,
        ).reason)
    }

    @Test
    fun refusesOutOfRangeOrTraversingPaths() {
        fun withRoot(root: String) = ExternalSpec.parse(
            """{"v":1,"root":"$root","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_HOME":"h","COUNCIL_PAIRING_ARM":"1"}}""",
            home,
        ).reason
        assertEquals("bad_root", withRoot(".."))
        assertEquals("bad_root", withRoot("../../etc"))
        assertEquals("bad_root", withRoot("/etc/passwd"))
        assertEquals("bad_root", withRoot("council-spike/x"))
        assertEquals("bad_root", withRoot(""))

        fun withScript(script: String) = ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"$script","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_HOME":"h","COUNCIL_PAIRING_ARM":"1"}}""",
            home,
        ).reason
        assertEquals("bad_script", withScript("../escape.js"))
        assertEquals("bad_script", withScript("/abs/server.js"))
        assertEquals("bad_script", withScript("dist/http/server.sh"))
        assertEquals("bad_script", withScript("dist//server.js"))
        // Only the facade's own entry point: any other .js under root is refused.
        assertEquals("bad_script", withScript("dist/other.js"))
        assertEquals("bad_script", withScript("dist/http/server2.js"))
        assertEquals("bad_script", withScript("server.js"))
        assertEquals("ok", withScript("dist/http/server.js"))

        fun withCouncilHome(ch: String) = ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_HOME":"$ch","COUNCIL_PAIRING_ARM":"1"}}""",
            home,
        ).reason
        assertEquals("bad_env_value", withCouncilHome("../outside"))
        assertEquals("bad_env_value", withCouncilHome("/abs/path"))
    }

    @Test
    fun refusesALiteralSecretValueAndAcceptsOnlyTheFromFileMarker() {
        fun withToken(tokenJson: String) = ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":$tokenJson,"COUNCIL_HOME":"h","COUNCIL_PAIRING_ARM":"1"}}""",
            home,
        )
        assertEquals("secret_not_reference", withToken("\"sk-live-abc123\"").reason)
        assertEquals("secret_not_reference", withToken("true").reason)
        assertEquals("secret_not_reference", withToken("{\"fromFile\":false}").reason)
        assertEquals("secret_not_reference", withToken("{\"fromFile\":\"/etc/passwd\"}").reason)
        assertEquals("secret_not_reference", withToken("{\"fromFile\":true,\"extra\":1}").reason)
        assertEquals("ok", withToken("{\"fromFile\":true}").reason)
        // The literal value, if any, never survives into the parsed launch: a
        // refused parse never has a Launch to carry it, by construction.
        assertNull(withToken("\"sk-live-abc123\"").launch)
    }

    @Test
    fun refusesUnknownOrMissingEnvKeys() {
        assertEquals("unknown_env_key", ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_HOME":"h","COUNCIL_PAIRING_ARM":"1","COUNCIL_CODEX_COMMAND":"rm -rf /"}}""",
            home,
        ).reason)
        assertEquals("unknown_env_key", ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_HOME":"h","COUNCIL_PAIRING_ARM":"1","COUNCIL_CLAUDE_COMMAND":"sh"}}""",
            home,
        ).reason)
        assertEquals("missing_env_key", ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HOME":"h","COUNCIL_PAIRING_ARM":"1"}}""",
            home,
        ).reason)
        assertEquals("missing_env_key", ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_PAIRING_ARM":"1"}}""",
            home,
        ).reason)
        assertEquals("missing_env_key", ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_HOME":"h"}}""",
            home,
        ).reason)
        assertEquals("bad_env", ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js"}""",
            home,
        ).reason)
    }

    @Test
    fun refusesAPairingArmThatIsNotTheLiteralOne() {
        fun withArm(v: String) = ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_HOME":"h","COUNCIL_PAIRING_ARM":$v}}""",
            home,
        ).reason
        assertEquals("bad_env_value", withArm("\"true\""))
        assertEquals("bad_env_value", withArm("\"0\""))
        assertEquals("bad_env_value", withArm("true"))
        assertEquals("ok", withArm("\"1\""))
    }

    @Test
    fun refusesAnOutOfRangeOrMalformedPort() {
        fun withPort(v: String) = ExternalSpec.parse(
            """{"v":1,"root":"council-spike","script":"dist/http/server.js","env":{"COUNCIL_HTTP_TOKEN":{"fromFile":true},"COUNCIL_HOME":"h","COUNCIL_PAIRING_ARM":"1","COUNCIL_HTTP_PORT":"$v"}}""",
            home,
        ).reason
        assertEquals("bad_env_value", withPort("0"))
        assertEquals("bad_env_value", withPort("65536"))
        assertEquals("bad_env_value", withPort("-1"))
        assertEquals("bad_env_value", withPort("8790x"))
        assertEquals("bad_env_value", withPort(""))
        assertEquals("ok", withPort("65535"))
    }

    @Test
    fun theHostCommandNeverEmbedsTheSecretLiteral() {
        val launch = ExternalSpec.parse(validJson, home).launch!!
        val cmd = ManagedServices.hostCommand(launch, home, "/data/lib", "$home/.shelly/services/council-facade/output.log")
        assertTrue(cmd.contains("cd '$home/council-spike' || exit 126\n"))
        assertTrue(cmd.contains("export COUNCIL_CODEX_COMMAND='codex_exec'\n"))
        assertTrue(cmd.contains("export COUNCIL_CLAUDE_COMMAND='claude_exec'\n"))
        assertTrue(cmd.contains("export COUNCIL_PAIRING_ARM='1'\n"))
        val tokenPath = "'$home/council-spike-home/.http-token'"
        assertTrue(cmd.contains("[ -f $tokenPath ] || exit 127\n"))
        // Tracing a sourced .bashrc may have turned on is off before the read,
        // and the value is read (no command substitution a trace would expand).
        val traceOff = cmd.indexOf("builtin set +o xtrace +o verbose; builtin trap - DEBUG\n")
        val read = cmd.indexOf("IFS= builtin read -r COUNCIL_HTTP_TOKEN < $tokenPath || [ -n \"\$COUNCIL_HTTP_TOKEN\" ] || exit 127\n")
        assertTrue(traceOff >= 0 && read > traceOff)
        assertTrue(cmd.indexOf(". \"\$HOME/.bashrc\"") in 0 until traceOff)
        assertTrue(cmd.contains("builtin export COUNCIL_HTTP_TOKEN\n"))
        assertFalse(cmd.contains("\$(cat"))
        assertTrue(cmd.contains("exec /system/bin/linker64 '/data/lib/node' '$home/council-spike/dist/http/server.js'\n"))
        assertTrue(cmd.trimEnd('\n').endsWith("'$home/council-spike/dist/http/server.js'"))
        // node runs with the exec wrapper so it can spawn codex_exec (an app-data
        // ELF) itself; set after `date`, and the STOP-ALL check stays last.
        assertTrue(launch.execWrapper)
        val lines = cmd.trimEnd('\n').split('\n')
        val preload = lines.indexOf("export LD_PRELOAD='/data/lib/libexec_wrapper.so'")
        assertTrue(preload > lines.indexOfFirst { it.startsWith("printf ") })
        assertEquals(lines.size - 3, preload)
        // ...right after the lib dir is put first on PATH, so the bare
        // codex_exec resolves to the APK-extracted launcher.
        assertEquals("export PATH='/data/lib':\"\$PATH\"", lines[lines.size - 4])
        assertTrue(lines[lines.size - 2].startsWith("[ -e "))
    }
}
