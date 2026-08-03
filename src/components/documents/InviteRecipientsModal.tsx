/**
 * InviteRecipientsModal.tsx
 * 3-стъпков модал за стартиране на multi-signer заявка (Ден 5, Фаза 8).
 *
 * Стъпки:
 *   1. Recipients   — email адреси на поканените (max 2, MVP ограничение)
 *   2. Positions    — позиция на подписа за owner + всеки recipient (цветни маркери)
 *   3. Confirm+Sign — преглед + owner подписва пръв (signAsOwner)
 *
 * State machine: recipients → positions → confirm → signing → success | error
 *
 * След успешен signAsOwner() праща реални email покани (Ден 7, best-effort —
 * виж sendAllInvitationEmails) до всеки recipient чрез send-invitation-email
 * Edge Function (Resend).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Mail, Trash2, Fingerprint, AlertTriangle, CheckCircle, Users } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { signAsOwner, resolveSigningKeys, type ResolvedKeys, type SigningRequestResult } from '../../lib/signingService';
import { usePrfCeremony, type PrfCeremonyResult } from '../../hooks/usePrfCeremony';
import { getSigningRequestDetails, sendAllInvitationEmails } from '../../lib/signingRequestService';
import { computeAutoLayoutSlots, validateMarkerZone, type MarkerZone, type MarkerSlot } from '../../lib/pdf/markerLayout';
import type { NewRecipientInput } from '../../lib/types';
import {
  clickToMarkerPos, usePdfThumbnail, ModalHeader, ModalFooter, InfoRow,
} from './SignDocumentModal';

// ─── Типове ──────────────────────────────────────────────────────────────────

type Stage = 'recipients' | 'positions' | 'confirm' | 'signing' | 'success' | 'error';

const MAX_RECIPIENTS = 2;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Цветова палитра за участниците — owner + до 2 recipients (споделя accent-ите от DocumentList). */
type ParticipantColor = 'indigo' | 'emerald' | 'amber';
const COLOR_CLASSES: Record<ParticipantColor, { dot: string; badgeActive: string; badgeIdle: string; ring: string }> = {
  indigo:  { dot: 'bg-indigo-600',  badgeActive: 'border-indigo-400 bg-indigo-50 text-indigo-700',   badgeIdle: 'border-neutral-200 text-neutral-600 hover:border-indigo-300',  ring: 'ring-indigo-400' },
  emerald: { dot: 'bg-emerald-600', badgeActive: 'border-emerald-400 bg-emerald-50 text-emerald-700', badgeIdle: 'border-neutral-200 text-neutral-600 hover:border-emerald-300', ring: 'ring-emerald-400' },
  amber:   { dot: 'bg-amber-600',   badgeActive: 'border-amber-400 bg-amber-50 text-amber-700',       badgeIdle: 'border-neutral-200 text-neutral-600 hover:border-amber-300',   ring: 'ring-amber-400' },
};

interface Participant {
  key: string;          // 'owner' или recipient email
  label: string;        // "Дима (Собственик)" / "ivan@x.com (Получател 1)"
  color: ParticipantColor;
}

interface InviteRecipientsModalProps {
  documentId: string;
  storagePath: string;
  filename: string;
  userId: string;
  ownerEmail: string;
  onDone: (recipientCount: number) => void; // затваря + refresh на списъка
  onClose: () => void;                       // откажи
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Валидира нов recipient email спрямо вече добавените + owner-ския. Връща error text или null. */
function validateNewRecipientEmail(
  raw: string, existing: string[], ownerEmail: string,
): string | null {
  const email = raw.trim().toLowerCase();
  if (!email) return 'Въведете email адрес.';
  if (!EMAIL_RE.test(email)) return 'Невалиден email адрес.';
  if (email === ownerEmail.trim().toLowerCase()) return 'Не можете да поканите себе си.';
  if (existing.includes(email)) return 'Този email вече е добавен.';
  if (existing.length >= MAX_RECIPIENTS) return `Максимум ${MAX_RECIPIENTS} участника за MVP.`;
  return null;
}

const SIGNING_STEPS: [number, string][] = [
  [5,  'Проверка на документа'],
  [15, 'Намиране на ключове'],
  [35, 'Биометрична верификация'],
  [55, 'Подписване ECDSA P-256'],
  [70, 'Подписване ML-DSA-65'],
  [85, 'Качване на документа'],
  [100, 'Завършено'],
];

// ─── StepRecipients (Стъпка 1) ────────────────────────────────────────────────

interface StepRecipientsProps {
  recipientEmails: string[];
  error: string | null;
  onAdd: (email: string) => void;
  onRemove: (email: string) => void;
  onNext: () => void;
  onClose: () => void;
}

function StepRecipients({ recipientEmails, error, onAdd, onRemove, onNext, onClose }: StepRecipientsProps) {
  const [input, setInput] = useState('');

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    // Валидацията реално се прилага в родителя (owner email известен там) —
    // тук само подаваме суровия текст и, при успех, изчистваме input-а.
    onAdd(input);
    setInput('');
  };

  return (
    <div>
      <ModalHeader step={1} title="Кого да поканите за подписване?" onClose={onClose} />

      <div className="px-6 py-4 space-y-4">
        <form onSubmit={handleAdd} className="flex gap-2">
          <div className="relative flex-1">
            <Mail size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="email"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="email@example.com"
              className="w-full rounded-xl border border-neutral-200 bg-white/80 py-2 pl-9 pr-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-100"
            />
          </div>
          <button
            type="submit"
            disabled={!input.trim() || recipientEmails.length >= MAX_RECIPIENTS}
            className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Добави
          </button>
        </form>

        {error && (
          <p role="alert" className="text-xs text-red-600">{error}</p>
        )}
        {recipientEmails.length === 0 ? (
          <p className="rounded-lg bg-neutral-50 px-3 py-2.5 text-xs text-neutral-500">
            Добавете до {MAX_RECIPIENTS} участника, които да поканите за подписване.
          </p>
        ) : (
          <ul className="space-y-2">
            {recipientEmails.map((email, i) => (
              <li
                key={email}
                className="flex items-center justify-between gap-2 rounded-xl border border-neutral-200 bg-white/70 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-700">
                  <span className="mr-1.5 text-xs font-medium text-neutral-400">Получател {i + 1}</span>
                  {email}
                </span>
                <button
                  onClick={() => onRemove(email)}
                  aria-label={`Премахни ${email}`}
                  className="shrink-0 rounded-lg p-1 text-neutral-300 transition-colors hover:bg-red-50 hover:text-red-500"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-neutral-400">
          {recipientEmails.length}/{MAX_RECIPIENTS} участника добавени.
        </p>
      </div>

      <ModalFooter
        onBack={onClose}
        backLabel="Откажи"
        onNext={onNext}
        nextLabel="Напред →"
        nextDisabled={recipientEmails.length === 0}
      />
    </div>
  );
}

// ─── StepPositions (Стъпка 2) ──────────────────────────────────────────────────
//
// Owner очертава ЕДНА обща зона (drag правоъгълник) върху документа вместо
// да кликва отделна позиция за всеки участник — системата автоматично
// разделя зоната на N равни хоризонтални слота (computeAutoLayoutSlots),
// по един за всеки участник (owner пръв, после recipients по ред). Слотовете
// по дефиниция не могат да излязат извън зоната → не могат да излязат извън
// страницата (виж markerLayout.ts).

interface StepPositionsProps {
  signedUrl: string | null;
  docId: string;
  participants: Participant[];
  onSlotsChosen: (slots: Record<string, MarkerSlot>) => void;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}

function StepPositions({
  signedUrl, docId, participants, onSlotsChosen, onBack, onNext, onClose,
}: StepPositionsProps) {
  const [currentPage, setCurrentPage] = useState(0);
  const [jumpInput, setJumpInput] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);
  const [dragStartPx, setDragStartPx] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrentPx, setDragCurrentPx] = useState<{ x: number; y: number } | null>(null);
  const [zone, setZone] = useState<MarkerZone | null>(null);

  const { dataUrl, widthPt, heightPt, numPages, loading, error } = usePdfThumbnail(signedUrl, docId, currentPage);

  const getRelPos = (e: React.MouseEvent) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const p = getRelPos(e);
    setDragStartPx(p);
    setDragCurrentPx(p);
    setZone(null);
  };
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragStartPx) return;
    setDragCurrentPx(getRelPos(e));
  };
  const finishDrag = () => {
    if (!dragStartPx || !dragCurrentPx || !overlayRef.current) { setDragStartPx(null); setDragCurrentPx(null); return; }
    const rect = overlayRef.current.getBoundingClientRect();
    const p1 = clickToMarkerPos(dragStartPx.x, dragStartPx.y, rect.width, rect.height, widthPt, heightPt);
    const p2 = clickToMarkerPos(dragCurrentPx.x, dragCurrentPx.y, rect.width, rect.height, widthPt, heightPt);
    setZone({ page: currentPage, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    setDragStartPx(null);
    setDragCurrentPx(null);
  };

  const handleJump = (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseInt(jumpInput, 10);
    if (!isNaN(n) && n >= 1 && n <= numPages) {
      setCurrentPage(n - 1);
      setZone(null);
      setJumpInput('');
    }
  };

  const count = participants.length;
  const zoneError = zone ? validateMarkerZone(zone, count) : null;
  const slots = zone && !zoneError ? computeAutoLayoutSlots(zone, count) : null;
  // BUGFIX (2026-08-01): преди показвахме макс. 3 бутона БЕЗ jump input за
  // документи с >3 страници — страница 4+ беше физически непостижима в
  // multi-signer flow-а (за разлика от single-signer SignDocumentModal.tsx,
  // който винаги е имал jump input). Сега и двата UI-та показват макс. 3
  // бутона + "Отиди на" поле за директен избор на произволна страница.
  const pageButtons = Math.min(numPages, 3);

  const handleNext = () => {
    if (!slots) return;
    const mapping: Record<string, MarkerSlot> = {};
    participants.forEach((p, i) => { mapping[p.key] = slots[i]; });
    onSlotsChosen(mapping);
    onNext();
  };

  return (
    <div>
      <ModalHeader step={2} title="Зона за подписите" onClose={onClose} />

      <div className="px-6 py-4 space-y-4">
        {/* Участници — легенда (не се избират поотделно вече) */}
        <div className="flex flex-wrap gap-2">
          {participants.map(p => {
            const cls = COLOR_CLASSES[p.color];
            return (
              <span key={p.key} className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium ${cls.badgeIdle}`}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${cls.dot}`} aria-hidden="true" />
                {p.label}
              </span>
            );
          })}
        </div>
        <p className="text-xs text-neutral-500">
          Начертайте (влачете с мишката) зона върху документа — системата ще раздели зоната
          автоматично на {count} {count === 1 ? 'място' : 'равни места'} за подписите.
        </p>

        {/* Page selector */}
        {numPages > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-500 shrink-0">Страница:</span>
            {Array.from({ length: pageButtons }, (_, i) => (
              <button
                key={i}
                onClick={() => { setCurrentPage(i); setZone(null); }}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                  currentPage === i
                    ? 'bg-indigo-600 text-white'
                    : 'border border-neutral-200 text-neutral-600 hover:border-indigo-300 hover:text-indigo-600'
                }`}
              >
                {i + 1}
              </button>
            ))}
            {numPages > 3 && (
              <form onSubmit={handleJump} className="flex items-center gap-1.5">
                <span className="text-xs text-neutral-400">или</span>
                <input
                  type="number"
                  min={1}
                  max={numPages}
                  value={jumpInput}
                  onChange={(e) => setJumpInput(e.target.value)}
                  placeholder="страница"
                  className="w-20 rounded-lg border border-neutral-200 px-2 py-1 text-xs focus:border-indigo-400 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:border-indigo-300 hover:text-indigo-600"
                >
                  Отиди
                </button>
              </form>
            )}
          </div>
        )}

        {/* Thumbnail + drag overlay */}
        <div className="relative mx-auto overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 select-none" style={{ width: 300 }}>
          {loading && (
            <div className="flex h-48 items-center justify-center text-neutral-400">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </div>
          )}
          {error && !loading && (
            <div className="flex h-48 items-center justify-center px-4 text-center text-xs text-red-500">{error}</div>
          )}
          {dataUrl && !loading && (
            <>
              <img src={dataUrl} alt={`Страница ${currentPage + 1}`} className="block w-full" draggable={false} />
              <div
                ref={overlayRef}
                className="absolute inset-0 cursor-crosshair"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={finishDrag}
                onMouseLeave={finishDrag}
              />
              {/* Drag-in-progress правоъгълник (сурови пиксели, без нужда от PDF-point конверсия) */}
              {dragStartPx && dragCurrentPx && (
                <div
                  className="pointer-events-none absolute border-2 border-dashed border-indigo-500 bg-indigo-500/10"
                  style={{
                    left: Math.min(dragStartPx.x, dragCurrentPx.x),
                    top: Math.min(dragStartPx.y, dragCurrentPx.y),
                    width: Math.abs(dragCurrentPx.x - dragStartPx.x),
                    height: Math.abs(dragCurrentPx.y - dragStartPx.y),
                  }}
                />
              )}
              {/* Финализирани слотове (auto-layout резултат) */}
              {slots && zone && zone.page === currentPage && participants.map((p, i) => {
                const s = slots[i];
                const cls = COLOR_CLASSES[p.color];
                return (
                  <div
                    key={p.key}
                    className={`pointer-events-none absolute flex items-center justify-center rounded border-2 border-white shadow-md ${cls.dot} bg-opacity-80`}
                    style={{
                      left: `${(s.x / widthPt) * 100}%`,
                      top: `${(1 - (s.y + s.height) / heightPt) * 100}%`,
                      width: `${(s.width / widthPt) * 100}%`,
                      height: `${(s.height / heightPt) * 100}%`,
                    }}
                    title={p.label}
                  >
                    <span className="truncate px-1 text-[9px] font-medium text-white">{i + 1}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {zoneError && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600">
            <AlertTriangle size={12} aria-hidden="true" />
            {zoneError}
          </p>
        )}
        {!zone && !zoneError && (
          <p className="rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
            Влачете с мишката върху документа, за да очертаете зоната за подписите.
          </p>
        )}
        {slots && (
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
            {count} {count === 1 ? 'място' : 'места'} по ~{slots[0]?.width}×{slots[0]?.height}pt, страница {currentPage + 1}.
          </p>
        )}
      </div>

      <ModalFooter
        onBack={onBack}
        backLabel="← Назад"
        onNext={handleNext}
        nextLabel="Напред →"
        nextDisabled={!slots}
      />
    </div>
  );
}

// ─── StepConfirmSign (Стъпка 3) ────────────────────────────────────────────────

interface StepConfirmSignProps {
  filename: string;
  participants: Participant[];
  slots: Record<string, MarkerSlot>;
  preflightKeys: ResolvedKeys | null;
  preflightError: string | null;
  onBack: () => void;
  onSign: () => void;
  signing: boolean;
  progress: number;
  progressLabel: string;
  signError: string | null;
  onRetry: () => void;
  onClose: () => void;
  success: SigningRequestResult | null;
  recipientCount: number;
  emailsSentCount: number | null;
}

function StepConfirmSign({
  filename, participants, slots, preflightKeys, preflightError,
  onBack, onSign, signing, progress, progressLabel, signError, onRetry, onClose,
  success, recipientCount, emailsSentCount,
}: StepConfirmSignProps) {
  const hasNoCert = preflightKeys !== null && preflightKeys.ecdsaData.certificateDer == null;
  const blocked = !!preflightError || hasNoCert;

  if (success) {
    const emailStatus = recipientCount === 0
      ? null
      : emailsSentCount === null
        ? 'Изпращаме покани по email…'
        : emailsSentCount === recipientCount
          ? `Изпратени са ${emailsSentCount} ${emailsSentCount === 1 ? 'покана' : 'покани'} по email.`
          : `Изпратени ${emailsSentCount} от ${recipientCount} покани по email — останалите получатели може да получат линка ръчно.`;

    return (
      <div>
        <ModalHeader step={3} title="Документът е подписан" />
        <div className="px-6 py-5 space-y-2">
          <div role="status" className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5">
            <CheckCircle size={15} className="shrink-0 text-emerald-500" aria-hidden="true" />
            <p className="text-xs font-medium text-emerald-700">Документът е подписан успешно.</p>
          </div>
          {emailStatus && (
            <p className="px-1 text-xs text-neutral-500">{emailStatus}</p>
          )}
        </div>
      </div>
    );
  }

  if (signing || signError) {
    return (
      <div>
        <ModalHeader step={3} title={signError ? 'Грешка' : 'Подписване...'} />
        <div className="px-6 py-5 space-y-5">
          {!signError && (
            <>
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs text-neutral-500">
                  <span>{progressLabel}</span>
                  <span>{progress}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={progressLabel || 'Подписване в процес'}
                  className="h-2 w-full overflow-hidden rounded-full bg-neutral-100"
                >
                  <div className="h-full rounded-full bg-indigo-600 transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
              </div>
              <ol className="space-y-2">
                {SIGNING_STEPS.map(([pct, label]) => {
                  const done = progress >= pct;
                  return (
                    <li key={pct} className={`flex items-center gap-2.5 text-xs ${done ? 'text-neutral-700' : 'text-neutral-400'}`}>
                      {done
                        ? <CheckCircle size={13} className="shrink-0 text-emerald-500" />
                        : <div className="h-3 w-3 shrink-0 rounded-full border border-neutral-300" />}
                      {label}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          {signError && (
            <div className="space-y-3">
              <div role="alert" className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
                <p className="text-xs text-red-700">{signError}</p>
              </div>
              <button
                onClick={onRetry}
                className="w-full rounded-lg border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
              >
                Опитай отново
              </button>
              <button
                onClick={onClose}
                className="w-full rounded-lg border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
              >
                Отказ
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <ModalHeader step={3} title="Прегледайте и подпишете" onClose={onBack} />

      <div className="px-6 py-4 space-y-4">
        <InfoRow label="Документ" value={filename} />

        <div className="space-y-2">
          {participants.map(p => {
            const s = slots[p.key];
            const cls = COLOR_CLASSES[p.color];
            return (
              <div key={p.key} className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-xs">
                <span className={`h-2 w-2 shrink-0 rounded-full ${cls.dot}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-neutral-700">{p.label}</span>
                {s && <span className="shrink-0 text-neutral-400">стр. {s.page + 1}, {s.width}×{s.height}pt</span>}
              </div>
            );
          })}
        </div>

        {preflightError && (
          <div className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
            <p className="text-xs text-red-700">{preflightError}</p>
          </div>
        )}
        {hasNoCert && (
          <div className="flex gap-2 rounded-lg bg-red-50 px-3 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
            <p className="text-xs text-red-700">ECDSA ключът няма сертификат. Отидете в „Ключове" → „Издай сертификат".</p>
          </div>
        )}
        {!blocked && preflightKeys && (
          <div className="flex gap-2 rounded-lg bg-indigo-50 px-3 py-2.5">
            <Fingerprint size={14} className="mt-0.5 shrink-0 text-indigo-500" />
            <p className="text-xs text-indigo-700">
              Браузърът ще поиска биометрично потвърждение след натискане на „Подпиши като собственик".
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-neutral-100/70 px-6 py-4">
        <button
          onClick={onSign}
          disabled={blocked || !preflightKeys}
          className="w-full rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 py-3 text-sm font-medium text-white shadow-[0_4px_14px_-2px_rgba(79,70,229,0.4)] transition-all hover:shadow-[0_6px_20px_-2px_rgba(79,70,229,0.5)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Подпиши като собственик
        </button>
        <button
          onClick={onBack}
          className="mt-2 w-full rounded-xl border border-neutral-200 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
        >
          ← Назад
        </button>
      </div>
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export default function InviteRecipientsModal({
  documentId, storagePath, filename, userId, ownerEmail, onDone, onClose,
}: InviteRecipientsModalProps) {
  const { performCeremony } = usePrfCeremony();
  const [stage, setStage] = useState<Stage>('recipients');
  const [recipientEmails, setRecipientEmails] = useState<string[]>([]);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [slots, setSlots] = useState<Record<string, MarkerSlot>>({});
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  const [preflightKeys, setPreflightKeys] = useState<ResolvedKeys | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [signerName, setSignerName] = useState('');

  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [signError, setSignError] = useState<string | null>(null);
  const [signResult, setSignResult] = useState<SigningRequestResult | null>(null);
  const [emailsSentCount, setEmailsSentCount] = useState<number | null>(null);

  useEffect(() => {
    supabase.storage.from('documents').createSignedUrl(storagePath, 300)
      .then(({ data }) => setSignedUrl(data?.signedUrl ?? null));
  }, [storagePath]);

  const fontBytesRef = useRef<Uint8Array | undefined>(undefined);
  useEffect(() => {
    fetch('/fonts/NotoSans-Regular.ttf')
      .then(r => r.arrayBuffer())
      .then(buf => { fontBytesRef.current = new Uint8Array(buf); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    resolveSigningKeys()
      .then(keys => setPreflightKeys(keys))
      .catch(err => setPreflightError(err instanceof Error ? err.message : String(err)));

    supabase.from('profiles').select('display_name').eq('id', userId).maybeSingle()
      .then(({ data }) => setSignerName(data?.display_name ?? ''));
  }, [userId]);

  const participants: Participant[] = [
    { key: 'owner', label: `${signerName || 'Вие'} (Собственик)`, color: 'indigo' },
    ...recipientEmails.map((email, i): Participant => ({
      key: email,
      label: `${email} (Получател ${i + 1})`,
      color: i === 0 ? 'emerald' : 'amber',
    })),
  ];

  const handleAddRecipient = (raw: string) => {
    const err = validateNewRecipientEmail(raw, recipientEmails, ownerEmail);
    if (err) { setRecipientError(err); return; }
    setRecipientError(null);
    setRecipientEmails(prev => [...prev, raw.trim().toLowerCase()]);
    setSlots({}); // зоната зависи от броя участници — нулираме при промяна на списъка
  };
  const handleRemoveRecipient = (email: string) => {
    setRecipientEmails(prev => prev.filter(e => e !== email));
    setSlots({}); // зоната зависи от броя участници — нулираме при промяна на списъка
  };

  const handleSign = useCallback(async () => {
    if (!preflightKeys) return;
    const ownerSlot = slots['owner'];
    if (!ownerSlot) return;
    setStage('signing');
    setSignError(null);
    setSignResult(null);
    setProgress(0);
    setProgressLabel('');

    const rpId = window.location.hostname;

    // ── PRF ceremony(ies) FIRST (виж usePrfCeremony.ts за iOS-safe ordering) ──
    let ceremony: PrfCeremonyResult;
    try {
      ceremony = await performCeremony(preflightKeys, rpId);
    } catch (err) {
      setSignError(err instanceof Error ? err.message : 'Биометричната верификация неуспешна.');
      return;
    }

    let fontBytes: Uint8Array | undefined = fontBytesRef.current;
    if (!fontBytes) {
      try {
        fontBytes = new Uint8Array(await (await fetch('/fonts/NotoSans-Regular.ttf')).arrayBuffer());
      } catch {
        fontBytes = undefined;
      }
    }

    const recipients: NewRecipientInput[] = recipientEmails.map(email => {
      const s = slots[email];
      return {
        email,
        position: { page: s.page, x: s.x, y: s.y, width: s.width, height: s.height },
      };
    });

    try {
      const result = await signAsOwner(
        documentId, userId, signerName,
        { page: ownerSlot.page, x: ownerSlot.x, y: ownerSlot.y, width: ownerSlot.width, height: ownerSlot.height },
        recipients, rpId, fontBytes,
        ceremony.extractPrf,
        ceremony.extractDualPrf,
        (pct, label) => { setProgress(pct); setProgressLabel(label); },
      );
      setProgress(100);
      setProgressLabel('Завършено');
      setSignResult(result);

      // Изпращаме email покани best-effort (Ден 7) — не блокира success екрана,
      // не отменя вече създадената заявка при неуспех (recipient-ите могат
      // все пак да получат линка ръчно, виж PendingInvitationsPage).
      if (recipientEmails.length > 0) {
        getSigningRequestDetails(result.signingRequestId)
          .then(({ recipients }) => sendAllInvitationEmails(
            recipients.map(r => ({ id: r.id, invited_email: r.invited_email })),
          ))
          .then(setEmailsSentCount)
          .catch(err => {
            console.error('Изпращане на email покани неуспешно:', err);
            setEmailsSentCount(0);
          });
      }

      // Auto-close след 2 сек.
      setTimeout(() => onDone(recipientEmails.length), 2000);
    } catch (err) {
      setSignError(err instanceof Error ? err.message : String(err));
    }
  }, [preflightKeys, slots, documentId, userId, signerName, recipientEmails, onDone, performCeremony]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-modal-title"
        className="animate-scaleIn glass-panel w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl shadow-glassLg"
      >
        <p id="invite-modal-title" className="flex items-center gap-1.5 px-6 pt-4 text-xs font-medium text-neutral-400 tracking-wide uppercase truncate">
          <Users size={12} aria-hidden="true" /> {filename}
        </p>

        {stage === 'recipients' && (
          <StepRecipients
            recipientEmails={recipientEmails}
            error={recipientError}
            onAdd={handleAddRecipient}
            onRemove={handleRemoveRecipient}
            onNext={() => setStage('positions')}
            onClose={onClose}
          />
        )}

        {stage === 'positions' && (
          <StepPositions
            signedUrl={signedUrl}
            docId={documentId}
            participants={participants}
            onSlotsChosen={setSlots}
            onBack={() => setStage('recipients')}
            onNext={() => setStage('confirm')}
            onClose={onClose}
          />
        )}

        {(stage === 'confirm' || stage === 'signing' || stage === 'success' || stage === 'error') && (
          <StepConfirmSign
            filename={filename}
            participants={participants}
            slots={slots}
            preflightKeys={preflightKeys}
            preflightError={preflightError}
            onBack={() => setStage('positions')}
            onSign={handleSign}
            signing={stage === 'signing' && !signResult}
            progress={progress}
            progressLabel={progressLabel}
            signError={signError}
            onRetry={() => setStage('confirm')}
            onClose={onClose}
            success={signResult}
            recipientCount={recipientEmails.length}
            emailsSentCount={emailsSentCount}
          />
        )}
      </div>
    </div>
  );
}
