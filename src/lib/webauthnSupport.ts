// supabase-js не експортира своята вътрешна browserSupportsWebAuthn() проверка
// (lib/webauthn.js не е част от публичния API), затова повтаряме същата логика тук —
// иначе бихме показали грешен резултат при браузъри без navigator.credentials.
export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'PublicKeyCredential' in window &&
    'credentials' in navigator &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}
