# MailSniff

> Sniff out disposable emails.

[![npm version](https://img.shields.io/npm/v/mailsniff)](https://www.npmjs.com/package/mailsniff)
[![npm downloads](https://img.shields.io/npm/dm/mailsniff)](https://www.npmjs.com/package/mailsniff)
[![Node.js version](https://img.shields.io/node/v/mailsniff)](https://nodejs.org)
[![License: CC0-1.0](https://img.shields.io/npm/l/mailsniff)](./LICENSE)
[![CI](https://github.com/last-stand/mailsniff/actions/workflows/ci.yml/badge.svg)](https://github.com/last-stand/mailsniff/actions/workflows/ci.yml)

MailSniff detects disposable and temporary email addresses (Mailinator-style throwaway inboxes) so you can block them during signup and email validation. It uses the community-maintained [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) blocklist, keeps it fresh, and lets you add your own domains. It ships with TypeScript types, works with ESM and CommonJS, and needs no infrastructure (Redis is optional).

```bash
npm install mailsniff
```

```js
import { isDisposableEmail } from 'mailsniff';

await isDisposableEmail('someone@mailinator.com'); // true
await isDisposableEmail('someone@gmail.com'); // false
```

## Table of contents

- [Key features](#key-features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [Two ways to use it](#two-ways-to-use-it)
  - [Configuration options](#configuration-options)
  - [`isDisposableEmail`](#isdisposableemail)
  - [`isDisposableDomain`](#isdisposabledomain)
  - [`listDisposableDomains`](#listdisposabledomains)
  - [`addDisposableDomains`](#adddisposabledomains)
  - [`removeDisposableDomains`](#removedisposabledomains)
  - [`refresh`](#refresh)
  - [`clearCache`](#clearcache)
  - [`init`](#init)
  - [`status`](#status)
  - [`close`](#close)
  - [`configure`](#configure)
  - [`createMailSniff`](#createmailsniff)
- [Signup integration example](#signup-integration-example)
- [Custom disposable domains](#custom-disposable-domains)
- [Dataset and automatic refresh](#dataset-and-automatic-refresh)
- [Caching](#caching)
- [TypeScript support](#typescript-support)
- [API reference](#api-reference)
- [Error handling and troubleshooting](#error-handling-and-troubleshooting)
- [Performance and best practices](#performance-and-best-practices)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License and attribution](#license-and-attribution)

## Key features

- **Email and domain detection** with `isDisposableEmail()` and `isDisposableDomain()`.
- **Community-maintained dataset**, downloaded from the project's raw GitHub URL. Nothing is bundled in the package.
- **Subdomain matching**: `user@a.mailinator.com` matches `mailinator.com` (can be turned off).
- **Fast lookups**: after initialization, every lookup runs against an in-process `Set`. No network and no Redis round trip per check.
- **In-memory cache by default**, **optional Redis** cache that is shared and persisted across instances and restarts.
- **Custom domains**: add and remove your own. They are never overwritten by a dataset refresh.
- **Automatic refresh** (opt-in) and manual `refresh()`, with ETag conditional requests, dataset validation, and a fallback to the previous data on failure.
- **Safe for fleets**: instances sharing Redis coordinate through a lock instead of all downloading at once.
- **TypeScript types included**, ESM and CommonJS builds, zero runtime dependencies.

## Installation

Requires **Node.js 18 or newer**.

```bash
npm install mailsniff
```

```bash
pnpm add mailsniff
```

```bash
yarn add mailsniff
```

Redis support is optional. Only if you want it, also install [`ioredis`](https://github.com/redis/ioredis) (version 5 or newer):

```bash
npm install ioredis
```

## Quick start

No setup is needed. The first call connects the cache and loads the dataset automatically.

**ESM**

```js
import { isDisposableDomain, isDisposableEmail } from 'mailsniff';

console.log(await isDisposableEmail('someone@mailinator.com')); // true
console.log(await isDisposableEmail('Someone@Gmail.com')); // false
console.log(await isDisposableDomain('guerrillamail.com')); // true
console.log(await isDisposableDomain('sub.mailinator.com')); // true (subdomain match)
```

**CommonJS**

```js
const { isDisposableDomain, isDisposableEmail } = require('mailsniff');

async function main() {
  console.log(await isDisposableEmail('someone@mailinator.com')); // true
  console.log(await isDisposableDomain('gmail.com')); // false
}

main().catch(console.error);
```

All lookups are asynchronous because the first one may need to load the dataset. After that they resolve without any I/O.

If you want to load the dataset at application start instead of on the first request, call [`init()`](#init) once during startup.

## Usage

### Two ways to use it

| Style                                                                      | When to use it                                                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Top-level functions** (`isDisposableEmail`, `addDisposableDomains`, ...) | Simple apps. They share one lazily created default instance. Configure it once with [`configure()`](#configure).                                   |
| **Instances** via [`createMailSniff()`](#createmailsniff)                  | Apps that want explicit lifecycle control, several configurations, or easier testing. An instance has the same methods as the top-level functions. |

Every example below uses the top-level functions. Each one is also available as a method on an instance, with the same signature.

### Configuration options

Passed to [`configure()`](#configure) or [`createMailSniff()`](#createmailsniff). Every option is optional.

| Option               | Type                     | Default                         | Description                                                                                                                                      |
| -------------------- | ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `redis`              | `RedisConfig`            | none (in-memory)                | Use Redis as the cache backend. See [Redis cache](#redis-cache).                                                                                 |
| `refreshInterval`    | `Interval`               | disabled                        | Refresh the community list automatically. `number` (milliseconds) or a string like `'30m'`, `'12h'`, `'1d'`. Allowed range: 1 minute to 24 days. |
| `matchSubdomains`    | `boolean`                | `true`                          | Also match subdomains of listed domains.                                                                                                         |
| `failOnInitError`    | `boolean`                | `false`                         | Make `init()` reject when startup fails, instead of running in a degraded state.                                                                 |
| `onError`            | `(error: Error) => void` | no-op                           | Receives non-fatal errors (failed downloads, Redis outages). Exceptions thrown by this callback are ignored.                                     |
| `dataset.sourceUrl`  | `string`                 | the project's raw blocklist URL | Where to download the list from (`http:` or `https:`).                                                                                           |
| `dataset.timeoutMs`  | `number`                 | `10000`                         | Download timeout.                                                                                                                                |
| `dataset.maxBytes`   | `number`                 | `2097152` (2 MiB)               | Maximum response size.                                                                                                                           |
| `dataset.minDomains` | `number`                 | `500`                           | A download with fewer valid domains is rejected.                                                                                                 |
| `dataset.fetch`      | `FetchLike`              | global `fetch`                  | Custom fetch implementation, for example to use a proxy.                                                                                         |
| `cache`              | `DomainCache`            | none                            | Advanced: bring your own storage backend. Cannot be combined with `redis`.                                                                       |

Invalid options throw a `ConfigError` immediately.

### `isDisposableEmail`

Checks whether an email address belongs to a disposable provider.

```ts
isDisposableEmail(email: string): Promise<boolean>
```

- **Asynchronous.** Resolves `true` when the address's domain (or a parent domain) is in the community list or your custom domains.
- The address is trimmed and the domain is lowercased. The check uses the part after the last `@`.
- Malformed addresses (no `@`, empty local part, whitespace, local part over 64 characters, address over 254 characters, single-label domains such as `user@localhost`) resolve `false`. MailSniff is not an email syntax validator.
- Throws a `TypeError` when `email` is not a string. Rejects with `ClosedError` on an instance that was closed.

```js
import { isDisposableEmail } from 'mailsniff';

await isDisposableEmail('user@mailinator.com'); // true
await isDisposableEmail(' User+tag@MAILINATOR.com '); // true
await isDisposableEmail('user@sub.mailinator.com'); // true
await isDisposableEmail('user@gmail.com'); // false
await isDisposableEmail('not an email'); // false
```

### `isDisposableDomain`

Checks whether a domain is disposable.

```ts
isDisposableDomain(domain: string): Promise<boolean>
```

- **Asynchronous.** The domain is trimmed, lowercased, and a single trailing dot is removed. Internationalized names are converted to punycode.
- Invalid domains (empty, a single label such as `localhost`, containing a path, port, `@`, wildcard or underscore, an IP address) resolve `false`.
- Throws a `TypeError` when `domain` is not a string.

```js
import { isDisposableDomain } from 'mailsniff';

await isDisposableDomain('mailinator.com'); // true
await isDisposableDomain('MAILINATOR.com.'); // true
await isDisposableDomain('a.b.mailinator.com'); // true (subdomain)
await isDisposableDomain('example.org'); // false
await isDisposableDomain('http://mailinator.com'); // false (not a bare domain)
```

### `listDisposableDomains`

Returns the combined community and custom list.

```ts
listDisposableDomains(): Promise<string[]>
```

- **Asynchronous.** The result is sorted and de-duplicated. It is a copy, so changing it has no effect on MailSniff.
- It lists entries only. Subdomains are matched at lookup time and are not listed.

```js
import { addDisposableDomains, listDisposableDomains } from 'mailsniff';

await addDisposableDomains(['mine.example']);
const domains = await listDisposableDomains();
console.log(domains.includes('mine.example')); // true
console.log(domains.length > 1000); // true with the real dataset
```

### `addDisposableDomains`

Adds your own disposable domains. See [Custom disposable domains](#custom-disposable-domains).

```ts
addDisposableDomains(domains: string | readonly string[]): Promise<void>
```

- **Asynchronous.** Accepts one domain or an array. Every entry is normalized, and duplicates are ignored.
- **All-or-nothing:** if any entry is invalid, nothing is added and a `ValidationError` is thrown. Its `invalid` property lists every rejected entry.
- An empty array is a no-op.
- Throws a `TypeError` when the argument is neither a string nor an array.
- Rejects with `CacheError` when the cache backend (Redis) rejects the write. Nothing is changed locally in that case.

```js
import { ValidationError, addDisposableDomains } from 'mailsniff';

await addDisposableDomains(['Temp-Mail.Example', 'burner.example']);
await addDisposableDomains('another.example');

try {
  await addDisposableDomains(['ok.example', 'not a domain']);
} catch (error) {
  if (error instanceof ValidationError) {
    console.log(error.invalid); // ['not a domain']
  }
}
```

### `removeDisposableDomains`

Removes custom domains that you added earlier.

```ts
removeDisposableDomains(domains: string | readonly string[]): Promise<void>
```

- **Asynchronous.** Same input rules and errors as `addDisposableDomains`.
- Only custom domains are removed. Names that belong to the community list stay detected. Unknown entries are ignored.

```js
import { addDisposableDomains, isDisposableDomain, removeDisposableDomains } from 'mailsniff';

await addDisposableDomains('typo.example');
await removeDisposableDomains('typo.example');
await isDisposableDomain('typo.example'); // false
```

### `refresh`

Downloads the community list now, regardless of the schedule.

```ts
refresh(): Promise<RefreshResult>
```

- **Asynchronous.** Concurrent calls share one download. Instances sharing Redis coordinate through a lock.
- Operational failures (network, invalid dataset, cache outage) are **not thrown**. They are returned as `status: 'failed'` and reported to `onError`, and the previous data keeps being served.
- Rejects with `ClosedError` after `close()`, and with `ConfigError` for configuration problems found during initialization.

```ts
interface RefreshResult {
  status: 'updated' | 'not-modified' | 'synced' | 'failed';
  communityCount: number;
  fetchedAt: number | null; // epoch milliseconds of the list being served
  error?: Error;
}
```

| `status`       | Meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `updated`      | A new list was downloaded, validated and is now served.                                                                     |
| `not-modified` | The source has not changed (HTTP 304). The freshness timestamp was renewed.                                                 |
| `synced`       | No download was needed here. Data came from the shared cache (another instance refreshed it or is refreshing it right now). |
| `failed`       | The refresh failed. See `error`. The previous data is still served.                                                         |

```js
import { refresh } from 'mailsniff';

const result = await refresh();
if (result.status === 'failed') {
  console.error('Refresh failed, still using the previous list:', result.error);
} else {
  console.log(`${result.status}: ${result.communityCount} domains`);
}
```

### `clearCache`

Clears the stored community list, then downloads it again.

```ts
clearCache(options?: { includeCustom?: boolean }): Promise<void>
```

- **Asynchronous.** By default custom domains are kept. Pass `{ includeCustom: true }` to delete them as well (with Redis, they are deleted for every instance).
- A failed re-download is reported through `onError`. The community list then stays empty until the next successful refresh.
- Rejects with `CacheError` when the backend cannot be cleared. Nothing is changed locally in that case.

```js
import { clearCache } from 'mailsniff';

await clearCache(); // community list only
await clearCache({ includeCustom: true }); // everything
```

### `init`

Connects the cache and loads the dataset.

```ts
init(): Promise<void>
```

- **Asynchronous and optional.** Every other function calls it automatically on first use. Call it yourself to warm up at application start. Calling it again is harmless.
- Resolves even when GitHub or Redis is unreachable. MailSniff then runs in a `degraded` state (see [Error handling](#error-handling-and-troubleshooting)). With `failOnInitError: true` it rejects instead.
- Always rejects with `ConfigError` for configuration problems, such as `ioredis` not being installed when Redis is configured.
- Starts the automatic refresh schedule when `refreshInterval` is set.

```js
import { init, status } from 'mailsniff';

await init();
console.log(status().state); // 'ready'
```

### `status`

Returns a snapshot of the instance's health.

```ts
status(): MailSniffStatus
```

- **Synchronous.** Never throws.

```ts
interface MailSniffStatus {
  state: 'uninitialized' | 'initializing' | 'ready' | 'degraded' | 'closed';
  backend: string; // 'memory' or 'redis'
  cacheHealthy: boolean;
  communityCount: number;
  customCount: number;
  communityFetchedAt: number | null; // epoch ms of the loaded list
  autoRefresh: boolean; // whether refreshInterval is configured
  nextRefreshAt: number | null; // epoch ms, null when none is pending or one is running
  lastError: Error | null;
}
```

`degraded` means the community list is empty or the cache backend is unhealthy. Lookups still work in that state. Use `status()` for health checks and monitoring.

```js
import { status } from 'mailsniff';

console.log(status());
// { state: 'ready', backend: 'memory', cacheHealthy: true, communityCount: 4000+, customCount: 0, ... }
```

### `close`

Releases resources.

```ts
close(): Promise<void>
```

- **Asynchronous and idempotent.** Stops the refresh schedule, waits for in-flight work, and closes the cache.
- A Redis client that MailSniff created (from `redis.url`) is closed. A client you passed in (`redis.client`) is **left open**.
- On an instance, every later call rejects with `ClosedError`. On the default instance, `close()` resets it, so a later call creates a fresh one (or call `configure()` first).

```js
import { close } from 'mailsniff';

process.on('SIGTERM', async () => {
  await close();
  process.exit(0);
});
```

### `configure`

Sets the options of the default instance.

```ts
configure(options: MailSniffOptions): void
```

- **Synchronous.** Call it once at startup, **before any other top-level function**, or again after `close()`.
- Throws `ConfigError` for invalid options, and also when the default instance is already in use. Note that even `status()` creates the default instance, so call `configure()` first.
- Nothing is downloaded or connected until the first lookup or `init()`.

```js
import { configure, init } from 'mailsniff';

configure({
  refreshInterval: '1d',
  onError: (error) => console.error('[mailsniff]', error.message),
});
await init();
```

### `createMailSniff`

Creates an independent instance with its own configuration and cache.

```ts
createMailSniff(options?: MailSniffOptions): MailSniff
```

- **Synchronous.** Throws `ConfigError` for invalid options. Nothing is downloaded or connected yet.
- The returned `MailSniff` has these methods: `init`, `isDisposableEmail`, `isDisposableDomain`, `listDisposableDomains`, `addDisposableDomains`, `removeDisposableDomains`, `refresh`, `clearCache`, `status`, `close`. They behave exactly as documented above.
- You are responsible for calling `close()` on instances you create.

```js
import { createMailSniff } from 'mailsniff';

const mailsniff = createMailSniff({ refreshInterval: '1d' });
await mailsniff.init();

await mailsniff.isDisposableEmail('x@mailinator.com'); // true

await mailsniff.close();
```

## Signup integration example

An Express endpoint that rejects disposable addresses. Express is only an example: MailSniff has no framework dependency.

```js
import express from 'express';
import { createMailSniff } from 'mailsniff';

const app = express();
app.use(express.json());

// Create one instance for the whole application and reuse it.
const mailsniff = createMailSniff({
  refreshInterval: '1d',
  onError: (error) => console.error('[mailsniff]', error),
});
await mailsniff.init(); // optional warm-up: the first signup will not wait for the download

// MailSniff is not a syntax validator, so keep your normal email validation.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/signup', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

    // 1. Normal syntax validation.
    if (!EMAIL_PATTERN.test(email)) {
      return res
        .status(400)
        .json({ error: 'invalid_email', message: 'Enter a valid email address.' });
    }

    // 2. Disposable address check.
    if (await mailsniff.isDisposableEmail(email)) {
      return res.status(422).json({
        error: 'disposable_email',
        message: 'Disposable email addresses are not allowed. Please use a permanent address.',
      });
    }

    // 3. Continue the normal registration flow:
    //    create the account, then send a verification email.
    return res.status(201).json({ message: 'Check your inbox to confirm your address.' });
  } catch (error) {
    return next(error);
  }
});

const server = app.listen(3000);

process.on('SIGTERM', async () => {
  server.close();
  await mailsniff.close();
});
```

MailSniff only tells you whether the **domain** is known to offer disposable inboxes. It does not check that the address is well-formed, that it exists, or that the user owns it. Keep sending a verification email for every signup.

## Custom disposable domains

Use `addDisposableDomains()` for domains that are missing from the community list, such as providers abusing your service.

```js
import { addDisposableDomains, isDisposableEmail } from 'mailsniff';

await addDisposableDomains(['burner.example', 'Throwaway.Example']);

await isDisposableEmail('me@burner.example'); // true
await isDisposableEmail('me@mail.throwaway.example'); // true (subdomains match by default)
```

| Topic                       | Behavior                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input**                   | A string or an array of strings. Plain domain names only: no `@`, scheme, path, port or wildcard (`*.example.com` is rejected). Add `example.com` to cover its subdomains as well. |
| **Normalization**           | Trimmed, lowercased, one trailing dot removed, internationalized names converted to punycode.                                                                                      |
| **Validation**              | At least two labels, labels of 1 to 63 characters (letters, digits, hyphens), not an IP address, at most 253 characters.                                                           |
| **Invalid input**           | The whole call fails with a `ValidationError` (its `invalid` property lists every bad entry) and nothing is added.                                                                 |
| **Duplicates**              | Ignored, including duplicates of community domains. `listDisposableDomains()` returns each name once.                                                                              |
| **Dataset refresh**         | Custom domains are stored separately and are **never overwritten** by a refresh.                                                                                                   |
| **Removal**                 | `removeDisposableDomains()` removes custom domains only.                                                                                                                           |
| **Persistence (in-memory)** | Last for the lifetime of the process and are lost on restart. Add them again at startup.                                                                                           |
| **Persistence (Redis)**     | Stored in Redis, so they survive restarts and are shared by every instance using the same `keyPrefix`.                                                                             |

With the in-memory cache, re-add your domains at every startup:

```js
import { addDisposableDomains, configure } from 'mailsniff';

configure({ refreshInterval: '1d' });
await addDisposableDomains(['burner.example']); // runs on every start
```

## Dataset and automatic refresh

**Source.** The list comes from the community-maintained [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) project. MailSniff downloads this raw file and does not bundle a copy:

```text
https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf
```

You can point `dataset.sourceUrl` at a mirror of the same one-domain-per-line format.

**Initial load.** The first call (or `init()`) works in this order:

1. Connect the cache backend.
2. Load a stored snapshot from the cache, if there is one. With Redis, a restarted instance starts from here without downloading.
3. Download the list only if nothing was loaded.

**Validation.** A download is used only if it passes all of these checks. Otherwise the previous data stays active:

- response size at most `dataset.maxBytes` (2 MiB by default) and received within `dataset.timeoutMs` (10 s)
- at most 1% of lines are not valid domains (comments and blank lines are ignored)
- at least `dataset.minDomains` valid domains (500 by default)
- not smaller than 50% of the list currently served

**Efficient updates.** MailSniff stores the ETag and sends `If-None-Match`. When the source has not changed, nothing is re-parsed.

**Automatic refresh** is **off by default**. Enable it with `refreshInterval`:

```js
import { configure } from 'mailsniff';

configure({ refreshInterval: '1d' }); // '30m', '12h', '1d', '7d' ... or milliseconds
```

| Detail                | Value                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Formats               | A number of milliseconds, or a string `<integer><unit>` with unit `m`, `h` or `d`               |
| Allowed range         | 1 minute to 24 days. Anything else throws a `ConfigError`                                       |
| Default               | Disabled                                                                                        |
| First run             | When the loaded list is `refreshInterval` old. Immediately after startup if it is already older |
| Timing                | Each delay varies by ±10% so instances do not wake up together                                  |
| Retry after a failure | Starts at 1 minute and doubles, never longer than the interval                                  |
| Process lifetime      | The timer is unref'd, so it never keeps your process alive. `close()` stops it                  |

**When a refresh fails**, the instance keeps serving the previous list (including a list loaded from the cache after a restart). The error goes to `onError` and `status().lastError`, and the refresh is retried with backoff. Detection is never interrupted. A manual `refresh()` reports the same failure as `{ status: 'failed', error }`.

**Custom domains** live separately from the community list and are never touched by a refresh.

**No timer in short-lived processes.** In serverless functions or cron jobs, leave `refreshInterval` unset and call `refresh()` yourself when it makes sense.

## Caching

MailSniff keeps the active list in an in-process `Set` and uses a cache backend to store, share and persist data. The public API is identical for both backends.

|                    | In-memory (default)         | Redis (optional)                                 |
| ------------------ | --------------------------- | ------------------------------------------------ |
| Setup              | None                        | Install `ioredis`, set `redis` option            |
| Lookups            | In-process                  | In-process (Redis is **not** queried per lookup) |
| Community list     | Downloaded by every process | Downloaded once, shared by all instances         |
| Custom domains     | Lost on restart             | Persisted and shared                             |
| Restart            | Downloads again             | Starts from the stored snapshot                  |
| Multiple instances | Independent                 | Coordinated with a refresh lock                  |

### In-memory cache

Used automatically when `redis` is not configured. No infrastructure is required. Everything is lost when the process exits, so each process downloads the dataset once at startup.

### Redis cache

1. Install the optional dependency: `npm install ioredis`.
2. Pass either a connection URL or your own client:

```js
import { createMailSniff } from 'mailsniff';

const mailsniff = createMailSniff({
  redis: { url: process.env.REDIS_URL }, // redis:// or rediss://
  refreshInterval: '1d',
  onError: (error) => console.error('[mailsniff]', error.message),
});

await mailsniff.init();
```

Or reuse an existing `ioredis` client:

```js
import { Redis } from 'ioredis';
import { createMailSniff } from 'mailsniff';

const client = new Redis(process.env.REDIS_URL);
const mailsniff = createMailSniff({ redis: { client, keyPrefix: 'myapp:mailsniff' } });
```

| `redis` option | Description                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `url`          | Connection URL (`redis://` or `rediss://`). MailSniff creates the client, and `close()` closes it. |
| `client`       | Your own client. MailSniff uses it but **never closes it**.                                        |
| `keyPrefix`    | Prefix for all keys. Default: `mailsniff:v1`.                                                      |

Provide exactly one of `url` or `client`. If `REDIS_URL` is not set, `{ url: undefined }` throws a `ConfigError` instead of silently falling back to memory.

**What is stored** (keys start with `keyPrefix`):

| Key suffix   | Type   | Content                                                                              |
| ------------ | ------ | ------------------------------------------------------------------------------------ |
| `:community` | hash   | Community list, ETag and download time, written atomically                           |
| `:custom`    | set    | Your custom domains                                                                  |
| `:version`   | string | Counter that changes on every write (used to detect changes made by other instances) |
| `:lock`      | string | Refresh lock                                                                         |

**Sharing between instances.** Application instances using the same Redis and `keyPrefix` share the list and the custom domains. Only one instance downloads at a time: the others adopt its result. A background check (at most every 30 seconds, started by a lookup, never blocking it) picks up changes made by other instances.

**Redis outages.** Lookups keep working from the in-process list. `addDisposableDomains()`, `removeDisposableDomains()` and `clearCache()` reject with `CacheError` and change nothing locally. The client reconnects on its own, and the next background check reloads the shared data. `status().cacheHealthy` reports the connection state.

**Lifecycle.** Call `close()` on shutdown. With `redis.url` it closes the connection it opened. With `redis.client` you close your own client.

**Custom backends.** The `cache` option accepts any object implementing the exported `DomainCache` interface. This is an advanced extension point, not needed for normal use.

## TypeScript support

Type declarations are included in the package, for both ESM and CommonJS. No `@types/*` package is needed.

```ts
import {
  ValidationError,
  createMailSniff,
  type MailSniff,
  type MailSniffOptions,
  type RefreshResult,
} from 'mailsniff';

const options: MailSniffOptions = {
  refreshInterval: '12h',
  redis: { url: process.env.REDIS_URL },
  onError: (error: Error) => console.error(error),
};

const mailsniff: MailSniff = createMailSniff(options);

async function checkSignup(email: string): Promise<boolean> {
  return !(await mailsniff.isDisposableEmail(email));
}

async function addBlockedDomains(domains: string[]): Promise<void> {
  try {
    await mailsniff.addDisposableDomains(domains);
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error('Rejected:', error.invalid);
      return;
    }
    throw error;
  }
}

const result: RefreshResult = await mailsniff.refresh();
```

**Exported types:** `MailSniff` (class), `MailSniffOptions`, `RedisConfig`, `DatasetOptions`, `Interval`, `ClearCacheOptions`, `RefreshResult`, `RefreshStatus`, `MailSniffStatus`, `MailSniffState`, `MailSniffErrorCode`, `FetchLike`, `ResponseLike`, `RedisClientLike`, `RedisPipelineLike`, `DomainCache`, `CommunitySnapshot`, `RefreshLock`.

**Module formats:** the package has an `exports` map. `import` resolves to the ES module build and `require` to the CommonJS build, each with matching type declarations.

`Interval` is typed as `` number | `${number}${'m' | 'h' | 'd'}` ``. The type also admits strings such as `'1.5h'`, which are rejected at runtime with a `ConfigError`. Use whole numbers.

## API reference

| Function                                                       | Description                                                              | Returns                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------ |
| [`isDisposableEmail(email)`](#isdisposableemail)               | Is this address on a disposable provider?                                | `Promise<boolean>`       |
| [`isDisposableDomain(domain)`](#isdisposabledomain)            | Is this domain disposable?                                               | `Promise<boolean>`       |
| [`listDisposableDomains()`](#listdisposabledomains)            | Sorted community and custom domains                                      | `Promise<string[]>`      |
| [`addDisposableDomains(domains)`](#adddisposabledomains)       | Add custom domains                                                       | `Promise<void>`          |
| [`removeDisposableDomains(domains)`](#removedisposabledomains) | Remove custom domains                                                    | `Promise<void>`          |
| [`refresh()`](#refresh)                                        | Download the community list now                                          | `Promise<RefreshResult>` |
| [`clearCache(options?)`](#clearcache)                          | Clear stored data, then re-download                                      | `Promise<void>`          |
| [`init()`](#init)                                              | Connect and load the dataset (optional)                                  | `Promise<void>`          |
| [`status()`](#status)                                          | Health snapshot                                                          | `MailSniffStatus`        |
| [`close()`](#close)                                            | Stop timers and release resources                                        | `Promise<void>`          |
| [`configure(options)`](#configure)                             | Configure the default instance                                           | `void`                   |
| [`createMailSniff(options?)`](#createmailsniff)                | Create an independent instance                                           | `MailSniff`              |
| `MailSniff`                                                    | Class returned by `createMailSniff()` (can also be constructed directly) | n/a                      |

**Error classes:** `MailSniffError` (base), `ConfigError`, `ValidationError`, `DatasetError`, `CacheError`, `ClosedError`.

## Error handling and troubleshooting

All errors extend `MailSniffError` and carry a `code` property: `CONFIG_ERROR`, `VALIDATION_ERROR`, `DATASET_ERROR`, `CACHE_ERROR` or `CLOSED_ERROR`. `ValidationError` also has an `invalid` array.

**What is thrown, and what is only reported**

| Situation                                                                   | Behavior                                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Wrong argument type (for example `isDisposableEmail(42)`)                   | `TypeError`                                                                                         |
| Malformed or empty email or domain passed to a lookup                       | Resolves `false`                                                                                    |
| Invalid domain passed to `addDisposableDomains` / `removeDisposableDomains` | `ValidationError`, nothing changed                                                                  |
| Invalid options in `configure()` / `createMailSniff()`                      | `ConfigError`, thrown immediately                                                                   |
| `redis` configured but `ioredis` not installed                              | `ConfigError` from `init()` (even without `failOnInitError`)                                        |
| Used after `close()` on an instance                                         | `ClosedError`                                                                                       |
| Initial download fails (offline, GitHub down, invalid file)                 | `init()` resolves. The error goes to `onError` and `status().lastError`, `state` is `degraded`      |
| Same, with `failOnInitError: true`                                          | `init()` rejects with the `DatasetError`                                                            |
| Scheduled refresh fails                                                     | Reported to `onError`, previous list kept, retried with backoff                                     |
| Manual `refresh()` fails                                                    | Resolves `{ status: 'failed', error }`, previous list kept                                          |
| Redis unreachable at startup                                                | Reported to `onError` as a `CacheError`. Lookups work after the download. Retried in the background |
| Redis write fails (custom domains, `clearCache`)                            | `CacheError`, nothing changed locally                                                               |

**Common issues**

- **Everything returns `false` and `status().state` is `'degraded'`.** The community list is empty because the first download failed, for example in a network-restricted environment. Check `status().lastError`, set `onError`, and allow outbound HTTPS to `raw.githubusercontent.com` (or set `dataset.fetch` / `dataset.sourceUrl`). Custom domains still work. MailSniff does **not** block signups in this state, so alert on it if that matters to you.
- **`ConfigError` mentioning `ioredis`.** Run `npm install ioredis`.
- **`ConfigError` mentioning `REDIS_URL`.** `redis.url` was `undefined`: the environment variable is not set.
- **`configure() must be called before the default instance is used`.** Another top-level function (even `status()`) ran first. Call `configure()` at the very start, or use `createMailSniff()`.
- **`refreshInterval` rejected.** Use a value between `'1m'` and `'24d'`, as whole numbers.
- **"The dataset was rejected" in `onError`.** The download failed validation (too few domains, too many invalid lines, or a suspicious shrink). The previous list stays active.
- **Process does not exit.** Call `close()`. MailSniff's own timers are unref'd, but an open Redis connection keeps Node alive.

```js
import { createMailSniff } from 'mailsniff';

const mailsniff = createMailSniff({
  onError: (error) => console.error(`[mailsniff] ${error.name}: ${error.message}`),
});

await mailsniff.init();
const { state, lastError } = mailsniff.status();
if (state !== 'ready') {
  console.warn('MailSniff is degraded:', lastError?.message);
}
```

## Performance and best practices

- **Create one instance and reuse it** (or use the top-level functions). Do not create an instance per request.
- **Warm up at startup** with `await init()` so the first user does not wait for the download.
- **Lookups are cheap.** They are in-process set checks with no I/O, so you can call them on every request.
- **Network use is minimal.** The list is downloaded once, then only on refresh, with conditional requests when the source has not changed.
- **Pick a refresh interval that fits your needs.** The community list changes over time, but not by the minute. `'1d'` is a reasonable starting point. Enable it only in long-running processes.
- **Use Redis when you run several instances or restart often.** One instance downloads, the others share the result, and custom domains persist.
- **Always set `onError`** so failed downloads and Redis outages are visible. Monitor `status()`.
- **Call `close()` on shutdown**, especially with Redis.
- **Reject gracefully.** Tell users to use a permanent address, and consider a softer path (extra verification) instead of a hard block if you have users on unusual providers.

## Limitations

- The dataset is **community-maintained**. It does not identify every temporary email provider, and new disposable domains can take time to appear.
- A domain that is **not** in the list is not proof that an address is legitimate.
- MailSniff does **not** verify that an address exists, can receive mail, or belongs to the user. Combine it with normal email validation and a verification email.
- **Fail-open:** when no list could be loaded, lookups return `false` rather than blocking users. Monitor `status()`.
- Domains are matched, not whole addresses. Plus-addressing and aliases on legitimate providers (for example Gmail) are out of scope.
- Wildcard patterns are not supported for custom domains. Subdomain matching covers the common case.
- The in-memory backend does not persist or share anything. Use Redis if you need that.
- If Redis is down while a download completes, the list is served locally but is not written to Redis until the next successful refresh.
- Timers are not restartable: after `close()`, create a new instance.
- Requires Node.js 18 or newer (uses the global `fetch`).

## Contributing

Contributions are welcome.

- **Bugs and feature requests:** open an issue at [github.com/last-stand/mailsniff/issues](https://github.com/last-stand/mailsniff/issues) with steps to reproduce, expected and actual behavior, and your Node.js version.
- **Pull requests:** fork the repository, create a branch, and run the checks before opening the PR (the project uses [pnpm](https://pnpm.io)):

  ```bash
  pnpm install
  pnpm run lint
  pnpm run typecheck
  pnpm run test
  pnpm run build
  ```

  Redis integration tests run with `REDIS_URL=redis://localhost:6379 pnpm run test:integration`.

- **Improving coverage of disposable domains:** missing or wrongly listed domains belong in the upstream [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) project, which benefits everyone using the list. For domains only your application cares about, use [`addDisposableDomains()`](#adddisposabledomains).

## License and attribution

MailSniff is released under the [Creative Commons Zero v1.0 Universal](./LICENSE) public domain dedication (`CC0-1.0`). You can copy, modify and use it for any purpose without asking permission or giving credit.

The disposable domain list is **not** part of this repository or package. It is downloaded at runtime from the [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) project, which also describes itself as licensed under CC0. See that repository for the current license and for the list of contributors. Thank you to its maintainers and contributors.
