# Channel adapters

Channel adapters publish prepared posts (rows in `scheduled_posts` with `status = pending`) to external surfaces. The post-publisher (`orchestrator/post-publisher.ts`) picks up due rows on each daemon tick and dispatches each to the registered adapter for its channel.

## Adapter precedence

The post-scheduler service builds an adapter list with the file-stub catch-all first, then any real adapters with credentials present. `buildAdapterMap` (last-wins) means a real Facebook adapter overrides the stub for `facebook`, while channels without a real adapter fall through to the stub (which writes to `<dataDir>/sandbox/published-posts.jsonl` so the rest of the flow still validates end-to-end).

## Facebook setup

The Facebook adapter supports both **per-app credentials** (recommended for multi-project use — each app posts to its own Page) and a **legacy single-Page setup** (one Page across the whole portfolio).

### Per-app config (recommended)

Both the page id and the access token live in `<dataDir>/.env`; the brain holds only references (env-var names) to keep the data repo free of deploy-specific values.

**`<dataDir>/.env`** (gitignored — both page id and token live here):

```
FB_PAGE_ID_ERDEI=123456789012345
FB_TOKEN_ERDEI=EAAJ…

FB_PAGE_ID_KUNA=987654321098765
FB_TOKEN_KUNA=EAAJ…
```

**`<dataDir>/vaults/<vault>/brains/<app>/brain.json`** (in the data repo — only references):

```jsonc
{
  "schemaVersion": 1,
  "projectName": "erdei-fahazak",
  // ...
  "connections": {
    "facebook": {
      "pageIdEnvVar": "FB_PAGE_ID_ERDEI",
      "tokenEnvVar": "FB_TOKEN_ERDEI"
    }
  }
}
```

The two env-var names you choose (`FB_PAGE_ID_ERDEI`, `FB_TOKEN_ERDEI` here) are arbitrary — the only rules are that they're valid shell env-var names and that the same string appears in both `.env` and the brain's `*EnvVar` field. The daemon walks every onboarded brain at startup, instantiates one Facebook adapter per app whose connection is configured AND whose env vars resolve, and registers each as a per-app entry. Per-app entries win over the legacy fallback for the matching app; other apps fall through to the legacy fallback (or stub).

Why this shape:
- Both deploy-specific values colocated in `.env` — one place to edit when rotating credentials or moving environments.
- Brain stays in the data repo as project context: it documents that this app posts to a Facebook Page (and what env vars carry the values) without leaking any of the values themselves.
- No naming-convention coupling between app slugs and env-var names.
- New project? Add another connection block + another pair of env vars.

> **Back-compat:** an older shape with a literal `pageId` field in the brain (`{ "pageId": "123…", "tokenEnvVar": "FB_TOKEN_ERDEI" }`) is still accepted — only `tokenEnvVar` was required to be in `.env`. Migrate to `pageIdEnvVar` when convenient. When both `pageIdEnvVar` and `pageId` are present, `pageIdEnvVar` wins.

### Legacy single-Page setup (back-compat with PR #61)

If you have a single Page across all apps, the older env vars still work as a fallback for any app without a per-app brain config:

```
FB_PAGE_ID=123456789012345
FB_PAGE_ACCESS_TOKEN=EAAJ…
```

Per-app brain configs override this fallback for their matching app.

### Generating a Page Access Token

The simplest path (one-time, ~10 minutes):

1. Create a Meta Developer app at <https://developers.facebook.com/apps>. Pick "Other" as the app type.
2. Add the **Facebook Login** product. Under Settings → Basic, copy your App ID and App Secret if you plan to script the long-lived exchange — otherwise Graph API Explorer can do it for you.
3. Open <https://developers.facebook.com/tools/explorer/>. Pick your app from the dropdown.
4. Click "Get User Access Token". In the permission picker, request:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
5. Hit "Generate Access Token", approve in the popup. You now have a short-lived (1h) **User Access Token**.
6. Click the blue "i" icon next to the token → "Open in Access Token Tool". Confirm scopes; "Extend Access Token" → that gives you a ~60-day **long-lived User Token**.
7. Back in the Graph API Explorer, query `GET /me/accounts` with the long-lived User Token. The response lists each Page you manage with a per-Page `access_token`. **Copy the token for the Page Jarvis should post to** — that's the Page Access Token. (Per-Page tokens derived from a long-lived User Token don't expire.)
8. Find the Page id in the same response or via your Page's About → Page Transparency.
9. Drop both into `<dataDir>/.env`:
   ```
   FB_PAGE_ID=...
   FB_PAGE_ACCESS_TOKEN=...
   ```
10. Restart the daemon (`yarn jarvis daemon`). The startup log line `post-scheduler: adapter coverage` should list `facebook` among the channels.

### Smoke test

```
yarn jarvis plan --app <app> --type marketing --subtype single-post "test post — please ignore"
yarn jarvis approve <plan-id>
yarn jarvis marketer prepare <plan-id>
yarn jarvis posts approve <post-id>
yarn jarvis posts publish-due
```

If the post lands on the Page, verify `posts list --status published` shows the FB-side `published_id`.

### What v1 supports

The adapter routes by asset list:

| `Assets:` | Endpoint | Body fields | Use when |
|-----------|----------|-------------|----------|
| empty | `POST /{page-id}/feed` | `message` | text-only post |
| 1 image URL | `POST /{page-id}/photos` | `url`, `caption` | single image (`.jpg`/`.jpeg`/`.png`/`.gif`/`.webp`) |
| 1 video URL | `POST /{page-id}/videos` | `file_url`, `description` | single video (`.mp4`/`.mov`/`.webm`/`.m4v`) |
| 1 unknown URL | `POST /{page-id}/photos` | `url`, `caption` | URL with no recognized extension — defaults to image |

Asset values must be HTTP(S) URLs (the adapter doesn't host or upload binaries). Marketer's content-calendar parser accepts them as-is from the plan.

### What v1 does NOT support yet

- **Multi-image posts** (`Assets:` with more than one entry). The `attached_media` flow uploads each photo with `published=false`, then attaches them to a single feed post. Lands in a follow-up.
- **Multipart upload of local files**. Today the asset must be a URL the FB Graph API can fetch — local file paths fail loud with an explanatory reason.
- **Token rotation**. When the Page Access Token eventually expires, the adapter starts returning 4xx; you regenerate and replace it.
- **Webhook ingestion** (comments, replies, engagement metrics). The Analyst track will absorb that signal once it lands.

## Instagram setup (not yet implemented)

The IG Graph API publish flow (container creation → publish → metrics) lands in a follow-up.

## File-stub adapter

`tools/channels/file-stub.ts` is the catch-all stub. Every "publish" appends one JSONL line to `<dataDir>/sandbox/published-posts.jsonl`. Used end-to-end in tests and as the fallback for channels with no real adapter wired.
