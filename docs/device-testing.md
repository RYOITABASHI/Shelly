# Device testing

Shelly is verified end to end on one phone, a Galaxy Z Fold6 (N=1). This page covers two ways to widen that: an automated smoke test on Firebase Test Lab, and device reports from people who run Shelly on their own phones.

## Device reports from community testers

1. In a Shelly terminal pane run:

   ```
   shelly doctor --report
   ```

   It prints a Markdown block: Shelly version, Android version and API level, manufacturer and model, ABI, RAM and free storage, whether bash / git / Node / Python 3 / `codex --version` run, All-files access, notification permission, battery-optimization exemption, whether Codex is signed in (yes or no only), and any doctor warnings.

   The report deliberately omits tokens, account emails, IMEI, serial numbers, Android ID, IP addresses and file paths. Some probes (notification permission, battery exemption) can be blocked by the device's security policy; those lines then say `unknown`.

2. Open the [device report form](https://github.com/RYOITABASHI/Shelly/issues/new?template=device-report.yml), paste the block, tick what you tried and mark each area as works / partly works / broken.

A report that says "works" is as useful as one that says "broken".

## Firebase Test Lab smoke test

Workflow: `.github/workflows/device-smoke-test-lab.yml`. It runs on manual dispatch, and automatically after a successful `Build Android APK` run on `main`. It downloads the `shelly-apk` artifact of that build and runs a Robo test (no instrumentation) on a few physical arm64 devices.

### What it checks

- The release APK installs on each device model and Android version.
- The app launches and the Robo crawler can navigate for the timeout without a crash or ANR.
- Per-device logcat, crash stack traces and screen recordings are collected into the `test-lab-results` artifact, and a pass/fail table goes into the job summary.

### What it does not check

- Anything behind a sign-in (Codex, ChatGPT remote control, API keys), so no real agent run, no scheduled agent firing with the screen off, no ClosePaw.
- Terminal correctness beyond "does not crash": Robo taps and types at random, it does not run a script.
- OEM background-process killing over hours, which is the main cross-OEM risk for unattended agents.
- Anything that needs the All-files-access grant or other special permissions that Robo cannot approve.

Treat a green run as "installs and does not crash on launch on these models", not as "works on these models".

### Owner setup (one time)

1. Create a Firebase project at <https://console.firebase.google.com> on the free Spark plan. Test Lab on Spark has a small daily quota for physical devices; check the current limits on the Firebase pricing page, since they change.
2. In the linked Google Cloud project, enable the **Cloud Testing API** and the **Cloud Tool Results API**.
3. Create a service account for CI and grant it the minimum it needs. A starting point: **Firebase Test Lab Admin** (`roles/cloudtestservice.testAdmin`) to start tests and **Storage Object Viewer** on the results bucket to download logs. Add **Firebase Viewer** if gcloud asks for it. Do not use Owner or Editor. Verify the exact role names in the IAM console, they can be renamed.
4. Create a JSON key for that service account.
5. In the GitHub repo go to Settings, Secrets and variables, Actions, and add:
   - `GCP_SA_KEY`: the full contents of the JSON key
   - `GCP_PROJECT_ID`: the Firebase / GCP project ID
6. Delete the downloaded key file from your machine.
7. Confirm device IDs. The IDs in the workflow are placeholders and Test Lab retires and adds models regularly:

   ```
   gcloud firebase test android models list --filter="form=PHYSICAL"
   ```

   Edit `TEST_LAB_DEVICES` in the workflow to a mix such as a Pixel, a Samsung A-series, a Xiaomi / Redmi and a OnePlus, all arm64, using the `model=` and `version=` values from that list.

If either secret is missing the workflow ends early with a notice and does not fail.

### Limits to keep in mind

- Test Lab has a daily test quota on the free plan and per-test time limits. Check the current numbers in the Firebase documentation before relying on automatic runs, and consider using manual dispatch only if the quota is tight.
- Test Lab has an upload size limit for APKs. Shelly bundles a lot of binaries, so check that the release APK is still under the current limit; if it is not, the run fails at upload and this workflow cannot test that build.
- The workflow uploads your APK to Google's infrastructure. Do not point it at a build that contains secrets.
