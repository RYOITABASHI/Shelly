# B2 Contract — Tamper-Resistant Pre-Approval Grant Consumption (review finding #2)

**Created:** 2026-06-17
**Status:** Contract / design — CC-defined (driver side), Codex implements native side.
**Parent:** [B2 handoff](./2026-06-17-B2-on-device-verified-HANDOFF.md) · [Phase B escalation bridge](./2026-06-17-autonomous-mode-B2-phaseB-escalation-bridge.md)
**Companion fix:** branch `fix/b2-escalation-pubkey-pin` (finding #1, verifier-key pin).

---

## 1. The problem (security review finding #2, HIGH)

A pre-approval **grant** lets a human pre-authorize "agent may run command X (exact `commandSha256`), with signals ⊆ granted, N times, until `expiresAt`" so future matching gray ops auto-accept without a fresh human tap.

Today the grant record is human-signed (good — can't be forged), but **consumption (`usesRemaining`) is counted from `{type:"used"}` lines in `preapprovalGrantsFile`** — a JSONL the codex child can rewrite (same uid). The agent simply **deletes the `used` lines** → count resets → a real one-shot grant becomes **infinitely replayable**. The grant itself isn't forged; the *consumption ledger* is unprotected.

Driver refs (current): `loadPreapprovalGrantRecords` / use-accounting / `appendGrantUse` in `scripts/shelly-agent-driver.js`; consumption check `usedCounts.get(grantId) >= usesRemaining`.

## 2. Ground truth (why the obvious fixes don't work)

Same-uid ⇒ **filesystem permissions are not a boundary**; the agent can read/write/delete/truncate any app-private file. A "tamper-evident hash chain" in a file doesn't help either — deleting the latest receipt leaves a shorter valid chain (you can't detect a truncation without a trusted high-water mark, which needs trusted durable storage the agent can't roll back).

**Only two asymmetries are robust against a same-uid agent:**
- **(A) Android Keystore** — keys are non-extractable; the agent can't forge signatures, and Keymint can enforce a **rollback-resistant max-usage-count** (`KeyGenParameterSpec.setMaxUsageCount`, API 33+, hardware-enforced on StrongBox).
- **(B) Time** — moves forward only; the native side uses its own clock. An `expiresAt` bound can't be rolled back by the agent.

Everything below is built on (A) and (B). **Use-count via a mutable file is dropped — it is security theater.**

## 3. Design — two tiers (ship Tier 2 first; Tier 1 gated behind verified StrongBox)

The grant's trust is rooted in finding #1's pinned escalation key: the grant record is signed by the human Android-Keystore key and verified by the driver against the **pinned** verifier public key. Anything the agent must not swap (the per-grant key identity, the tier) goes **inside that signed record**.

### Tier 2 — the MVP / universal floor: short expiry, no file-based count
- A grant authorizes the **exact `commandSha256`** (+ agentId + workspaceRoot + signals ⊆ granted) **until `expiresAt`**, with a **short default expiry** (recommend ≤ 10 min, human-adjustable at approval time).
- **Drop `usesRemaining` enforcement via files entirely.** Within the window, the *exact approved command* may run more than once — within the human's authorization ("run X"), and X is pinned by `commandSha256` (cannot become a different command).
- **Ungrantable-under-Tier-2 carve-out (REQUIRED):** "run X once" and "run X 50× in 10 min" are materially different authorizations for replay-dangerous ops. **Signals that are non-idempotent / exfiltration-capable (`network-send`, and `leaves-root` writes) are Tier-1-ONLY** — they may NOT be granted as `expiry-only`. On a device without verified Tier-1 hardware, such an op always requires a fresh human tap (no grant). Tier 2 grants are limited to genuinely replay-safe ops.
- **Be honest in UI/audit:** the approval prompt says "valid for N minutes" (never "once"); the driver audits each use. Expiry is enforced against the signed `expiresAt`. This converts "infinite replay forever" → "replay of an exact replay-safe command within a short window" — bounded and disclosed.

### Tier 1 — true count enforcement, ONLY on verified secure hardware (enhancement)
- **Hardware gate (hard requirement):** the per-grant key may be labeled `keystore-maxuse` ONLY if `setIsStrongBoxBacked(true)` succeeded AND `KeyInfo.isInsideSecureHardware() == true`. `setMaxUsageCount` is rollback-resistant only on StrongBox; on a TEE-only device the counter may be resettable by a determined same-uid+reboot attack. **If StrongBox/secure-hardware is not confirmed, do NOT emit `keystore-maxuse` — fall to `expiry-only` (Tier 2).** Never make a "once" promise the device can't keep.
- **At grant creation** (Tier-1-eligible device), native generates a dedicated per-grant signing key `grant-<id>` in AndroidKeyStore with `setMaxUsageCount(usesRemaining)` + StrongBox, and embeds the key's **SPKI fingerprint** + `grantKeyMode` into the **human-signed grant record**.
- **Consumption is a native round-trip, no human tap** (reuse the file-queue): driver → `grant_spend_request` → native asks Keymint to sign a **use-receipt** with `grant-<id>`. Keymint enforces the count in hardware; after N signs it refuses → native returns `grant_spend_denied{reason:"exhausted"}`.
- Driver honors the grant only on a **valid fresh receipt** bound to *this* request (see §4 `reqId` dedup). The agent can't forge receipts (no key) and can't reset the StrongBox counter.

**Selection:** ship **Tier 2 as the MVP**. Add Tier 1 only behind the confirmed-StrongBox gate above. The driver MUST reject a grant whose `grantKeyMode` it can't satisfy (fail closed), never silently downgrade. (A `keystore-maxuse` grant emitted on unverified hardware would be *less* honest than Tier 2 alone — hence the gate.)

## 4. Wire formats (the contract)

**Grant record** (human-signed; verified via the pinned verifier key). Extends the current record:
```jsonc
{
  "by": "human", "type": "grant", "id": "<uuid>",
  "agentId": "...", "workspaceRoot": "...", "commandSha256": "...",
  "signals": ["leaves-root"],            // ⊆ GRANTABLE; never any UNGRANTABLE signal
  "usesRemaining": 1,                    // Tier-1 hardware cap; advisory under Tier-2
  "expiresAt": "<epoch-ms>", "createdAt": "<epoch-ms>",
  "requestSha256": "...", "requestTs": "...",
  "grantKeyMode": "keystore-maxuse" | "expiry-only",   // NEW — signed
  "grantKeySpki": "<base64 SPKI DER>",                 // NEW — Tier-1 only; signed
  "sigAlg": "SHA256withRSA", "signature": "<base64>"
}
```
The signed message (extend `preapprovalGrantSignatureMessage`) MUST include `grantKeyMode` and `sha256(grantKeySpki)` so the agent can neither swap the per-grant key nor downgrade `keystore-maxuse`→`expiry-only`.

**Use-receipt** (Tier 1; signed by `grant-<id>`, returned by native on spend):
```jsonc
{
  "type": "grant_use_receipt", "grantId": "...",
  "reqId": "<fresh-random-per-spend>",   // driver-generated, unique per spend (see dedup below)
  "requestSha256": "...",                // binds the receipt to THIS request
  "ts": "<epoch-ms>",
  "sigAlg": "SHA256withRSA",
  "signature": "<base64 over: grantId\nreqId\nrequestSha256\nts>"
}
```
**`reqId` uniqueness + dedup (closes receipt replay):** the driver generates a fresh random `reqId` for every spend and includes it in the signed message. The driver keeps an **accepted-`reqId` set for the run** and rejects any receipt whose `reqId` was already accepted. This is what prevents reusing one Keystore-counted sign across two requests that happen to share a `requestSha256` (identical command+args). (`seq` is intentionally NOT used — the hardware count is the total bound and `reqId` dedup is the replay bound; a `seq` field with no enforced semantics would only invite misimplementation.)

**Spend request/deny** (Tier 1; driver↔native over the existing escalation file-queue):
```jsonc
{ "type": "grant_spend_request", "grantId": "...", "reqId": "...", "requestSha256": "...", "ts": "<epoch-ms>" }
{ "type": "grant_spend_denied", "grantId": "...", "reqId": "...", "reason": "exhausted|expired|unknown|error" }
```
The receipt is the real barrier (signed by `grant-<id>`, pinned via `grantKeySpki` in the human-signed grant — no new trust root). **`grant_spend_request` is unsigned**, so a same-uid agent can inject forged spend-requests to **burn a legitimate grant's hardware count** (a self-inflicted DoS, not a bypass: it can only *exhaust* a grant, never gain a use). Mitigate: the driver owns spend-request generation for its own run; native should rate-limit spends per grant; and the driver MUST treat any unexpected `grant_spend_denied` as "fall back to a fresh human escalation," never as "grant satisfied."

## 5. Responsibilities

**CC (driver, `scripts/shelly-agent-driver.js` + asset parity):**
- Verify the grant signature over the extended message (incl. `grantKeyMode`, `grantKeySpki` fp) against the **pinned** verifier key (reuse `ensureEscalationVerifierKey`).
- Always enforce `expiresAt` (both tiers) and the existing scope match (commandSha256 + agentId + workspaceRoot + signals; UNGRANTABLE excluded).
- Tier 1: generate a fresh random `reqId` per spend, issue `grant_spend_request`, verify the returned receipt's signature against the grant's `grantKeySpki`, that `grantId/reqId/requestSha256` bind to the current request, and that the `reqId` is not in the run's accepted set; reject on deny/timeout/mismatch/replay.
- Enforce the **Tier-2 ungrantable-signal carve-out**: `network-send` / `leaves-root`-write grants are honored only with a satisfiable `keystore-maxuse` mode; otherwise no grant (fresh escalation).
- **Remove file-`used`-count as a security gate.** (May keep an audit-only counter.) Reject any grant whose `grantKeyMode` the driver can't satisfy. Fail closed everywhere.

**Codex (native, `AgentEscalationBridge.kt` et al.):**
- Tier-1 capability **gate**: emit `keystore-maxuse` ONLY when `setIsStrongBoxBacked(true)` succeeded AND `KeyInfo.isInsideSecureHardware()==true`; otherwise emit `expiry-only`. Per-grant key gen with `setMaxUsageCount`; sign use-receipts on `grant_spend_request`; emit `grant_spend_denied` (with per-grant rate-limit) when Keymint refuses.
- Grant creation: include `grantKeyMode` + `grantKeySpki` in the human-signed record; refuse to create an `expiry-only` grant for a replay-dangerous signal (force a fresh tap each time instead).
- Tier-2 UX: approval prompt shows "valid for N minutes"; short default expiry; never claim "once" without confirmed Tier-1 hardware.
- On-device verify: a Tier-1 one-shot grant is honored exactly once, then `exhausted`; deleting the grants/used file does NOT restore a use; an expired grant is refused.

## 6. Acceptance (fail-closed checks)
- Delete/empty the grants JSONL between runs → a previously consumed Tier-1 grant stays exhausted (count is in Keystore, not the file).
- Tamper `usesRemaining`/`grantKeyMode`/`grantKeySpki` in the file → signature mismatch → grant rejected.
- Tier-2 device: grant honored only for the exact `commandSha256` within `expiresAt`; after expiry → refused; audit/UI disclosed the time-window (not "once").
- Replay a captured `grant_use_receipt` (same or different request) → rejected: a reused `reqId` hits the accepted-set dedup; a different request fails the `requestSha256` binding.
- A `network-send` / `leaves-root`-write op on a non-StrongBox device → NO `expiry-only` grant; always a fresh human tap.
- Native confirms `keystore-maxuse` only when `isInsideSecureHardware()==true`; on TEE-only hardware the grant is `expiry-only` and the UI says "valid N min," not "once."
- Any verifier/receipt error, spend timeout, forged-spend exhaustion, or unsupported `grantKeyMode` → no grant (decline / fresh escalation).

---

**One-line:** drop the agent-writable use-count ledger; root consumption in Keystore (hardware max-usage-count, Tier 1) and time (short expiry, Tier 2, universal), with the per-grant key identity bound inside the human-signed grant so it inherits the finding-#1 pinned trust anchor.
