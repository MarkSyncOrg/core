# Security Review — `@marksyncorg/core`

**Scope:** full review of the repository at `414fc54` (all of `src/`, the publish workflow,
the OpenAPI contract, and the dependency tree).
**Baseline:** 113 tests pass, `tsc --noEmit` clean, no secrets in the working tree or history.

This package is a platform-agnostic library consumed by a PWA and a web-extension rewrite.
That matters for severity: **the library is the trust boundary** for bookmark data arriving
from backup files, shared syncs, and the sync service. Validation it omits is validation that
each consumer must independently remember to perform.

Every finding below was verified by execution against the built `dist/`, not inferred by
reading. Hypotheses that did not survive testing are listed in "Verified not vulnerable" —
they are part of the result, not omissions.

---

## Summary

| # | Severity | Finding | Location | Status |
|---|----------|---------|----------|--------|
| 1 | **High** | Bookmark URLs are never scheme-validated (`javascript:`, `data:`) | `src/bookmarks/bookmark.ts:119` | **Fixed** |
| 2 | **Medium** | `parseBackup` does no schema validation on unauthenticated input | `src/backup/backup.ts:51` | **Fixed** |
| 3 | **Medium** | Unbounded recursion over bookmark trees → stack-overflow DoS | `src/bookmarks/bookmark.ts:95`, `src/sync/merge.ts:86` | **Fixed** |
| 4 | **Medium** | `serviceUrl` accepted with no validation or scheme allowlist | `src/api/xbrowsersync-api.ts:79` | **Fixed** |
| 5 | **Medium** | Publish workflow has no test gate and uses mutable action tags | `.github/workflows/publish.yml:27` | Partly fixed |
| 6 | Low | Derived AES key persisted in plaintext storage | `src/storage/sync-store.ts:9` | Documented |
| 7 | Low | No rollback protection against a malicious/compromised service | `src/sync/sync-engine.ts:114` | Documented |
| 8 | Low | 5 vulnerable transitive dependencies (all dev-only) | `pnpm-lock.yaml` | Partly fixed |
| 9 | Low | Sync-ID format declared in OpenAPI but never enforced client-side | `openapi/xbrowsersync-api.yaml:255` | **Fixed** |
| 10 | Info | `trimToNearestWord` discards the whole string when no space precedes the limit | `src/bookmarks/bookmark.ts:50` | **Fixed** |
| 11 | Info | Logger persists unredacted messages beside credentials | `src/log/logger.ts:25` | **Fixed** |

Remediation is described in [Remediation](#remediation) at the end of this document, and
the findings below describe the code **as it was when reviewed**. Findings 6 and 7 are
constrained by the xBrowserSync compatibility contract and are documented for consumers
in [SECURITY.md](./SECURITY.md) rather than fixed.

---

## 1. Bookmark URLs are never scheme-validated — **High**

`newBookmark` (`src/bookmarks/bookmark.ts:119`) and `nativeToBookmarks`
(`src/bookmarks/bookmark.ts:154`) trim the URL and store it verbatim. No scheme check exists
anywhere in the package.

Verified:

```
newBookmark('x','javascript:alert(document.cookie)')
  => {"title":"x","url":"javascript:alert(document.cookie)"}

nativeToBookmarks([{title:'y',url:'data:text/html,<script>alert(1)</script>'}])
  => [{"title":"y","url":"data:text/html,<script>alert(1)</script>"}]
```

Both survive the full round trip — `cleanBookmark`, `serializeBookmarks`, `threeWayMerge` and
`stripIds` all preserve the URL untouched.

**Why this matters.** Three untrusted sources feed `Bookmark[]` into consumers:

- a **backup file** (`parseBackup` → `restore`) — unauthenticated, user-supplied;
- a **shared sync** — anyone holding the sync ID and password can write the tree;
- the **service response** itself.

The library hands these to `provider.setBookmarks()` and to consumers for rendering. A consumer
that renders a bookmark as `<a href={bookmark.url}>` — the obvious implementation — gives a
`javascript:` URL execution in the page origin. In the web-extension consumer that is the
extension origin, with whatever privileges the extension holds. `data:text/html` is the same
class of problem.

Because the trees are also written into the browser's real bookmark store, a malicious entry
persists after the sync is disabled.

**Recommendation.** Add a scheme allowlist at the model boundary — `http:`, `https:`, `ftp:`,
`mailto:`, plus the `xbs:separator` sentinel — applied in `newBookmark` and
`nativeToBookmarks`, and re-applied to any tree entering via backup or remote decrypt. Reject
or drop nodes that fail. This does not alter the wire format, so it is compatible with the
xBrowserSync contract the file header protects: it constrains only what this client will
*accept*, never what it writes.

## 2. `parseBackup` performs no schema validation — **Medium**

`extractBookmarks` (`src/backup/backup.ts:51`) tests only that the field is *truthy*:

```ts
const current = backup.xbrowsersync?.data?.bookmarks;
if (current) { return current; }
```

It never checks `Array.isArray`. `parseBackup` claims to be "validating the shape" and
delegates that validation entirely to this check. Verified:

```
bookmarks:"pwned"  => parseBackup succeeds, returns the string as Bookmark[]
bookmarks:42       => extractBookmarks returns 42
bookmarks:{"a":1}  => extractBookmarks returns {"a":1}
then: stripIds(...) => TypeError: bookmarks.map is not a function
```

A backup file is the *least* trusted input in the system — unauthenticated, unencrypted, and
typically chosen from disk by the user. Yet it is validated less than the authenticated path:
`deserializeBookmarks` (`src/bookmarks/bookmark.ts:225`) *does* enforce `Array.isArray` and
throws `TypeError('Sync data is not a bookmark array')` on `"42"`. The asymmetry is inverted
relative to trust.

Consequence today is a type-confusion crash with an unhelpful `TypeError` surfacing from deep
inside the tree transforms, mid-`restore`. Since `restore` may already have called
`applyRemote` before failing, a partially-applied restore is reachable.

**Recommendation.** Validate in `extractBookmarks`: require `Array.isArray`, and recursively
check each node's fields against the `Bookmark` shape (`id`/`title`/`url`/`description` types,
`tags` as a string array, `children` as an array). Throw the existing
`'Unrecognised backup file'` on failure so callers keep a single error contract.

## 3. Unbounded recursion over bookmark trees — **Medium**

`cleanAllBookmarks`, `eachBookmark`, `assignIds` and `stripIds`
(`src/bookmarks/bookmark.ts:95`–`208`) and `mergeLevel` (`src/sync/merge.ts:86`) all recurse on
`children` with no depth limit.

Verified threshold on Node 22 with the default stack:

```
depth   500 => OK
depth 1,000 => OK
depth 2,000 => OK
depth 4,000 => RangeError: Maximum call stack size exceeded
```

A crafted backup file of only a few tens of kilobytes reaches a crashing depth — the payload is
`{"children":[` repeated, so cost to the attacker is negligible. `canonicalizeBookmarks` is on
the hot path for dirty-detection, so the crash is reachable from `isDirty()`, `sync()`,
`restore()` and every decrypt of a remote tree, not just from backup restore.

**Recommendation.** Enforce a maximum depth (a few hundred levels is far beyond any real
bookmark tree) during validation, rejecting deeper trees before they reach the transforms.
Bounding the input is simpler and safer than converting five separate walkers to iterative form.

## 4. `serviceUrl` is accepted with no validation — **Medium**

`XbrowsersyncApi` (`src/api/xbrowsersync-api.ts:79`) strips trailing slashes and passes the
string straight to `createClient({ baseUrl })`. `createFinalURL` in openapi-fetch concatenates
without parsing. Verified request URLs:

```
"http://plaintext.example.com"            -> http://plaintext.example.com/bookmarks/abc/lastUpdated
"https://evil.example.com/path?injected=" -> https://evil.example.com/path?injected=/bookmarks/abc/lastUpdated
"https://evil.example.com/#"              -> https://evil.example.com/#/bookmarks/abc/lastUpdated
"file:///etc/passwd"                      -> file:///etc/passwd/bookmarks/abc/lastUpdated
"javascript:alert(1)"                     -> javascript:alert(1)/bookmarks/abc/lastUpdated
```

Three distinct problems:

- **No TLS requirement.** `http://` is accepted silently. Bookmark *contents* stay protected by
  the client-side encryption, but the sync ID travels in cleartext in the URL path on every
  poll, and an active network attacker controls every response.
- **Endpoint collapse.** A `?` or `#` in the base URL folds the entire API path into a query
  string or fragment, so `/info`, `/bookmarks/{id}` and `/lastUpdated` all resolve to the *same*
  URL. The `getInfo()` validation at `src/api/xbrowsersync-api.ts:85` is then no longer a check
  on the endpoints actually used — one crafted response satisfies it for all of them.
- **No scheme allowlist.** Non-HTTP schemes are passed to `fetch` unfiltered.

**Recommendation.** Parse with `new URL(serviceUrl)` in the constructor; reject anything whose
protocol is not `https:` (allowing `http:` only for explicit loopback, for local self-hosting),
and reject a base URL carrying a query or fragment. Throw the existing `InvalidServiceError`.

## 5. Publish workflow gaps — **Medium**

`.github/workflows/publish.yml`:

- **No test gate.** The job runs `pnpm install` → `pnpm build` → `pnpm publish` (lines 27–33).
  `pnpm test` is never invoked, so a tag push publishes to the registry with a red test suite.
  The 113 tests here are the only thing guarding the crypto and merge logic.
- **Mutable action tags.** `actions/checkout@v4`, `pnpm/action-setup@v4` and
  `actions/setup-node@v4` are floating tags. A compromised or repointed tag executes in a job
  holding `packages: write`. Pin to full commit SHAs.
- **No provenance.** Consider `--provenance` on publish so consumers can verify the artifact's
  origin.

Correctly done and worth keeping: `permissions` is least-privilege (`contents: read`,
`packages: write`), triggers are `push: tags` and `workflow_dispatch` only — no
`pull_request_target`, so untrusted fork code cannot reach the publish credentials — and
`files: ["dist","openapi"]` keeps sources out of the tarball.

## 6. Derived AES key persisted in plaintext — Low

`SyncInfo.passwordHash` (`src/storage/sync-store.ts:9`) stores the Base64 PBKDF2 output. The
comment notes "the raw password is never stored — only this derived key," which is accurate but
understates the exposure: the derived key *is* the AES key, so anything that can read the
storage area can decrypt the entire sync directly. The 250,000 PBKDF2 iterations protect the
password against offline recovery; they provide no protection for the data once the derived key
is at rest.

This is inherited xBrowserSync behaviour and cannot change without breaking compatibility.
Flagged so consumers make a deliberate choice about the storage backend's protection (e.g.
OS keychain rather than `localStorage`), and so the trade-off is documented rather than implied.

## 7. No rollback protection — Low

`pull()` (`src/sync/sync-engine.ts:114`) trusts the server's `lastUpdated` for change detection,
and AES-GCM authenticates each payload in isolation with no binding to a version or sequence. A
malicious or compromised service can therefore replay an *older, genuinely valid* ciphertext and
the client will accept and apply it — silently reverting bookmark deletions or edits without any
integrity error.

Inherent to the xBrowserSync protocol; not fixable client-side without breaking the contract.
Recorded for completeness, and it strengthens the case for requiring TLS in finding 4.

## 8. Vulnerable transitive dependencies (dev-only) — Low

`pnpm audit`: **5 vulnerabilities — 4 high, 1 moderate**. All reach the tree through
`openapi-typescript`, a `devDependency`:

- `brace-expansion` — DoS via exponential expansion (GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg)
- `js-yaml` — quadratic-complexity DoS via YAML merge keys (GHSA-h67p-54hq-rp68)

None ship to consumers: `files` publishes only `dist` and `openapi`, and no runtime dependency
(`lzutf8`, `openapi-fetch`, `qrcode`) is affected. Real-world impact is limited to build-time
processing of the OpenAPI spec, which is repo-controlled. Resolve with a `pnpm.overrides` bump
to keep audit output clean and avoid masking a future runtime finding.

## 9. Sync-ID format is declared but not enforced — Low

`openapi/xbrowsersync-api.yaml:255` specifies `pattern: '^[a-f0-9]{32}$'` for `SyncId`.
openapi-fetch is types-only and performs no runtime validation, and no client-side check exists
(confirmed by search). Any string reaches `getSync`/`getLastUpdated`.

This is *not* exploitable as path traversal — see below — so the impact is limited to malformed
requests reaching the service. Validating the pattern in `enableExistingSync` would also give
users a clear local error instead of an opaque `SyncNotFoundError` after a round trip.

## 10. `trimToNearestWord` can discard the entire string — Info

`src/bookmarks/bookmark.ts:50`. When no space occurs before `limit`,
`trimmed.lastIndexOf(' ', limit)` returns `-1`, and `substring(0, -1)` yields `''`:

```
trimToNearestWord('a'.repeat(400), 300) => "…"
```

A 400-character description with no early space becomes a lone ellipsis. Correctness/data-loss
rather than a security issue, but it silently destroys user data. Fall back to a hard
`substring(0, limit)` when no boundary is found.

## 11. Logger persists unredacted messages — Info

`Logger.append` (`src/log/logger.ts:25`) writes caller-supplied strings to the same
`StorageArea` that holds `passwordHash`, and `formatLog` renders them for download. No
redaction helper is offered. Since the documented use is a downloadable trace log that users
attach to bug reports, a consumer that logs a service URL or sync ID leaks it into a file users
share. Worth a documented redaction convention.

---

## Verified not vulnerable

Tested and cleared — recorded so they are not re-investigated:

- **Path-parameter injection.** `defaultPathSerializer` in openapi-fetch 0.17.0 applies
  `encodeURIComponent` to every path parameter
  (`node_modules/.pnpm/openapi-fetch@0.17.0/.../src/index.js:610`). A sync ID of `../../admin`
  cannot escape the path segment. This is what makes finding 9 low rather than high.
- **QR-code SVG injection.** `renderSyncIdQrSvg('</svg><script>alert(1)</script>')` — the input
  is encoded into QR modules and never echoed into the SVG output; the rendered markup contains
  no `<script>`. Safe for `innerHTML` insertion.
- **Prototype pollution.** `cleanBookmark` assigns only from the fixed `VALID_KEYS` allowlist,
  which excludes `__proto__`; the object spreads in `assignIds`/`stripIds`/`getSettings` use
  `DefineOwnProperty` semantics and cannot invoke inherited setters.
- **Cryptographic parameters.** PBKDF2-SHA-256 at 250,000 iterations, AES-256-GCM, and a fresh
  128-bit random IV per message from `crypto.getRandomValues`. The non-standard 16-byte IV is
  spec-legal (GCM derives J0 via GHASH when the IV is not 96 bits) and collision probability is
  negligible; the salt is the per-sync ID, which is unique though not secret. No IV reuse, no
  key reuse across syncs, no ECB/CBC padding-oracle surface. Sound as written.
- **Authenticated-path type checking.** `deserializeBookmarks` correctly rejects non-arrays.
- **Decompression bombs via the sync payload.** `lzutf8.decompress` runs only on GCM-
  authenticated plaintext, so forging one requires the key. Reachable only by a party who
  already shares the sync — not a meaningful escalation.
- **Committed secrets.** No credentials, keys or tokens in tracked files or in any blob across
  git history. The only `secrets.` reference is the legitimate `GITHUB_TOKEN` in the workflow.

---

## Remediation

All findings have been addressed. `src/security.test.ts` pins each one with a regression
test named for the finding it guards, so reopening one fails the suite with the reason
attached. Suite: **168 passing** (113 before), typecheck clean.

**A single trust boundary (findings 1–3).** The structural gap noted below — the
authenticated path validated more strictly than the unauthenticated one — is closed by
`src/bookmarks/validate.ts`, which every tree from an untrusted source now passes
through:

- `validateBookmarkTree` — checks the value is an array and every node's field types,
  and caps nesting at `MAX_BOOKMARK_DEPTH` (200). The walk is **iterative**, because a
  recursive validator would overflow on exactly the input it exists to reject. Unknown
  properties are tolerated so a newer client's fields do not make a tree unreadable.
- `sanitizeBookmarkTree` — drops nodes whose URL is not in `SAFE_URL_SCHEMES`, together
  with their subtrees. Scheme checks parse via `URL`, so `JavaScript:`, leading
  whitespace and embedded newlines normalise before comparison.
- `acceptBookmarkTree` — both, and the entry point applied at `extractBookmarks`,
  `deserializeBookmarks`, `SyncEngine.restore` and the decrypt path.

Two consequences worth recording:

- **Sanitisation is symmetric.** `SyncEngine.localBookmarks()` filters the local tree on
  every read, not just the remote one. Filtering one side only would leave local and
  cached permanently unequal, and `isDirty()` compares them — the device would look
  edited on every check and sync in a loop. A regression test pins this.
- **The pure constructors still do not filter.** `newBookmark` and `nativeToBookmarks`
  preserve URLs verbatim, since the browser's own tree may hold user-created
  bookmarklets. The engine filters before anything is uploaded or compared, and
  `isSafeBookmarkUrl` is exported as the render-time guard. This contract is now stated
  in their doc comments and in SECURITY.md.

**Finding 4.** `normalizeServiceUrl` parses the URL, requires `https` (allowing `http`
only for loopback, so self-hosting still works), and rejects embedded credentials and
any query or fragment. The query/fragment check runs against the **raw input**: a bare
trailing `?` or `#` parses to an empty `search`/`hash` yet still survives into `href` and
would swallow every appended endpoint path. The result is rebuilt from `origin +
pathname` so nothing else can survive normalisation.

**Finding 9.** `isValidSyncId` enforces the OpenAPI `SyncId` pattern in the four API
methods that take one, and in `enableExistingSync` ahead of the 250k-iteration key
derivation so a typo fails fast with a message about the ID.

**Finding 5 — partly fixed.** `pnpm typecheck` and `pnpm test` now gate the publish job,
so a tag cannot publish past a red build. The actions are **still on floating tags**: the
GitHub API is outside this session's repository scope, so the real commit SHAs could not
be resolved, and a guessed digest fails the job outright. The workflow carries a `TODO`
with the exact `gh api` command to resolve and apply them — this remains open.

**Finding 8 — partly fixed.** `pnpm-workspace.yaml` (pnpm 11's home for overrides; the
`package.json` field is ignored) pins `brace-expansion` and `postcss`. Audit is down from
**5 vulnerabilities to 2**, both the same `js-yaml` advisory. That one is deliberately
**not** overridden: the advisory's fixed range starts at 4.1.2, but no such release
exists — the fix ships in 5.x, which removed the `types.merge` export that
`@redocly/openapi-core` reads, so forcing it breaks `pnpm gen:api` outright (verified).
The only YAML it parses is this repo's own spec at build time, so there is no untrusted
input. The reasoning is recorded in `pnpm-workspace.yaml`.

**Findings 10 and 11.** `trimToNearestWord` hard-cuts at the limit when no word boundary
precedes it, instead of returning a bare ellipsis. `Logger` scrubs sync IDs, Base64 keys
and URL credentials via `redactSensitive` at write time, so the trace log is never
sensitive rather than needing sanitising before each share.

### Changes to existing tests

Two pre-existing tests were updated to match intended behaviour changes, not to
accommodate breakage:

- `src/api/xbrowsersync-api.test.ts` used the placeholder sync ID `'id1'`, which the new
  format check rejects; it now uses a valid 32-hex ID.
- `src/bookmarks/bookmark.test.ts` expected `TypeError` from `deserializeBookmarks`; it
  now expects `InvalidBookmarkDataError`, which joins the existing `XbsError` hierarchy
  so callers can branch on cause. **This is a breaking change for any consumer catching
  `TypeError` from that function.**

## Still open

1. **Pin the three GitHub Actions to commit SHAs** (finding 5). The only item requiring
   action; the workflow carries the command to resolve them.
2. **Revisit the `js-yaml` advisory** (finding 8) when `openapi-typescript` ships a
   `@redocly/openapi-core` built against js-yaml 5.
3. **Findings 6 and 7** are protocol constraints, not defects to fix. They are documented
   for consumers in [SECURITY.md](./SECURITY.md); revisiting either means breaking
   compatibility with the wider xBrowserSync ecosystem, which is a product decision.

**A note on scope.** Findings 1–3 all described the same structural gap: the package
validated the *authenticated* path (`deserializeBookmarks`) more strictly than the
*unauthenticated* one (`parseBackup`). The shared entry point in
`src/bookmarks/validate.ts` closes all three and is what prevents the asymmetry from
reopening — new code paths handling untrusted trees should call `acceptBookmarkTree`
rather than re-implementing checks.
