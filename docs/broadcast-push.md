# Broadcast push — automatic APNs alerts to every iOS device

How a classified headline becomes a banner on every phone that granted
notification permission, and how to arm it without blasting the install base.

## Where it runs

**Railway, inside the existing `ais-relay` service. There is no cron and no new
service.**

`scripts/ais-relay.cjs` already classifies every ingested headline into
`critical / high / medium / low / info` and already applies the source-tier and
recency gates before publishing anything. The moment the level is known is the
moment the push should leave — a cron would poll for a fact the relay computed
synchronously and would add its whole interval to a breaking-news alert. The
relay is already long-running (`scripts/railway-services.json` → service
`ais-relay`), so the hook needs no scheduler, no container and no new Railway
project.

## The three push paths, and why this is a fourth

| Path | Audience | Transport | Trigger |
|---|---|---|---|
| Live Activity | devices with an ActivityKit token in Redis | `scripts/lib/apns-live-activity.cjs`, direct APNs | `liveActivityObserve()` on `critical` |
| PRO alert rules | signed-in PRO users with matching rules | `wm:events:queue` → `scripts/notification-relay.cjs` | `publishNotificationEvent()` |
| Web push | browsers with a VAPID subscription | Convex `notificationChannels` → relay | same queue |
| **Broadcast (this)** | **every registered iOS device, anonymous** | `pages/api/push/send.ts` → APNs | `broadcastPushObserve()` |

Broadcast is the only path with no per-user rules: it is the free-tier alert
every device opted into through the iOS permission prompt.

## Why it posts to Vercel instead of speaking APNs directly

Device tokens live in the MongoDB `devices` collection owned by
`monitor-landing-web`, which the relay holds no credentials for. Reusing
`pages/api/push/send.ts` keeps token storage, audience filtering and dead-token
pruning in one place. The relay decides *whether* and *what*; Vercel decides
*to whom*.

## Severity → audience

A device's stored `priority` is the **threshold its user picked**, not the
severity of an event. `NotificationService.swift` promises:

- `high` → "Only critical events — direct military strikes, major attacks"
- `medium` → "Significant developments and critical events"
- `low` → "All breaking news updates"

Inverting that gives the table in `scripts/lib/broadcast-push.cjs`:

| Event level | Device cohorts notified |
|---|---|
| `critical` | `high`, `medium`, `low` (everyone) |
| `high` | `medium`, `low` |
| `medium` | `low` |
| `low`, `info` | nobody |

**With the default `BROADCAST_PUSH_MIN_LEVEL=critical` this table does no
filtering.** Only critical events pass the floor, and critical reaches all three
cohorts, so a user who picked "critical only" and one who picked "all breaking
news" receive exactly the same pushes. Priority starts to differentiate only at
`BROADCAST_PUSH_MIN_LEVEL=high`.

The `medium` row is currently unreachable: both hook call sites in
`ais-relay.cjs` fire on `critical | high` only, inheriting the gate the queue
publish already used. Widening it means changing those two conditions.

Rows written before the app sent `priority` carry `null`, and a bare Mongo
`$in` never matches a null. `audience.includeUnsetPriority` folds them in
whenever the audience contains `medium` — the iOS default.

## Guards, all failing closed

`scripts/shared/notification-dedup.cjs` fails *open* because a missed per-user
alert is cheaper than a missed delivery. Broadcast inverts that: a duplicate
blast to the whole install base is the expensive outcome, so an unreachable
Redis **suppresses** the push.

1. **Arming** — off unless `BROADCAST_PUSH_ENABLED=1`.
2. **Dry-run** — on unless `BROADCAST_PUSH_DRY_RUN=0`. Vercel matches the
   audience and returns the count without sending.
3. **Level floor** — `BROADCAST_PUSH_MIN_LEVEL`, default `critical`.
4. **Source tier + recency** — same gates as the Live Activity hook.
5. **Dedup** — SHA-256 of the case- and punctuation-folded headline, 6h TTL.
   The level is not in the key, so a re-classification cannot earn a second push.
6. **Min gap** — 15 min between any two broadcasts, whatever the story.
7. **Hourly cap** — 4 per wall-clock hour, claimed as single-use `SET NX` slot
   keys (atomic and self-expiring; a counter would need a separate `EXPIRE`).

Guard order is cheapest-first so a duplicate never burns the gap window or a
slot a genuinely new story needs.

## Rollout

```bash
# 1. Arm in dry-run. Nothing is delivered; the log prints the matched count.
BROADCAST_PUSH_ENABLED=1
PUSH_ADMIN_SECRET=<the rotated secret>
# BROADCAST_PUSH_DRY_RUN defaults to on — do not set it yet.
```

Watch for `[BroadcastPush] DRY-RUN critical -> priority[high,medium,low] matched=N`.
`N` should track the size of the `devices` collection. Leave it a full news
cycle and check that the cadence looks sane — the min-gap and cap lines show up
as `suppressed` reasons.

```bash
# 2. Go live only once the dry-run counts and cadence look right.
BROADCAST_PUSH_DRY_RUN=0
```

To stop immediately, unset `BROADCAST_PUSH_ENABLED` and redeploy — or set
`BROADCAST_PUSH_DRY_RUN=1` to keep the telemetry without the delivery.

## Environment

| Var | Where | Default | Notes |
|---|---|---|---|
| `BROADCAST_PUSH_ENABLED` | Railway `ais-relay` | off | `1` to arm |
| `BROADCAST_PUSH_DRY_RUN` | Railway `ais-relay` | **on** | only the literal `0` sends |
| `PUSH_ADMIN_SECRET` | Railway **and** Vercel | — | must match on both sides |
| `BROADCAST_PUSH_BASE_URL` | Railway | `https://world-monitor-app.vercel.app` | must match `AppConfig.landingBaseURL` |
| `BROADCAST_PUSH_MIN_LEVEL` | Railway | `critical` | `high` roughly triples volume |
| `BROADCAST_PUSH_MIN_GAP_S` | Railway | `900` | |
| `BROADCAST_PUSH_HOURLY_CAP` | Railway | `4` | |
| `BROADCAST_PUSH_AUDIENCE_LIMIT` | Railway | `5000` | devices **per page**, not an audience cap |
| `BROADCAST_PUSH_MAX_PAGES` | Railway | `20` | runaway guard on the paging loop |
| `BROADCAST_PUSH_DEDUP_TTL_S` | Railway | `21600` | |
| `BROADCAST_PUSH_I18N` | Railway | off | reuses the Live Activity translator and its Redis cache |
| `BROADCAST_PUSH_LANGS` | Railway | — | comma list, only read when i18n is on |
| `APNS_ENVIRONMENT` | Railway | production | `sandbox` for TestFlight-built tokens |
| `APNS_P8` | Vercel | — | **required**; the fallback literal is gone, a missing var now throws |
| `APNS_TEAM_ID`, `APNS_KEY_ID` | Vercel | — | **required**; same, fallbacks removed |
| `PUSH_ADMIN_SECRET` | Vercel | — | **required**; without it the endpoint refuses everything |
| `APNS_TOPIC` | Vercel | `com.worldmonitor` | only if the bundle id differs |
| `APNS_ENV` | Vercel | production | opt IN with `sandbox`; defaulting to sandbox would prune every real token |

Removing the fallbacks means the first four are now hard requirements. If they
were never set in Vercel — the endpoint was running on the committed literals —
manual sends will start throwing until you add them.

## Send one test push by hand

`WorldView/push-examples.txt` has the full catalogue. The minimum:

```bash
curl -X POST "$LANDING_BASE_URL/api/push/send" \
  -H "Authorization: Bearer $PUSH_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "<64-hex apns token>",
    "alert": { "title": "World Alert", "body": "Test headline" },
    "route": { "type": "article", "url": "https://example.com", "title": "Test headline" },
    "sandbox": true,
    "dryRun": true
  }'
```

`dryRun` returns the matched count and the exact payload without sending. Drop
it to deliver. `sandbox` must be `true` for a token from a Xcode/TestFlight
build and `false` for App Store builds — a mismatch returns `BadDeviceToken`,
**and the endpoint then prunes that token as dead**.

## Paging: why the audience size is not bounded by Vercel

`pages/api/push/send.ts` is a serverless function with a hard wall-clock
ceiling. Throughput is `concurrency / RTT`, so the original 20 streams moved
only ~130 pushes a second at a 150ms round trip — roughly 7k devices inside a
60s budget, and past that the function was simply killed mid-fan-out: partial
delivery, no dead-token pruning, and no record of who had been reached.

Three changes remove that ceiling as a constraint:

1. **Concurrency 20 → 200** (`lib/apns.ts`). APNs advertises a high
   `SETTINGS_MAX_CONCURRENT_STREAMS` and Node queues the excess, so 20 was a
   client-side choice, not a protocol limit.
2. **Timeouts.** `sendOne` now cancels a stream after 10s and `http2.connect`
   after 10s. Without them a single hung stream retired one of the workers for
   the rest of the run — the relay's own sender has had this since it shipped;
   this file never got it.
3. **Cursor paging.** One call sends at most one page (5k devices). The response
   carries `nextCursor`, and `pageThrough()` in `scripts/lib/broadcast-push.cjs`
   loops until it comes back null. Every request is short; the relay, which has
   no time limit, owns the loop.

`sendApns` stops pulling new messages at a deadline set to
`maxDuration − requestTimeout − 20s`, so the handler always returns its own
result rather than being killed holding it. The `unsent` remainder is a
contiguous tail of the queue, which is what lets the resume cursor be "the last
device actually attempted" — never the last one fetched, since the gap between
those two is exactly the set that did not get the push.

Paging is by `_id` sort plus `$gt`, not `skip`/`offset`: a device that registers
mid-broadcast gets a higher ObjectId and lands on a later page instead of
shifting the window and causing a double send.

**Retry safety.** The dispatcher unwinds its dedup/gap/cap guards only when
*page 1 itself* failed — nothing went out, so a retry is safe. Once any page has
landed, the guards are kept and the run is reported as `PARTIAL`: re-running the
story would blast the already-notified devices a second time, which is worse
than dropping the tail.

## Known limits

- `BROADCAST_PUSH_MAX_PAGES` (default 20 × 5k = 100k devices) stops the paging
  loop. Hitting it logs a warning naming how many were reached and that the rest
  were not — silent truncation would read as full coverage.
- No quiet hours. `devices.timezone` is stored but the send endpoint does not
  filter on it, so a critical alert can arrive at 03:00 local. The PRO path has
  quiet-hours handling in `notification-relay.cjs`; this path does not.
- The banner word (`World Alert` / `Breaking News`) is an English literal.
  `apns-live-activity.cjs` documents why: a `title-loc-key` made APNs answer 200
  while iOS silently dropped the push. The headline itself can be translated via
  `BROADCAST_PUSH_I18N`.

## Tests

`tests/broadcast-push.test.mjs` — audience mapping, every guard's closed-failure
behaviour, the payload contract against `PushRoute.init?(userInfo:)`, the unwind
rules on transport failure, and the relay wiring.

```bash
node --test tests/broadcast-push.test.mjs
```

---

# AI World Brief push

Two notifications a day, in the reader's own morning and evening. Lives in
`scripts/lib/brief-push.cjs`, fires from the `seed-insights` Railway cron's
`afterPublish` hook.

| Slot | Local hour | Emoji | Framing |
|---|---|---|---|
| morning | 10:00 | 🌅 | what happened overnight |
| evening | 19:00 | 🌆 | where the world stands as the day closes |

## Local time without offset maths

Devices already store their IANA zone (`timezone: "Europe/Istanbul"`, written by
`NotificationService.registerDeviceWithBackend`). So the cron never computes an
offset: on each hourly run it asks which zones are AT the slot hour right now
and hands that list to the send endpoint as `audience.timezone`. Mongo does the
rest with a `$in`.

The hourly cron is what makes this work — every tick catches the next band of
zones rolling into 10:00 or 19:00. Roughly 2 of 24 ticks reach any given zone;
the rest are cheap no-ops.

**The slot matches on the HOUR, not hour+minute.** A UTC-aligned cron never
observes Asia/Kolkata (+5:30) or Asia/Kathmandu (+5:45) at exactly 10:00 — they
are at 10:30 and 10:45. Matching the hour is what includes them instead of
silently skipping every half-hour-offset country on earth. A test asserts the
24 hour-buckets *partition* the full 418-zone IANA table: no zone in two
buckets (two pushes a day) and none in zero (a silently skipped region).

Dedup is keyed per slot per UTC tick, not per day: each tick serves a different
band of zones, so a global daily key would let the first band through and starve
the other 23.

## Audience is `low` only

A brief has no severity — it is a schedule, not an event — so it goes solely to
the cohort whose Settings wording ("All breaking news updates") admits a digest.
`medium` and `high` both promise severity filtering a brief cannot satisfy, and
`includeUnsetPriority` is hard-coded false because unset means the iOS default
`medium`. Widening `BRIEF_PUSH_COHORTS` means changing what Settings promises.

## Copy

Ships translated, not LLM-generated. The title is the app's own `AI World Brief`
String Catalog entry verbatim — so the banner names the feature exactly as the
screen it opens does — prefixed with the slot emoji, which is also what tells
the two slots apart at a glance. Bodies are one fixed sentence per slot per
language.

Keyed by base language code: the device sends `languageCode` only, so "pt" and
"zh", never "pt-BR" or "zh-Hans". A test asserts every base language the app
ships has copy, and that the titles have not drifted from the String Catalog.

Route `{type:"brief"}` → PushRoute.brief → World Report with the brief open.
`collapseId: "brief-<slot>"` so an evening banner replaces an unread morning
one. APNs priority 5, not 10: a digest should not wake the device.

Fires only on outcome `PUBLISHED`. A `DEGRADED` run means synthesis failed, and
announcing a refresh that did not happen is worse than silence.

| Var | Where | Default | Notes |
|---|---|---|---|
| `BRIEF_PUSH_ENABLED` | Railway `seed-insights` | off | `1` to arm |
| `BRIEF_PUSH_DRY_RUN` | Railway `seed-insights` | **on** | only the literal `0` sends |
| `PUSH_ADMIN_SECRET` | Railway `seed-insights` | — | same value as Vercel |
| `BRIEF_PUSH_MORNING_HOUR` | Railway | `10` | local hour, clamped 0-23 |
| `BRIEF_PUSH_EVENING_HOUR` | Railway | `19` | local hour, clamped 0-23 |
| `BRIEF_PUSH_COHORTS` | Railway | `low` | widening changes what Settings promises |
| `BRIEF_PUSH_PAGE_SIZE` | Railway | `5000` | |
| `BRIEF_PUSH_MAX_PAGES` | Railway | `20` | |

Tests: `node --test tests/brief-push.test.mjs`.
