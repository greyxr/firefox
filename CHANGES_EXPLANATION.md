# Credential Nonce Replacement for WebRequest API

## Overview

These changes implement a secure credential injection mechanism in Firefox's networking stack. The feature allows a password manager extension (e.g. Bitwarden) to replace an autofilled password in a web page's DOM with a random nonce (UUID), then have Firefox's network layer swap the nonce back to the real credential just before the HTTP request leaves the browser. This prevents the plaintext password from ever being visible to the DOM, other extensions' `onBeforeRequest` hooks, or any JavaScript context.

## Threat Model

The primary threat is **malicious browser extensions** that hook into `webRequest.onBeforeRequest` to observe or exfiltrate passwords from HTTP request bodies. By replacing the credential with a nonce at the DOM/extension level and only resolving it deep in the C++ networking stack (after all extension observers have run), the real password is never exposed to extension JavaScript.

## Architecture

The flow is:

1. **Extension calls `handleCredentialReplacement(actualCredential, url)`** - The extension provides the real credential and the target URL.
2. **Nonce generation** (`ext-webRequest.js`) - A UUID is generated as the nonce.
3. **Credential stored in C++ map** - The nonce and real credential are passed via the `nsIWebRequestConfig.AddCredential()` IDL method into `nsHttpHandler`, which stores them in a `nsTHashMap<nsCStringHashKey, Credential>` keyed by the URL's host.
4. **Nonce returned to extension** - The extension receives the nonce and can place it in the request body (replacing the real password in the form data).
5. **Nonce replaced at network time** (`nsHttpChannel::ContinuePrepareToConnect`) - Just before the HTTP request is sent, the channel looks up credentials for the URL's host. If found, it calls `ReplaceNonce()` which reads the upload stream, replaces the nonce string with the actual credential, creates a new upload stream with the modified body, and updates `Content-Length`.
6. **Credential removed from map** - After a successful replacement, `RemoveCredential()` is called so the credential is not held longer than necessary.

## Files Changed

### IDL / Interface

- **`nsIWebRequestConfig.idl`** - Replaced the old `setDebugInfo(ACString)` method with `AddCredential(ACString url, ACString nonce, ACString actualCredential)`. This is the XPCOM interface that JavaScript (extension code) uses to pass credentials into the C++ networking layer.

### C++ Networking Layer

- **`nsHttpHandler.h`** - Added a `Credential` struct (holds `nonce` and `actualCredential` strings with an `IsEmpty()` helper). Added method declarations for `AddCredential`, `GetCredential`, `RemoveCredential`, and `ReplaceNonce`. Added `mCredMap` (`nsTHashMap<nsCStringHashKey, Credential>`) to store credentials keyed by host. Removed the old `mDebugInfoFromWebRequest` member and `SetDebugInfo` declaration.

- **`nsHttpHandler.cpp`** - Implemented the four new methods:
  - `AddCredential()` - Parses the URL to extract the host, stores the credential in `mCredMap`.
  - `GetCredential()` - Looks up and returns a credential by URL host.
  - `RemoveCredential()` - Removes a credential entry by URL host.
  - `ReplaceNonce()` - The core logic: reads the upload stream from the channel, performs a string find-and-replace of the nonce with the real credential, creates a new input stream with the modified body, and sets it back on the channel via `ExplicitSetUploadStream` (or `SetUploadStream` as fallback). Updates the `Content-Length` header accordingly.
  - Also added error checking on `SetupChannelInternal` in `NewProxiedChannel`, and a `PrintHex` debug utility. Removed all old `MYLOG` debug macros and `gMyLog` logger.

- **`nsHttpChannel.cpp`** - In `ContinuePrepareToConnect()`, after `CallOnModifyRequestObservers()` (i.e., after all extension `onBeforeRequest` observers have run), added a lookup for credentials matching the request URL. If a credential is found, calls `CallReplaceNonce()` to swap the nonce in the request body. Removed old `MYLOG` macros.

- **`HttpBaseChannel.h`** - Added two inline helper methods (`CallReplaceNonce`, `CallGetCredential`) that delegate to `gHttpHandler->ReplaceNonce()` and `gHttpHandler->GetCredential()` respectively.

- **`HttpBaseChannel.cpp`** - Added `#include "nsHttpHandler.h"` to support the new inline methods.

### Extension JavaScript

- **`ext-webRequest.js`** - Rewired `handleCredentialReplacement` to:
  - Accept `actualCredential` and `url` parameters (previously only `actualCredential`).
  - Generate a UUID nonce using `nsIUUIDGenerator`.
  - Call `config.AddCredential(url, nonce, actualCredential)` to store the credential in the C++ layer.
  - Return the nonce to the caller (made the function `async` and added a return value).
  - Removed old `setDebugInfo` call and cleaned up initialization code.

### Extension Schema

- **`web_request.json`** - Updated the `handleCredentialReplacement` function schema to accept a second `url` string parameter and to declare a `string` return type (the nonce).

## Key Design Decisions

- **Host-based keying**: Credentials are stored keyed by the URL's host (not the full URL), which means one credential per host at a time.
- **Single-use credentials**: After a successful nonce replacement, the credential is removed from the map, so it cannot be replayed.
- **Replacement timing**: The replacement happens in `ContinuePrepareToConnect`, which is after `CallOnModifyRequestObservers()`. This ensures all `onBeforeRequest` extension listeners have already fired and can only see the nonce, not the real credential.
- **Stream recreation**: The upload stream is fully read, modified in memory, and a new stream is created. This is necessary because `nsIInputStream` is not generally seekable/rewritable.

## Potential Considerations

- **Single credential per host**: The current `mCredMap` only stores one credential per host. If multiple forms on the same host need simultaneous credential replacement, only the last one stored will be used.
- **`printf` statements**: There are many `printf` debug statements throughout the C++ code that should be removed or converted to `MOZ_LOG` before shipping.
- **Error handling**: Some error paths (e.g., missing `Content-Type`, failed stream reads) print warnings but may need more robust handling.
- **Thread safety**: `mCredMap` is accessed from the main thread during both storage (from JS) and lookup (during channel setup), but thread safety should be verified if any of these paths can run off the main thread.
 **Memory lifetime**: The credential is held in memory as a plaintext `nsCString`. Ideally, the credential would be zeroed out after use rather than relying on normal deallocation.
