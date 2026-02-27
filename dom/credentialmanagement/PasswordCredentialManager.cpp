/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "PasswordCredentialManager.h"

// #include "mozilla/dom/PasswordCredentialManagerBinding.h"
// #include "mozilla/dom/Promise.h"
// #include "nsContentUtils.h"
// #include "nsGkAtoms.h"
// #include "nsIUUIDGenerator.h"
// #include "nsIWebRequestConfig.h"
// #include "nsServiceManagerUtils.h"

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_WRAPPERCACHE(PasswordCredentialManager, mParent)
NS_IMPL_CYCLE_COLLECTING_ADDREF(PasswordCredentialManager)
NS_IMPL_CYCLE_COLLECTING_RELEASE(PasswordCredentialManager)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(PasswordCredentialManager)
  NS_WRAPPERCACHE_INTERFACE_MAP_ENTRY
  NS_INTERFACE_MAP_ENTRY(nsISupports)
NS_INTERFACE_MAP_END

PasswordCredentialManager::PasswordCredentialManager(
    nsPIDOMWindowInner* aParent)
    : mParent(aParent) {}

// JSObject* PasswordCredentialManager::WrapObject(
//     JSContext* aCx, JS::Handle<JSObject*> aGivenProto) {
//   return PasswordCredentialManager_Binding::Wrap(aCx, this, aGivenProto);
// }

/* static */
bool PasswordCredentialManager::IsEnabled(JSContext* aCx, JSObject* aObject) {
  RefPtr<BasePrincipal> principal =
      BasePrincipal::Cast(nsContentUtils::SubjectPrincipal(aCx));
  if (!principal) {
    return false;
  }
  if (principal->IsSystemPrincipal()) {
    return true;
  }
  return nsContentUtils::PrincipalHasPermission(*principal,
                                                nsGkAtoms::secretStorage);
}

already_AddRefed<Promise> PasswordCredentialManager::RegisterNonce(
    const nsAString& aActualCredential, const nsAString& aUrl,
    ErrorResult& aRv) {
  RefPtr<Promise> promise = Promise::Create(mParent->AsGlobal(), aRv);
  // if (aRv.Failed()) {
  //   return nullptr;
  // }

  // nsresult rv;
  // nsCOMPtr<nsIUUIDGenerator> uuidgen =
  //     do_GetService("@mozilla.org/uuid-generator;1", &rv);
  // if (NS_FAILED(rv)) {
  //   aRv.Throw(rv);
  //   return nullptr;
  // }

  // nsID uuid;
  // rv = uuidgen->GenerateUUIDInPlace(&uuid);
  // if (NS_FAILED(rv)) {
  //   aRv.Throw(rv);
  //   return nullptr;
  // }

  // char uuidChars[NSID_LENGTH];
  // uuid.ToProvidedString(uuidChars);
  // // Strip the surrounding braces from the UUID string.
  // nsCString nonce(uuidChars + 1, NSID_LENGTH - 3);

  // nsCOMPtr<nsIWebRequestConfig> config =
  //     do_GetService("@mozilla.org/network/protocol;1?name=http", &rv);
  // if (NS_FAILED(rv) || !config) {
  //   aRv.Throw(NS_ERROR_FAILURE);
  //   return nullptr;
  // }

  // NS_ConvertUTF16toUTF8 url(aUrl);
  // NS_ConvertUTF16toUTF8 actualCredential(aActualCredential);
  // rv = config->AddCredential(url, nonce, actualCredential);
  // if (NS_FAILED(rv)) {
  //   aRv.Throw(rv);
  //   return nullptr;
  // }

  // promise->MaybeResolve(NS_ConvertUTF8toUTF16(nonce));
  // return promise.forget();
  printf("Inside registerNonce\n");
  return promise.forget();
}

}  // namespace mozilla::dom
