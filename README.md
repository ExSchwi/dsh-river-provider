# dsh-river-provider

A DeepSeek Harness provider plugin for [river.ai](https://docs.river.ai/) built around one
problem the stock OpenAI-compatible path ignores: **you have more than one river.ai key.**

Every request picks a usable account on its own, a rejected key is parked with a reason
instead of being retried forever, and the model picker gets a live catalog with real
context/output limits, per-model reasoning efforts and per-million-token prices.

- Provider id: `river`
- Endpoint: `https://api.river.ai/v1` (Chat Completions, streaming)
- Requires DSH `0.2.1-rc.2`

## Why not just the OpenAI-compatible provider

`dsh-llm-pi-ai` pointed at river.ai works for one key. It cannot do any of this:

| Gap on the generic path | What this plugin does |
| --- | --- |
| One key per provider row — N accounts means N providers and a manual switch | One row, unlimited accounts, automatic rotation |
| A rate-limited key keeps getting picked, so a turn fails until you edit config | Rejected keys are marked (window / throttle / auth) and skipped |
| `reasoning_effort` is passed through blindly | Per-model whitelists (`DeepSeek-V4.1-Flash` has no `low`; `GLM-5.3-Flash` needs one) |
| No `reasoning_content` handling | `reasoning_content` becomes a reasoning block, `content` a text block |
| Context/output sizes guessed or hardcoded | Real limits from the bundled catalog + live `/v1/models` |
| Cost unknown | Per-million prices, including cached input, refreshed from the console |
| A 429 loses the whole turn | `Retry-After` becomes `providerRetryAfterMs`, so the harness waits instead of failing |

## Install

```bash
dsh plugin --profile web add github:ExSchwi/dsh-river-provider#v0.1.0
```

`--profile` is **required** — `dsh plugin` forwards its remaining arguments to pnpm inside
that profile, and DSH refuses to guess which profile you meant. Substitute your profile name
(`web`, `tui`, …) for `web`.

`dsh plugin add` records the package in the profile's `dependencies` and `dsh.profile.bundles`
and lets DSH compose the bundle layer itself — do not hand-edit those files.

The repo ships a prebuilt `lib/`, so the install needs no build step and pnpm never asks you
to allowlist a build script. (If you install from a source checkout instead, `npm run build`
first — `lib/` is the only entry point, `src/` is not shipped.)

The package ships a `cordis.patch.yml`, so installing it inserts its plugin row
automatically:

```yaml
- insert:
    - id: llm-river
      name: "@mars-sea/dsh-river-provider"
      config:
        apiKeyEnv: RIVERAI_API_KEY
```

Restart DSH afterwards. Then set the credential and enable the provider:

```bash
dsh credentials set RIVERAI_API_KEY rv_...     # or put it in .credentials.yaml
dsh config set llm-river.apiKeyEnv RIVERAI_API_KEY
```

The model picker then lists `river` models. Nothing about the provider is required for
other providers to keep working — this plugin registers only its own route.

> Restart is mandatory and a restart is not a reload: a session's context budget is fixed
> when the session is created, so an already-open conversation keeps the old limits. Open a
> new session to see the plugin's models.

## Accounts

One account is the `apiKeyEnv` / `apiKey` pair at the top level. Additional ones go in
`accounts`:

```yaml
llm-river:
  apiKeyEnv: RIVERAI_API_KEY
  accounts:
    - label: Work
      apiKeyEnv: RIVERAI_API_KEY_WORK
    - label: Spare
      apiKey: rv_...          # literal; prefer the env var
  modelAccountRules:
    - models: ["zai-org/GLM-*"]
      account: Work
  activeAccount: ""           # empty = rotate
```

Rules are applied in this order:

1. **Model rule** — a `modelAccountRules` entry whose glob matches the model id.
2. **Pinned account** — `activeAccount`, if that account is currently usable.
3. **Rotation** — the next usable account, starting after the last one used.
4. **Revival probe** — when every account is marked, cooldowns that have elapsed are
   retried once before giving up.

A key is marked after the provider rejects it:

| river.ai response | Mark | Effect |
| --- | --- | --- |
| `429` | `rate-limit` | skipped until `Retry-After` elapses |
| `402`, `403` with quota text | `throttled` | skipped for a fixed window |
| `401` | `invalid-credential` | disabled until the key changes |
| `503` | `throttled` | backed off, then retried |

`/river-accounts` prints what the pool currently believes:

```
- Default (default) — ready
- Work (RIVERAI_API_KEY_WORK) — cooling down 42s: rate-limit
- Spare (account-3) — disabled: invalid credential
```

A single turn can walk through several accounts: the key is resolved per HTTP attempt, not
per turn, so a rate-limited key mid-conversation costs one retry rather than the reply.

### Retry budget

DSH's retry layer reads `providerRetryAfterMs` from the failure and gives up once the wait
exceeds the adapter's `maxDelayMs`. This plugin reports `maxDelayMs = 900_000` (15 minutes,
matching river.ai's documented response ceiling) and counts one retry per account rotation,
so the budget is 16 rotations × 4.

**Retries are billed again.** river.ai's limits page is explicit: *"Incomplete streams cannot
be resumed; retries are new requests and may incur additional charges."* A turn that dies
halfway and is retried pays for the tokens of the attempt that failed as well — and the same
page warns *"Do not replay completed tool actions"*, so a retry also re-runs whatever the
model asks for next. When a reply keeps dying mid-stream the account is usually not the
problem; lower `streamIdleTimeoutMs`/`requestTimeoutMs` to fail faster, or move to a shorter
prefill.

## Reasoning

`reasoning_effort` is validated per model before the request is sent, because river.ai
rejects a value a model does not support:

| Model | Accepted efforts |
| --- | --- |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | `none`, `high`, `max` |
| `deepseek-ai/DeepSeek-V4.1-Flash` | `none`, `high`, `max` |
| `zai-org/GLM-5.3-Flash` | `low`, `high`, `max` (always reasoning) |
| `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4` | none — no published table |

No river model accepts `medium`. The picker offers exactly what the table lists and nothing
else, so a level that would be a `400` cannot be chosen in the first place. Two different
paths meet the rest of that wall:

- **`defaultReasoningEffort`** (this plugin's setting) is validated strictly. A value the
  model does not accept is a configuration error and is reported as one — nothing is snapped
  behind your back, because a snapped level changes both what the model does and what it
  costs, on every turn, with nothing to notice.
- **A per-turn request** from the harness may carry an alias river has never heard of
  (`minimal`, `xhigh`, `ultra`). Those are translated to the nearest supported level,
  cheaper side on a tie: a caller asking for `low` on DeepSeek gets `none`, not `high`.

Reasoning text arrives as a thinking block ahead of the answer rather than being glued onto
it.

## Context and output budget

`/v1/models` returns only `id`, `object` and `owned_by` — no context window, no output
ceiling, no modality list. Limits therefore come from a snapshot maintained against the
docs. A model river ships tomorrow still gets the full 1M context every river model
publishes, no effort picker it might reject, and a 32K output ceiling until the snapshot
names it.

Nothing caps the context unless you say so, so the advertised window is the model's own 1M:

```yaml
llm-river:
  contextWindowLimit: 262144   # optional: 1M → 256K
  maxOutputTokens: 65536       # optional: 64K instead of the model's 384K
```

Both are worth lowering, and not only for cost. `maxOutputTokens` becomes each request's
`max_tokens`, and DSH's compaction reserves that same amount when it decides how much
history fits. Pinning the documented maxima (context 1,048,576 / output 384,000) leaves
almost no room for compaction — the pressure budget collapses to near zero and long
sessions thrash. A 256K window with a 64K output budget keeps both meaningful.

A `finish_reason` of `length` arrives as `max-tokens`: the answer was cut, so raise
`maxOutputTokens` for that model rather than retrying the same turn.

## Images

JPEG and PNG are forwarded as base64 with the harness attachment store as the source — the
25 MB per-image limit and the 50 MiB request-body limit are checked before the request goes
out, and an oversized image fails the turn with a clear message instead of a `413`.

## Models and prices

The catalog comes from `/v1/models` and is merged over a bundled snapshot, so a new river.ai
model shows up without a plugin release. Prices are per million tokens and refreshed from
`https://console.river.ai/api/public/pricing` at most every six hours; a failed refresh
keeps the last known table rather than blanking it.

To trim the picker:

```yaml
llm-river:
  visibleModels: ["deepseek-ai/DeepSeek-V4.1-Flash-1017"]
  modelVisibility:
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": false
```

## Other settings

| Key | Default | Meaning |
| --- | --- | --- |
| `apiBase` | `https://api.river.ai/v1` | Endpoint base |
| `apiKeyEnv` | `RIVERAI_API_KEY` | Credential ref for the first account |
| `apiKey` | — | Literal key for the first account |
| `activeAccount` | — | Pin to one account; empty rotates |
| `modelAccountRules` | `[]` | Model → account routing |
| `requestTimeoutMs` | 900000 | Whole-request budget |
| `streamIdleTimeoutMs` | 600000 | Longest mid-stream silence |
| `maxOutputTokens` | per model | Output ceiling; also the request's `max_tokens` |
| `contextWindowLimit` | per model | Ceiling for the advertised context window |
| `defaultReasoningEffort` | `{}` | Default effort per model id or glob; invalid values error |
| `visibleModels` | `[]` | Allow-list for the picker |
| `modelVisibility` | `{}` | Per-model overrides |

## Reasoning effort and context as settings

Two knobs bound what a model costs. Both accept a per-model map or a ceiling, and
neither can push a number past what the model actually supports:

```yaml
llm-river:
  # Per model id (or glob). Must be a level that model accepts — anything else is
  # reported as a configuration error. "auto" keeps the model's own default.
  defaultReasoningEffort:
    "deepseek-ai/DeepSeek-V4.1-Flash-1017": high
    "zai-org/GLM-*": max
  # Advertised context ceiling. Only ever lowers the model's own capacity.
  contextWindowLimit: 262144
  # Output ceiling. Never above the model maximum.
  maxOutputTokens: 65536
```

`defaultReasoningEffort` is resolved when the harness asks for a model's metadata, so
it becomes the route's `defaultEffort`: a request that omits an effort gets it, a
request that names one keeps it, and the choice is recorded in the session's request
header. `auto` and an empty value both mean "no opinion" — a model nobody configured
keeps its own default rather than inheriting another model's.

The value is checked against that model's whitelist and, unlike a per-turn request, it is
never snapped: `low` on a DeepSeek model raises
`DeepSeek-V4.1-Flash accepts only none|high|max for reasoning_effort, not "low"` instead of
quietly becoming `none`. Naming a model the snapshot does not know yet is rejected the same
way — there is no whitelist to validate against until the snapshot lists it.

`contextWindowLimit` is the ceiling for the window advertised to the harness, which is
what the usage meter, compaction thresholds and the reference-file budget read. It does
not change the request body: river has no field for it.

Keep `contextWindowLimit` comfortably above `maxOutputTokens`. `dsh-compaction-basic`
reserves the effective `max_tokens` out of the advertised window before computing its
pressure threshold, so a window that barely exceeds the output budget leaves compaction
no room and it refuses to run. With river's documented maximums (1,048,576 context vs
384,000 output) that margin is thin — capping both, as above, is the configuration this
plugin is tested against.

## Development

```bash
npm run typecheck
npm test                     # 62 offline tests, no network
npx tsdown                   # build lib/
```

Two opt-in tools hit the real API and are never part of `npm test`:

```bash
RIVERAI_API_KEY=rv_... node --import tsx tools/live-smoke.ts     # protocol, usage, errors
RIVERAI_API_KEY=rv_... RIVERAI_API_KEY_2=rv_... \
  node --import tsx tools/live-accounts.ts                     # two-account rotation
```

`tools/dump-frames.ts` records raw SSE frames to a file for offline replay, which is how
protocol changes get diagnosed without burning quota.

## Not included, on purpose

The upstream plugin this was modelled on carries Command Code-specific surfaces: a login
flow, plan filtering, zero-data-retention headers, a hosted web-search backend and TUI
quota widgets. river.ai has no equivalent endpoint for any of them, so none are faked here.
