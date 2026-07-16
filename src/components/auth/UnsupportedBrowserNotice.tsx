/**
 * Съобщение, показвано вместо auth формите, когато браузърът/устройството
 * не поддържа WebAuthn passkeys (виж isPasskeySupported() в lib/webauthnSupport).
 * Чисто презентационен компонент — без state и логика.
 */
export default function UnsupportedBrowserNotice() {
  return (
    <div className="rounded-2xl border border-amber-200/70 bg-amber-50/80 p-5 text-amber-900 shadow-sm backdrop-blur-sm">
      <p className="font-semibold">Браузърът ти не поддържа passkeys</p>
      <p className="mt-1.5 text-sm leading-relaxed">
        За регистрация и вход е нужен съвременен браузър (Chrome, Edge, Firefox или Safari)
        на устройство с Windows Hello, Touch ID, Face ID или security key, през HTTPS връзка.
      </p>
    </div>
  );
}
