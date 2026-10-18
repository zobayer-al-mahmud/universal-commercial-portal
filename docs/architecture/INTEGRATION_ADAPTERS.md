# Integration Adapters

All external destinations sit behind an adapter interface with three modes. **Live
is disabled by default and fails closed** until a business decision + credentials are
approved (SRS §9, Q-SC-11, Q-PORT-01).

| Mode | Behaviour |
|------|-----------|
| `mock` (default) | Simulates a save + deterministic read-back verification; no network |
| `dryrun` | Logs the intended action; makes no external call |
| `live` | **Not implemented** — returns a fail-closed message with the pending decision |

Set globally via `INTEGRATION_MODE`.

## UCP Sales Contract adapter

`src/server/integrations/ucp-adapter.ts`

1. **Pre-write identifier verification (§7.3):** refuses to write if the block
   contract ref fails `^AGL/H&M/\d{2,3}/\d{4}$`; a full implementation also verifies
   the OrderNo + Contract Ref shown on the destination form.
2. **Save vs submit (§E-09, Q-SC-12):** saves as Draft unless `AUTO_SUBMIT=true`
   **and** no open review tickets.
3. **Post-write read-back (§7.4, SC-NFR-09):** reads the destination record and diffs
   every mapped field; any diff blocks the `verified` transition.

## Portal adapters (H&M / Bangladesh Bank / Damco)

Registered in `IntegrationAdapter` with status `not_configured`. No interactions are
implemented — the source folders were empty and only the checklist named URLs and
credentials. When authorised:

- Use the official authenticated API if one exists; otherwise supported browser
  automation (Playwright) with named selectors, assertions, and screenshots.
- Never bypass CAPTCHA/MFA/access controls; a challenge pauses the job and alerts an
  operator.
- Banking actions (Bangladesh Bank) default to draft/dry-run.

## Adding a live integration (checklist)

1. Resolve the relevant decision (Q-SC-11 / Q-PORT-01).
2. Add credentials to the secrets manager; set `INTEGRATION_MODE=live` for that adapter.
3. Implement the `live` branch with pre-write verify + post-write read-back.
4. Add integration tests against a sandbox account before enabling in production.
