# Channel adapters

Channel adapters publish prepared posts (rows in `scheduled_posts` with `status = pending`) to external surfaces. The post-publisher (`orchestrator/post-publisher.ts`) picks up due rows on each daemon tick and dispatches each to the registered adapter for its channel.

## Adapter precedence

The post-scheduler service builds an adapter list with the file-stub catch-all first, then any real adapters with credentials present. `buildAdapterMap` (last-wins) means a real Facebook adapter overrides the stub for `facebook`, while channels without a real adapter fall through to the stub (which writes to `<dataDir>/sandbox/published-posts.jsonl` so the rest of the flow still validates end-to-end).

## Facebook setup

Two env vars in `<dataDir>/.env`:

```
FB_PAGE_ID=123456789012345
FB_PAGE_ACCESS_TOKEN=EAAJ…
```

Both must be present for the adapter to register. Otherwise the daemon falls back to the file-stub for `facebook` posts and the start-up log shows the channels it covers.

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

- Text-only posts via `POST /{page-id}/feed`.

### What v1 does NOT support yet

- **Image / video uploads**. Posts with non-empty `Assets:` rows get returned as `ok: false` with an explanatory reason — the row goes to `failed` until the assets-upload follow-up ships.
- **Token rotation**. When the Page Access Token eventually expires, the adapter starts returning 4xx; you regenerate and replace it.
- **Webhook ingestion** (comments, replies, engagement metrics). The Analyst track will absorb that signal once it lands.

## Instagram setup (not yet implemented)

The IG Graph API publish flow (container creation → publish → metrics) lands in a follow-up.

## File-stub adapter

`tools/channels/file-stub.ts` is the catch-all stub. Every "publish" appends one JSONL line to `<dataDir>/sandbox/published-posts.jsonl`. Used end-to-end in tests and as the fallback for channels with no real adapter wired.
