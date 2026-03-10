[SecureContext, Exposed=Window]
interface Secrets {
  [Throws]
  undefined registerNonce(DOMString nonce, DOMString secret);
};
