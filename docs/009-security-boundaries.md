# 009 Security boundaries

This document defines what authorizes work, which component must enforce each
restriction, and what must be true before enabling unattended execution. It
builds on [002 Authorization](002-authorization.md), [003 Execution](003-execution.md)
and [006 Deployment](006-deployment.md).

## Trust model

Treat every Issue, pull request, commit, review, Feishu message, attachment,
tool result and file in a Ticket directory as untrusted data. A message may
describe work; it cannot grant permission, change Policy, select credentials or
expand a Ticket's scope. Prompt text is guidance to a model, not an authorization
boundary.

The DSH host and every plugin loaded into its process are trusted code. A plugin
with access to the host process can use its process privileges; another plugin
must not be treated as isolated just because it has a separate Cordis entry or
agent preset.

## Required authorization flow

1. **Receive:** a Source validates the event and derives actor identity,
   addressed status, repository and receiving scope from the provider response.
   Never accept those values from model output or message text.
2. **Gate:** the host evaluates the Source-specific allowlist, admission cell,
   bot status and accept mode. Default to deny. A display name or identity on
   another Source is not authorization.
3. **Decide:** inferred work requires the configured assessment and enabled
   rules. Accept only a settled direction with intent evidence. In `observe`
   mode, record a proposal rather than starting work.
4. **Bind:** an accepted Ticket receives a Mandate for its Source, Thread,
   requester, rule set and scope. Follow-ups and context-only subscriptions
   provide information, not additional authority. Revalidate the Mandate before
   resuming work.
5. **Execute:** create the role-specific DSH Session and work directory. The
   worker may act only with credentials and machine access explicitly granted
   to the deployment; do not rely on its prompt to enforce a limit.
6. **Commit side effects:** separate code changes from irreversible actions.
   Push only to the Ticket branch and configured repository. Require protected
   branches and required reviews/status checks for merge or deployment actions.
7. **Record:** retain the Trigger, Policy version, Decision, Mandate, relevant
   approval and result. Do not write credentials or credential-bearing command
   arguments to prompts, errors or logs.

## Non-negotiable behavior

- An unlisted person, unlisted bot, disabled Source or out-of-scope Thread
  cannot start work. A bot can at most create an inferred candidate where its
  Source Policy allows it.
- A quote, prompt injection, generated assessment or tool result cannot change
  the requester, Source, Policy, repository, branch or allowed action.
- A Ticket cannot accept work outside its Mandate. A follow-up cannot turn a
  context-only Thread into an authorized work Thread.
- Removing authorization or changing Policy must prevent a stale Mandate from
  being resumed. Policy changes do not currently interrupt an already-running
  turn; deployments that require immediate revocation must stop affected
  workers as part of the change.
- A worker must not merge, deploy, alter repository settings, grant access,
  access another repository or use an operator's personal account unless a
  separate, host-enforced capability explicitly permits that action.

## Controls the application does and does not provide

The host implements Source-specific authorization, assessment validation,
Mandate revalidation, role-specific tool presets, repository-bound GitHub API
paths and worker environment cleanup. The focused tests are under
`tests/policy.spec.ts`, `tests/commands.spec.ts`, `tests/environment.spec.ts`,
`tests/http.spec.ts` and `tests/bundle-patch.spec.ts`.

These controls do **not** make a worker an OS sandbox. `src/app/sessions.ts`
sets DSH Sessions to `danger-full-access`; the worker runs as the service's OS
user. The command shims and blocked-command list only affect commands resolved
by name, and a process can use an absolute path or access files available to
that OS user. See [003 Execution](003-execution.md) and [006 Deployment](006-deployment.md).

The worker's GitHub and Feishu CLIs also represent real credentials. Prompts
that say “do not merge” or “use only this repository” do not constrain arbitrary
shell commands. Repository branch protection and token/account permissions are
the enforcement points for push, merge and administrative operations.

The management API binds to loopback and checks the Host, an optional Origin and
a fixed request header. This is a browser-origin/CSRF check, not authentication
against another local process. Do not expose it on a non-loopback interface or
treat it as a boundary between plugins running in the same DSH process.

## Deployment requirements before unattended mode

- Run the dedicated DSH profile under a dedicated OS account or a container;
  do not run it as an operator account with personal credentials.
- Give the agent identity only the repository permissions needed for its work.
  Protect the default branch with required review and status checks; do not
  grant repository administration or bypass permissions.
- Keep secrets outside Ticket work directories. Prefer short-lived, narrowly
  scoped credentials or a credential broker over a long-lived token readable by
  the worker process.
- Load only reviewed, pinned DSH plugins. Treat plugin installation, update and
  preset changes as privileged operations requiring review.
- Start with `off` or `observe`; enable `auto` only after reviewing decisions
  and confirming the external GitHub controls.

## Security test plan

| Boundary | Required regression scenarios |
| --- | --- |
| Identity and admission | Same display name on another Source; unlisted human; unlisted/listed bot; disabled or missing Source; wrong repository; addressed vs. unaddressed event; `off`, `observe` and `auto` |
| Mandates and lifecycle | Policy revision between assessment and accept; requester removed; rule disabled; Source turned off; inferred Ticket resumed after `auto` is disabled; context-only Thread; duplicate event and restart |
| Untrusted content | Issue/PR body, review, attachment, skill or tool output contains instructions to change Policy, expose secrets, switch repositories or perform an unrelated action; no new authority or side effect is granted |
| DSH composition | Load the pinned DSH host with the bundle; verify expected plugin IDs, no duplicate/overriding tools, router/worker tool separation and role presets after create, restart and Session recovery; reject missing or incompatible required plugins |
| Process isolation | In a disposable OS account/container, attempt to read host credentials, write outside the work directory, escape via symlink/absolute path, use blocked commands through alternate paths, inherit Git environment overrides or reach unapproved network destinations |
| External actions | Attempt push to the default branch, force push, cross-repository API access, merge without required review, deploy and change repository settings; verify the credential scope or GitHub protection rejects each |
| Management API | Wrong Host/Origin, absent and forged headers, oversized/malformed body, stale revision, and requests from a separate local process; add authentication or process isolation if local callers are not trusted |
| Secret handling | Put sentinel secrets in environment values and command failures; assert they do not appear in worker environment, prompts, reports, HTTP errors or logs |

The current CI runs unit and scenario tests, a dependency audit and DSH bundle
contract tests against the installed Cordis/DSH libraries. It does not launch a
real DSH profile. A future host-integration job should use a disposable profile
and pinned DSH version; an OS-isolation job must run in a real container or
dedicated account. Do not give untrusted pull-request code production secrets
to run either job.
