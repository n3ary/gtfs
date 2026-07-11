<!-- synced from n3ary/standards@da0a851 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Org automation: the release bot

The n3ary org runs an org-level GitHub App called **`n3ary-release-bot`** that bumps `package.json#version` on `main` after every merged PR. The bot is the canonical place for cross-cutting version management; per-consumer workflows do not implement version bumps.

## What the bot does

On every `pull_request: closed` event with `merged == true`, the bot:

1. Verifies the webhook signature.
2. Reads the repo's `package.json#version` on the current `main` tip.
3. Computes the next **CalVer** version: `YY.M.D-N` in `Europe/Bucharest` timezone, counter resets at day boundary, counter starts at `1`. See [version-management.md](version-management.md) for the format and the algorithm.
4. Checks whether the merge commit already changed the version (the `skip-if-already-touched` rule). If yes, the bot no-ops.
5. Writes the new version to `package.json` (and any sub-package `package.json`s — e.g. `libs/spec/`, `adapters/*/`).
6. Commits with `chore(release): <version>` and pushes the commit to `main`.

The bot is a Cloudflare Worker. Source: `n3ary/release-bot/src/`. Deploy: `wrangler deploy` from the repo root.

## What the bot does NOT do

- **Bump on the PR branch.** The PR branch is the dev's; the bot has no business there. The whole point of the bot is the bump happens on `main`, not on the PR.
- **Bump on a tag, on a schedule, or on `push` to `main` directly.** Those are anti-patterns. See [version-management.md](version-management.md).
- **Open a Release PR.** The bot pushes the bump commit directly to `main`. No human review of the version itself, because the version is mechanically derived from the merge timestamp — there's nothing to review.
- **Publish to npm, push a container image, or deploy.** Those are per-consumer workflows with repo-specific secrets. The bot is version-management only.
- **Resolve merge conflicts.** If the bot's push fails (e.g. main advanced under it), the bot retries with the latest `main` and re-computes. Bounded retries; after N failures it surfaces an alert.

## Where it lives

```
n3ary/release-bot/
├── app.yml                     # GitHub App manifest
├── src/
│   ├── index.ts                # Worker entry, route dispatch
│   ├── webhook.ts              # webhook signature verification, event handling
│   ├── bump.ts                 # CalVer arithmetic: nextCalVer(current, now, tz)
│   ├── commit.ts               # pushes the chore(release) commit via the GitHub API
│   ├── config.ts               # loads env (timezone, app ID, private key, webhook secret)
│   └── types.ts                # shared types
├── test/
│   └── bump.test.ts            # unit tests for the CalVer logic
├── wrangler.toml               # Cloudflare Worker config
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md                   # install + deploy + on-call runbook
```

The repo is public. The Cloudflare Worker secrets (app ID, app private key, webhook secret) are not in the repo; they are set via `wrangler secret put` during deploy.

## Install (one-time, on the n3ary org)

### 1. Register the GitHub App

The app is registered via a manifest-based flow:

1. Go to `https://github.com/organizations/n3ary/settings/apps/new` (or the equivalent for the org).
2. Paste the contents of `n3ary/release-bot/app.yml` as the manifest.
3. Confirm the app's name (`n3ary-release-bot`), webhook URL (the Cloudflare Worker URL), and events (`pull_request`, `push`).
4. GitHub creates the app and provides an **App ID** and a **private key** (PEM). Download the private key; it does not get shown again.

### 2. Set the Cloudflare Worker secrets

From the `n3ary/release-bot` repo root:

```bash
wrangler secret put GITHUB_APP_ID
# paste the App ID

wrangler secret put GITHUB_APP_PRIVATE_KEY
# paste the entire PEM, including the BEGIN/END lines

wrangler secret put GITHUB_WEBHOOK_SECRET
# paste a strong random string; same value goes into the app's "Webhook secret" field in the GH UI
```

### 3. Deploy the Worker

```bash
wrangler deploy
```

The Worker is now live at a `*.workers.dev` URL. Configure the GitHub App's webhook URL to that URL (append `/webhook`).

### 4. Install the app on the org

In the GitHub App settings, click "Install App" and select the n3ary org. Grant access to "All repositories" (or a specific subset if you want to limit the bot to certain repos).

### 5. Add the org-level branch protection bypass

In the org settings: Settings → Branches → Branch protection rules → edit the rule for `main` (or create one if it doesn't exist). Under "Allow specified actors to bypass required pull requests", add `n3ary-release-bot[bot]`. Save.

This single rule covers every repo in the org. The bot's `chore(release)` commits land on `main` directly, no PR required.

### 6. Remove the per-repo `github-actions[bot]` bypass (cleanup)

Before the bot was added, some repos had a per-repo bypass for `github-actions[bot]` to handle the `action_required` gate from the old auto-bump. That bypass is no longer needed. Walk each repo's branch protection settings and remove the `github-actions[bot]` entry. This cleanup is part of the consumer PR for each repo.

## How it works in detail

### Webhook handling

The Worker accepts `POST /webhook`. It:

1. Reads the `X-Hub-Signature-256` header.
2. Computes HMAC-SHA256 of the body with the webhook secret.
3. Compares the two with `crypto.timingSafeEqual`. Rejects on mismatch.
4. Parses the event.
5. For `pull_request` events with `action == "closed"` and `pull_request.merged == true`, dispatches to the bump logic. Otherwise returns 200 and does nothing.

### CalVer arithmetic

The core function is `nextCalVer(current, now, tz)` in `src/bump.ts`:

```typescript
export function nextCalVer(current: string, now: DateTime, tz: string): string {
  const today = now.setZone(tz);
  const todayStr = `${pad2(today.year % 100)}.${today.month}.${today.day}`;

  const parsed = parseCalVer(current);
  if (!parsed) {
    // Current version isn't CalVer (first time, or transitioning from semver).
    return `${todayStr}-1`;
  }

  const currentStr = `${pad2(parsed.year)}.${parsed.month}.${parsed.day}`;
  if (currentStr === todayStr) {
    return `${todayStr}-${parsed.counter + 1}`;
  }

  return `${todayStr}-1`;
}
```

`parseCalVer` accepts the format `YY.M.D-N` and returns `{year, month, day, counter}` or `null` if the string doesn't match. The `null` case (transitioning from semver, or a malformed version) falls back to `${today}-1`, which is the right behavior for the cutover.

### Idempotency (the `skip-if-already-touched` rule)

Before writing a new version, the bot reads the version at `HEAD~1` of `main` (the parent of the merge commit) and compares it to the version at `HEAD` (the merge commit's content). If they differ, the merge already changed the version — the dev's manual edit wins, the bot no-ops.

For multi-package repos, the check is per-`package.json` file. A dev who edits `libs/spec/package.json#version` does not affect the root `package.json#version`, so the root still gets its own bump.

### Pushing the commit

The bot uses the GitHub API (`PUT /repos/{owner}/{repo}/contents/{path}`) to update each `package.json`. The commit is auto-created by the API; the bot sets the commit author to the app's identity (`n3ary-release-bot[bot] <[email protected]>`) and the commit message to `chore(release): <version>`.

For multi-file bumps, the bot uses the Git Data API (`POST /repos/{owner}/{repo}/git/trees`, then `POST /repos/{owner}/{repo}/git/commits`, then `PATCH /repos/{owner}/{repo}/git/refs/heads/main`) to create a single commit that updates all `package.json` files atomically.

### Concurrency

Two PRs that merge in quick succession can fire two bot invocations. The Cloudflare Worker is stateless, so there's no built-in mutex. The bot's push is retried on `409 Conflict` (the "update was rejected because the tip of the ref advanced under you" error). On conflict, the bot re-fetches `main`, re-computes, retries. Bounded at 3 retries. After 3 failures, the bot surfaces an alert (TBD: which channel — for now, the Worker logs the failure and the next PR merge re-triggers the bump for the missed one).

## On-call runbook

When the bot fails:

1. Check the Cloudflare Worker logs: `wrangler tail` from the repo root. Look for the last 100 events.
2. If the failure is a GitHub API error (5xx), wait and retry. GitHub's API has transient failures.
3. If the failure is a `409 Conflict` after 3 retries, manually verify the state of `main`:
   ```bash
   gh api repos/n3ary/<repo>/contents/package.json --jq '.content' | base64 -d | jq .version
   ```
   If the version is stale (not the expected CalVer), trigger a manual bump:
   ```bash
   curl -X POST https://n3ary-release-bot.<account>.workers.dev/test/bump \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"owner":"n3ary","repo":"<repo>","ref":"main"}'
   ```
4. If the failure is repeated across multiple repos, check the bot's installation status in the GitHub UI. The app may have been suspended or its installation token may have expired.
5. If the failure is a Cloudflare Worker issue (Worker down, region outage), the version bumps are deferred. The next successful deploy re-triggers them via the next PR merge.

## Secret rotation

The bot has three secrets, all stored as Cloudflare Worker secrets:

- `GITHUB_APP_ID` — the app's numeric ID. Stable; rotate only if the app is recreated.
- `GITHUB_APP_PRIVATE_KEY` — the app's PEM private key. Rotate annually. The old key remains valid until you remove it from the GH UI; the new key works immediately. No downtime.
- `GITHUB_WEBHOOK_SECRET` — a strong random string used to sign webhooks. Rotate annually, or immediately if a leak is suspected. To rotate, set a new value via `wrangler secret put`, then update the app's "Webhook secret" in the GH UI to match.

After rotating any secret, verify with a test PR merge that the bot still fires.

## What this is NOT

- **Not release-please.** Google's release-please opens a Release PR with a CHANGELOG and a version bump; humans review the Release PR before merge. The n3ary bot pushes the version bump directly to `main` with no human review. The trade-off: less ceremony, no CHANGELOG. CalVer's "date is in the version" is the only human-readable signal needed.
- **Not semantic-release.** semantic-release analyzes commit messages to decide patch/minor/major. The n3ary bot uses CalVer + daily counter, with no commit-message parsing.
- **Not a generic CI runner.** The bot is version-management only. Builds, tests, deploys, and publishes are per-consumer workflows with repo-specific secrets.

## Related

- [version-management.md](version-management.md) — the rule the bot implements
- [workflow-naming.md](workflow-naming.md) — how the per-consumer workflows are named
- [workflow-conventions.md](workflow-conventions.md) — how the per-consumer workflows are structured
- `n3ary/release-bot/` — the bot's source code
