# Mandatory free delegation

Adds a mandatory subagent-delegation mandate to the system prompt of the root
cloud agent, and keeps child agents on free cloud routes instead of the paid
parent route.

## What it does

The mandate is a `systemPrompt` section whose text is computed per assembly.
It is emitted only when all of these hold:

- an agent is being assembled (`AssembleContext.agent` is set — a registry-only
  assembly addresses nobody);
- the agent's delegation depth is `0`, so the mandate reaches the root agent and
  never a child;
- the agent's provider is not one of the configured `localProviders`;
- the agent's active preset is one of `mandatePresets` — by default `standard`
  and `lead` only.

The last condition is a user requirement: the hard single-executor rule applies
in the standard mode and the lead ("Руководитель") mode, and nowhere else. The
active preset is read through the optional `agentPresets` service with
`composedPreset(agent.ctx)` — the same call `dsh-cabinet-mode`, `tool-schedule`
and `childSessionMeta` use. When the service is absent or the preset is not
recorded, the preset counts as unidentified and no mandate is emitted: the hard
rule never widens silently. `cordis` and `ptc` also have `agentOptions` removed
from their `tool-subagent` rows, so a child there inherits the parent route as
before.

The mandate also instructs the root agent not to hand a whole complex task to a
subagent: the executor is weaker, so the task must be split into small
verifiable steps issued one per call, each step checked against its expected
result, with the root model owning the final result. The mandate is prompt-level
guidance; the root model answers for the outcome.

A child runs at depth `1` while the Host `maxDepth` defaults to `1`, so it
cannot delegate at all. Sending it an unconditional "every reply must call
`subagent`" order would make it attempt a call that the depth check rejects and
burn the turn. The preset persona is a static string and cannot see depth; a
prompt section with a text function receives the assembly context and decides
from the facts.

## Why a Host plugin rather than preset persona text

Preset persona text is static. Only a registered prompt section can vary its
text per agent, and only a Host plugin can register one profile-wide, covering
every preset at once.

## Configuration

`cordis.patch.yml` of this bundle inserts the row:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` removes the section entirely |
| `localProviders` | `ollama-local`, `lmstudio-local` | Root agents on these providers get no mandate |
| `mandatePresets` | `standard`, `lead` | Presets in which the hard single-executor rule applies; any other preset gets no mandate |
| `executor` | `aiai-by` / `solar-mini-4-5` | The default (cheap) executor named in the mandate text |
| `escalation` | `aiai-by` / `hy4-flash` | The second executor, used only on escalation. Omit it, or set it to `null`, to return to the single-executor rule. Set equal to `executor` and it is ignored. |

## Two executors

When `escalation` is configured and differs from `executor`, the mandate declares
two routes instead of the hard single-executor rule: the cheap one is the default,
and the second is used only on escalation. The choice is by task complexity, not by
token price, because measurements on 2026-11-27 showed the cheap model wins only
on short tasks:

| Task | Cheap (`solar-mini-4-5`) | Second (`hy4-flash`) | Outcome |
|---|---|---|---|
| Short (`slugify`, one file) | 0.00141 BYN, 20.9 s, 8 requests | 0.01264 BYN, 67.7 s, 23 requests | cheap is 9× cheaper and 3× faster |
| Complex (`parseDuration`, 8 rules) | 0.01708 BYN, 180.4 s, 39 requests | 0.01682 BYN, 116.5 s, 22 requests | cheap is *more* expensive and 55 % slower |

Escalate to the second route when the task needs images (the cheap model has no
vision), needs more than 524K tokens of context, has complex interacting logic, is
initially vague, or when the cheap model looped or failed twice.

The mandatory `enforce` guard is unchanged by this setting: the root still cannot
use working tools until it has started at least one subagent.

## Delivery checks

`test/mandate.test.mjs` (43 checks), `test/enforcement.test.mjs` (33 checks) and
`test/mutation-check.mjs` (10 mutants, all killed) all pass at the time of writing.

## Limitations

- The mandate is prompt-level guidance, not enforcement. Nothing prevents the
  root agent from calling a tool directly; the section only instructs it.
- Child routes are pinned by `tool-subagent.agentOptions` in each preset, not by
  this bundle. This bundle names the providers in the mandate text.
- Free routes are subject to provider rate limits and regional gating; the
  mandate tells the agent to verify availability with `list_subagent_models`
  before choosing, but a route can still refuse mid-task.
