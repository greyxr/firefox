/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_PasswordCredentialManager_h
#define mozilla_dom_PasswordCredentialManager_h

#include "nsISupports.h"
#include "nsWrapperCache.h"
#include "nsPIDOMWindow.h"
#include "mozilla/dom/Promise.h"

namespace mozilla::dom {

class PasswordCredentialManager final : public nsISupports,
                                        public nsWrapperCache {
 public:
  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_WRAPPERCACHE_CLASS(PasswordCredentialManager)

  explicit PasswordCredentialManager(nsPIDOMWindowInner* aParent);

  nsPIDOMWindowInner* GetParentObject() const { return mParent; }

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  already_AddRefed<Promise> RegisterNonce(const nsAString& aActualCredential,
                                          const nsAString& aUrl,
                                          ErrorResult& aRv);

  static bool IsEnabled(JSContext* aCx, JSObject* aObject);

 private:
  ~PasswordCredentialManager() = default;

  nsCOMPtr<nsPIDOMWindowInner> mParent;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_PasswordCredentialManager_h
