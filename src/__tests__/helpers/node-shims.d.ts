/**
 * node-shims.d.ts
 * Минимални ambient типове за Node built-ins, ползвани САМО в тестови helpers
 * (signingFixtures.ts, за четене на public/fonts/NotoSans-Regular.ttf от диск).
 * Проектът няма @types/node в tsconfig.app.json (браузърен build, виж bugfix
 * бележката в supabase.ts за globalThis process cast pattern) — вместо да
 * добавяме глобална Node type зависимост за целия app build, декларираме тук
 * само двете нужни функции, скопирано за тестовете.
 */
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
}
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
