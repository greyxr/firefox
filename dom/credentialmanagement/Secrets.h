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
