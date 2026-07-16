/**
 * Съобщение, показвано вместо auth формите, когато браузърът/устройството
 * не поддържа WebAuthn passkeys (виж isPasskeySupported() в lib/webauthnSupport).
 * Чисто презентационен компонент — без state и логика.
 */
export default function UnsupportedBrowserNotice() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
      <p className="font-semibold">Браузърът ти не поддържа passkeys</p>
      <p className="mt-1 text-sm">
        За регистрация и вход е нужен съвременен браузър (Chrome, Edge, Firefox или Safari)
        на устройство с Windows Hello, Touch ID, Face ID или security key, през HTTPS връзка.
      </p>
    </div>
  );
}
