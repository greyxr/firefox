@AGENTS.md

# Credential Nonce Replacement Project

## Feature Summary

This branch implements a secure credential injection mechanism for Firefox's networking stack. It allows a password manager extension (e.g. Bitwarden) to replace a real password in form data with a random UUID nonce, then have the C++ networking layer swap the nonce back to the real credential just before the HTTP request is sent — after all `webRequest.onBeforeRequest` extension observers have run.

The goal is to prevent plaintext passwords from being observable by malicious extensions hooking into `webRequest.onBeforeRequest`.

## Flow

1. Extension calls `browser.webRequest.handleCredentialReplacement(actualCredential, url)`
2. `ext-webRequest.js` generates a UUID nonce via `nsIUUIDGenerator`
3. Nonce + credential + page origin stored in C++ via `nsIHttpProtocolHandler.AddCredential(bcID, nonce, actualCredential, methods, origin)`
4. Credentials stored in `nsHttpHandler::mCredMap` (a `nsTHashMap`) keyed by browsing context ID
5. Nonce returned to extension, which places it in the form body
6. In `nsHttpChannel::ContinuePrepareToConnect()`, after `CallOnModifyRequestObservers()`, `CallReplaceNonce()` is called
7. `nsHttpHandler::ReplaceNonce()` enforces HTTPS and origin checks, then reads the upload stream, replaces the nonce string with the real credential, rebuilds the stream, updates `Content-Length`
8. `RemoveCredential()` is called after successful replacement

## Key Files

- `netwerk/protocol/http/nsHttpHandler.h` / `.cpp` — `Credential` struct, `mCredMap`, `AddCredential`, `GetCredential`, `RemoveCredential`, `ReplaceNonce`
- `netwerk/protocol/http/nsHttpChannel.cpp` — `ContinuePrepareToConnect()` triggers nonce replacement
- `netwerk/protocol/http/HttpBaseChannel.h` / `.cpp` — `CallReplaceNonce()` and `CallGetCredential()` helpers
- `netwerk/protocol/http/nsIHttpProtocolHandler.idl` — `addCredential(bcID, nonce, actualCredential, methods, origin)` IDL method
- `dom/credentialmanagement/Secrets.cpp` / `.h` — `window.secrets.registerNonce()` implementation, captures page origin
- `toolkit/components/extensions/parent/ext-webRequest.js` — `handleCredentialReplacement` implementation
- `toolkit/components/extensions/schemas/web_request.json` — schema for the above

## Code Generation Rules

1. All code generated should be minimal.
2. All code generated should follow Firefox standard patterns and design principles. This takes precedence over the first rule.

## Security Checks

- **HTTPS check** — `ReplaceNonce` only performs replacement over HTTPS connections
- **Origin check** — `ReplaceNonce` verifies the request URL origin matches the origin of the page that called `registerNonce`, preventing exfiltration to attacker-controlled servers
- The origin is captured automatically from the page's document URI in `Secrets::RegisterNonce`, so callers cannot spoof it

## Known Limitations / TODOs

- Only one credential per browsing context at a time (map is bcID-keyed)
- Thread safety of `mCredMap` should be verified
- Credential is stored as plaintext `nsCString`; ideally zeroed after use
- Some error paths may need more robust handling
