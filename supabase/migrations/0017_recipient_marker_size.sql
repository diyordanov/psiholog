-- ============================================================
-- Миграция 0017: marker_width/marker_height за recipients (Ден 6 hotfix v3)
--
-- Auto-layout на подписващи маркери — owner вече очертава ОБЩА зона (drag
-- правоъгълник) вместо да кликва фиксирана 200×50pt позиция за всеки
-- участник поотделно (виж markerLayout.ts: computeAutoLayoutSlots()).
-- Всеки recipient слот има собствен изчислен размер (зависи от зоната и
-- броя участници) — трябва да се пази в DB, за да го прочете
-- attemptRecipientSign() при реалното подписване (може да се случи дни
-- по-късно, извън контекста на owner-ската сесия, в която е изчислен).
--
-- DEFAULT 200/50 запазва обратна съвместимост с вече съществуващи редове
-- (създадени преди тази миграция) — съвпада с предишните hardcoded
-- MARKER_W/MARKER_H константи в pdfSigner.ts.
-- ============================================================

ALTER TABLE public.signing_request_recipients
  ADD COLUMN marker_width  numeric NOT NULL DEFAULT 200,
  ADD COLUMN marker_height numeric NOT NULL DEFAULT 50;
