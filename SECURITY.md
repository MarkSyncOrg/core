# Security notes for consumers of `@marksyncorg/core`

This package handles end-to-end-encrypted bookmark data. Most of its hardening is
internal, but three things cannot be solved inside the library and are the consuming
application's responsibility. A full audit, including the fixed findings, is in
[SECURITY-REVIEW.md](./SECURITY-REVIEW.md).

## 1. Check URLs before rendering or navigating

The library filters unsafe URL schemes (`javascript:`, `data:`, …) out of every tree that
crosses a trust boundary — backup files, decrypted sync payloads, and the local tree
before it is uploaded or compared. The pure model constructors (`newBookmark`,
`nativeToBookmarks`) deliberately do **not** filter, because the browser's own tree may
legitimately contain bookmarklets the user created.

So before turning a bookmark into a link or navigating to one:

```ts
import { isSafeBookmarkUrl } from '@marksyncorg/core';

if (isSafeBookmarkUrl(bookmark.url)) {
  // safe to render as <a href> or to open
}
```

For any bookmark tree arriving from outside, run it through the trust-boundary helper
first — it validates the shape, caps nesting depth, and drops unsafe URLs in one call:

```ts
import { acceptBookmarkTree } from '@marksyncorg/core';

const tree = acceptBookmarkTree(untrustedValue); // throws InvalidBookmarkDataError
```

The recursive transforms (`canonicalizeBookmarks`, `stripIds`, `assignIds`,
`cleanAllBookmarks`, `threeWayMerge`) assume validated input — that is what bounds their
recursion depth. Do not call them on unvalidated data.

Filtering is not deletion. Sanitisation decides what the library *accepts*, so a
bookmarklet the user keeps in the browser is excluded from the sync but is not removed
from the browser: `SyncEngine` puts such nodes back before the destructive write that
applies a remote tree. If you write bookmarks yourself, either do the same via
`sanitizeBookmarkTreeWithReport` / `reinstateRemovedBookmarks`, or tell the user what is
about to disappear:

```ts
import { extractBookmarksWithReport } from '@marksyncorg/core';

const { bookmarks, removed } = extractBookmarksWithReport(backup);
if (removed.length > 0) {
  // e.g. "3 entries were skipped because their addresses cannot be synced"
}
```

The `removed` entries carry the node, the titles of the folders that held it and the
index it occupied — enough to report them or to put them back.

## 2. Protect the storage area — it holds the decryption key

`SyncInfo.passwordHash` is the Base64 PBKDF2 output, and that value **is** the AES key.
The raw password is never stored, but anything able to read the storage area can decrypt
the entire sync directly; the 250,000 PBKDF2 iterations protect the password against
offline recovery, not the data at rest.

This is inherited xBrowserSync behaviour and cannot change without breaking
compatibility with other clients. Choose the `StorageArea` implementation accordingly —
an OS keychain or the extension's protected storage rather than plain `localStorage` —
and treat "device compromised" as "sync compromised".

## 3. The service is trusted for availability and freshness, not integrity of history

AES-GCM authenticates each payload in isolation, with no binding to a version or
sequence number, and change detection trusts the server's `lastUpdated`. A malicious or
compromised service can therefore replay an **older, genuinely valid** ciphertext, and
the client will accept and apply it — silently reverting deletions or edits with no
integrity error. It cannot forge or read bookmark contents.

This is inherent to the xBrowserSync protocol. Two practical mitigations:

- The client requires `https` (plain `http` is allowed only for loopback), so this needs
  the service itself, not a network position.
- Encourage users to keep periodic local backups via `buildBackup`, which is the only
  copy outside the service's control.

## Reporting

Please report suspected vulnerabilities privately through the repository's security
advisory page rather than in a public issue.
