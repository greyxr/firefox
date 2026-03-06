# Plan: Complete `window.secrets` API on the `window` branch

## Context

The `window` branch is implementing a `window.secrets` API for nonce-based password replacement, based on the Manifest V3 proposal from the "Passwords and FIDO2 Are Meant To Be Secret" paper (CCS '25). The branch already has:

- `Window.webidl` partial interface exposing `window.secrets`
- `nsGlobalWindowInner` accessor and member with cycle collection
- `nsHttpHandler` rekeyed from host-string to browsing context ID (`uint64_t`)
- `Credential` struct extended with `methods` (HTTP method policy)
- Old extension API (`handleCredentialReplacement`) and `nsIWebRequestConfig.idl` removed
- `secretStorage` permission and static atom added

**What's missing:** The 3 files referenced by `moz.build` that don't exist yet: `Secrets.webidl`, `Secrets.h`, `Secrets.cpp`.

## Files to Create

### 1. `dom/webidl/Secrets.webidl`

**Why:** Defines the JS-visible API. Already referenced in `dom/webidl/moz.build`.

**Explanation:** The interface exposes a single `registerNonce` method matching the paper's proposal. No `Pref=` attribute is needed because `Window.webidl` already gates access via `Func="mozilla::dom::Secrets::IsEnabled"`. The `methods` parameter defaults to an empty sequence, meaning all HTTP methods are allowed (matching the existing `Credential` struct behavior where an empty `methods` array means no filtering). The method is synchronous because the credential is stored in an in-memory map immediately.

```webidl
[Exposed=Window]
interface Secrets {
  [Throws]
  undefined registerNonce(DOMString nonce, DOMString secret,
                          optional sequence<DOMString> methods = []);
};
```

### 2. `dom/credentialmanagement/Secrets.h`

**Why:** C++ class backing the WebIDL interface. Already referenced in `dom/credentialmanagement/moz.build`.

**Explanation:** Follows the `Credential` class pattern in the same directory (`dom/credentialmanagement/Credential.h`):
- Inherits `nsISupports` + `nsWrapperCache` (not `DOMEventTargetHelper`, since Secrets has no events)
- Uses `NS_DECL_CYCLE_COLLECTING_ISUPPORTS` and `NS_DECL_CYCLE_COLLECTION_WRAPPERCACHE_CLASS` macros for garbage collection safety
- Constructor takes `nsPIDOMWindowInner*` — this matches the existing `GetSecrets()` call in `nsGlobalWindowInner.cpp` which does `new dom::Secrets(this)`
- `IsEnabled(JSContext*, JSObject*)` is the static method signature required by the `Func=` attribute in `Window.webidl`
- `RegisterNonce` parameter types follow WebIDL→C++ mapping: `DOMString` → `const nsAString&`, `sequence<DOMString>` → `const nsTArray<nsString>&`, `[Throws]` → `ErrorResult& aRv`

```cpp
#ifndef mozilla_dom_Secrets_h
#define mozilla_dom_Secrets_h

#include "nsCycleCollectionParticipant.h"
#include "nsPIDOMWindow.h"
#include "nsWrapperCache.h"

namespace mozilla::dom {

class Secrets final : public nsISupports, public nsWrapperCache {
 public:
  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_WRAPPERCACHE_CLASS(Secrets)

  explicit Secrets(nsPIDOMWindowInner* aParent);

  nsISupports* GetParentObject() const { return mParent; }
  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  static bool IsEnabled(JSContext* aCx, JSObject* aGlobal);

  void RegisterNonce(const nsAString& aNonce, const nsAString& aSecret,
                     const nsTArray<nsString>& aMethods, ErrorResult& aRv);

 private:
  ~Secrets() = default;
  nsCOMPtr<nsPIDOMWindowInner> mParent;
};

}  // namespace mozilla::dom
#endif
```

### 3. `dom/credentialmanagement/Secrets.cpp`

**Why:** Implementation bridging the DOM API to the networking layer. Already referenced in `dom/credentialmanagement/moz.build`.

**Explanation of key implementation decisions:**

- **Cycle collection boilerplate** follows `Credential.cpp` exactly (`NS_IMPL_CYCLE_COLLECTION_WRAPPERCACHE`, `NS_IMPL_CYCLE_COLLECTING_ADDREF`, etc.)
- **`WrapObject`** calls auto-generated `Secrets_Binding::Wrap` (the binding is generated from `Secrets.webidl`)
- **`IsEnabled`** returns `true` for now. Can be gated by a pref later (e.g., `StaticPrefs::dom_secrets_enabled()`)
- **`nsHttpHandler::GetInstance()`** is used to access the HTTP handler singleton directly. This is a public static method (declared at `nsHttpHandler.h:128`) that returns `already_AddRefed<nsHttpHandler>`. This avoids needing any new XPCOM IDL interface — the old `nsIWebRequestConfig.idl` was deleted for good reason
- **Browsing context ID** is obtained via `mParent->GetBrowsingContext()->Id()`. `GetBrowsingContext()` is on `nsPIDOMWindowInner` (`nsPIDOMWindow.h:415`), and `Id()` returns `uint64_t` (`BrowsingContext.h:535`). This matches the key used by `nsHttpChannel::ContinuePrepareToConnect()` which does `mLoadInfo->GetBrowsingContextID()`
- **String conversion:** WebIDL `DOMString` arrives as UTF-16 (`nsAString`), but `nsHttpHandler::AddCredential` takes UTF-8 (`nsACString`). `NS_ConvertUTF16toUTF8` handles this

```cpp
#include "mozilla/dom/Secrets.h"
#include "mozilla/dom/SecretsBinding.h"
#include "mozilla/dom/BrowsingContext.h"
#include "nsHttpHandler.h"

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_WRAPPERCACHE(Secrets, mParent)
NS_IMPL_CYCLE_COLLECTING_ADDREF(Secrets)
NS_IMPL_CYCLE_COLLECTING_RELEASE(Secrets)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(Secrets)
  NS_WRAPPERCACHE_INTERFACE_MAP_ENTRY
  NS_INTERFACE_MAP_ENTRY(nsISupports)
NS_INTERFACE_MAP_END

Secrets::Secrets(nsPIDOMWindowInner* aParent) : mParent(aParent) {}

JSObject* Secrets::WrapObject(JSContext* aCx,
                              JS::Handle<JSObject*> aGivenProto) {
  return Secrets_Binding::Wrap(aCx, this, aGivenProto);
}

/* static */
bool Secrets::IsEnabled(JSContext* aCx, JSObject* aGlobal) {
  return true;
}

void Secrets::RegisterNonce(const nsAString& aNonce, const nsAString& aSecret,
                            const nsTArray<nsString>& aMethods,
                            ErrorResult& aRv) {
  BrowsingContext* bc = mParent->GetBrowsingContext();
  if (!bc) {
    aRv.Throw(NS_ERROR_FAILURE);
    return;
  }

  RefPtr<mozilla::net::nsHttpHandler> handler =
      mozilla::net::nsHttpHandler::GetInstance();
  if (!handler) {
    aRv.Throw(NS_ERROR_FAILURE);
    return;
  }

  nsTArray<nsCString> methods;
  for (const auto& m : aMethods) {
    methods.AppendElement(NS_ConvertUTF16toUTF8(m));
  }

  nsresult rv = handler->AddCredential(
      bc->Id(), NS_ConvertUTF16toUTF8(aNonce),
      NS_ConvertUTF16toUTF8(aSecret), methods);
  if (NS_FAILED(rv)) {
    aRv.Throw(rv);
  }
}

}  // namespace mozilla::dom
```

## No Other Files Need Changes

All scaffolding is already in place on the `window` branch:
- `dom/webidl/moz.build` — already lists `Secrets.webidl`
- `dom/credentialmanagement/moz.build` — already lists `Secrets.h` and `Secrets.cpp`
- `dom/webidl/Window.webidl` — already has the `partial interface` with `Func` gating
- `dom/base/nsGlobalWindowInner.h/.cpp` — already has `mSecrets`, `GetSecrets()`, cycle collection hooks
- `netwerk/protocol/http/nsHttpHandler.h/.cpp` — already has `AddCredential(uint64_t, ...)`, `GetInstance()`
- `netwerk/protocol/http/nsHttpChannel.cpp` — already does credential lookup via browsing context ID

## Verification

1. `git checkout window`
2. Create the 3 files listed above
3. `./mach build`
4. `./mach run`
5. In devtools console: `typeof window.secrets` should return `"object"`
6. `window.secrets.registerNonce("test-nonce", "real-password", ["POST"])` should not throw
7. Test with a form submission to verify nonce replacement works end-to-end
