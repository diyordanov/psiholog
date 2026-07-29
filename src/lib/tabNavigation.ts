/**
 * tabNavigation.ts
 * Споделено между App.tsx (MainApp таб state) и standalone route компоненти
 * (RecipientSigningModal, достъпен от /invite/ — route без таб навигация),
 * за да могат тези компоненти да заявят "отвори конкретен таб" при следващото
 * зареждане на MainApp, без circular import към App.tsx самия.
 */

export type ActiveTab = 'documents' | 'keys' | 'invitations' | 'verify' | 'how-it-works';

export const VALID_TABS: ActiveTab[] = ['documents', 'keys', 'invitations', 'verify', 'how-it-works'];

/**
 * Ключ в sessionStorage за "отвори директно този таб при следващото зареждане".
 * sessionStorage (не URL query param) е нарочен избор — устойчив е на
 * редиректи, history replace-и и презареждания по средата на auth/passkey
 * проверките, докато query string зависи от прецизно запазване на URL-а през
 * целия loading flow.
 */
const OPEN_TAB_STORAGE_KEY = 'signshield_open_tab';

/** Заявява отваряне на конкретен таб при следващото зареждане на MainApp. */
export function requestOpenTab(tab: ActiveTab): void {
  sessionStorage.setItem(OPEN_TAB_STORAGE_KEY, tab);
}

/**
 * Прочита + ИЗТРИВА заявения таб от sessionStorage (еднократно — иначе
 * последващи презареждания/навигации винаги биха връщали на същия таб).
 * Функция (не inline) за useState initializer в MainApp.
 */
export function initialTabFromRequest(): ActiveTab {
  const tab = sessionStorage.getItem(OPEN_TAB_STORAGE_KEY);
  sessionStorage.removeItem(OPEN_TAB_STORAGE_KEY);
  return (VALID_TABS as string[]).includes(tab ?? '') ? (tab as ActiveTab) : 'documents';
}
