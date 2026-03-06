#include "mozilla/dom/Secrets.h"
#include "mozilla/dom/SecretsBinding.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/net/NeckoChild.h"
#include "nsIURI.h"

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
bool Secrets::IsEnabled(JSContext* aCx, JSObject* aGlobal) { return true; }

void Secrets::RegisterNonce(const nsAString& aNonce, const nsAString& aSecret,
                            const nsTArray<nsString>& aMethods,
                            ErrorResult& aRv) {
  BrowsingContext* bc = mParent->GetBrowsingContext();
  if (!bc) {
    aRv.Throw(NS_ERROR_FAILURE);
    return;
  }

  nsCOMPtr<nsIURI> docURI = mParent->GetDocumentURI();
  if (!docURI) {
    aRv.Throw(NS_ERROR_FAILURE);
    return;
  }

  nsAutoCString scheme;
  nsAutoCString host;
  int32_t port = -1;
  docURI->GetScheme(scheme);
  docURI->GetAsciiHost(host);
  docURI->GetPort(&port);
  nsAutoCString origin;
  origin.Assign(scheme);
  origin.AppendLiteral("://");
  origin.Append(host);
  if (port != -1) {
    origin.Append(':');
    origin.AppendInt(port);
  }

  nsTArray<nsCString> methods;
  for (const auto& m : aMethods) {
    methods.AppendElement(NS_ConvertUTF16toUTF8(m));
  }

  if (!mozilla::net::gNeckoChild) {
    aRv.Throw(NS_ERROR_NOT_INITIALIZED);
    return;
  }
  mozilla::net::gNeckoChild->SendAddCredential(
      bc->Id(), NS_ConvertUTF16toUTF8(aNonce), NS_ConvertUTF16toUTF8(aSecret),
      methods, origin);
}

}  // namespace mozilla::dom
