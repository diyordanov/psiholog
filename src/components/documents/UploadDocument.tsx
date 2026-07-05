/**
 * UploadDocument.tsx
 * Drag-and-drop зона за качване на PDF документи.
 *
 * Pipeline при избор на файл:
 *   validating → scanning → hashing → uploading (с % progress bar) → done
 *
 * Всяка стъпка показва съответен текст. При грешка на всяка стъпка
 * се показва съобщение с X бутон за нулиране.
 */
import { useState, useRef, useCallback } from 'react';
import { Upload, FileText, X, AlertTriangle } from 'lucide-react';
import { scanPdf } from '../../lib/pdfSanitizer';
import { uploadDocument } from '../../lib/documentUpload';

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB — лимит на Storage bucket-а

/** Стъпките в процеса на качване. */
type UploadStage =
  | 'idle'       // изчакваме избор на файл
  | 'validating' // проверка на MIME тип и размер
  | 'scanning'   // PDF sanitization (сканиране за опасни елементи)
  | 'hashing'    // изчисляване на SHA-256 хеш
  | 'uploading'  // XHR upload в Supabase Storage (с реален % прогрес)
  | 'saving'     // INSERT в базата данни
  | 'done'       // успех
  | 'error';     // грешка на някоя от предните стъпки

interface UploadDocumentProps {
  userId: string;
  /** Извиква се след успешно качване — родителят трябва да презареди списъка с документи. */
  onUploaded: () => void;
}

export default function UploadDocument({ userId, onUploaded }: UploadDocumentProps) {
  const [stage, setStage] = useState<UploadStage>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState(0); // процент за progress bar (0–100)
  const inputRef = useRef<HTMLInputElement>(null);

  /** Текстове, показвани на потребителя за всяка стъпка. */
  const stageLabels: Record<UploadStage, string> = {
    idle: '',
    validating: 'Проверяваме файла...',
    scanning: 'Проверяваме за безопасност...',
    hashing: 'Изчисляваме хеш...',
    uploading: 'Качваме...',
    saving: 'Запазваме...',
    done: 'Качено успешно!',
    error: '',
  };

  /** Нулира всички state-ове до начална позиция (след грешка или успех). */
  const reset = () => {
    setStage('idle');
    setErrorMessage(null);
    setSelectedFile(null);
    setUploadPct(0);
    if (inputRef.current) inputRef.current.value = '';
  };

  /**
   * Основният pipeline при избор на файл.
   * Извиква се и при drag & drop, и при натискане на browse бутона.
   * Обгърнато в useCallback за да не се предава нова референция при всеки render.
   */
  const processFile = useCallback(async (file: File) => {
    setErrorMessage(null);
    setSelectedFile(file);

    // ── Стъпка 1: Валидация на MIME тип и размер ────────────────────────────
    setStage('validating');
    if (file.type !== 'application/pdf') {
      setErrorMessage('Само PDF файлове са разрешени.');
      setStage('error');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setErrorMessage(`Файлът е по-голям от 25 MB (${(file.size / 1024 / 1024).toFixed(1)} MB).`);
      setStage('error');
      return;
    }

    // ── Стъпка 2: Четем файла в памет ───────────────────────────────────────
    // Нужно и за PDF scan, и за SHA-256 хеша — четем веднъж, ползваме двукратно.
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      setErrorMessage('Неуспешно четене на файла.');
      setStage('error');
      return;
    }

    // ── Стъпка 3: PDF Sanitization ──────────────────────────────────────────
    setStage('scanning');
    const { safe, threats } = scanPdf(buffer);
    if (!safe) {
      setErrorMessage(
        `Документът е отхвърлен — открити опасни елементи:\n• ${threats.join('\n• ')}`
      );
      setStage('error');
      return;
    }

    // ── Стъпка 4: SHA-256 хеш + Upload ──────────────────────────────────────
    setStage('hashing');
    // Малка пауза за да успее React да рендира новото stage преди CPU-bound hash операцията.
    await new Promise((r) => setTimeout(r, 50));

    setStage('uploading');
    setUploadPct(0);
    try {
      // onProgress callback обновява progress bar-а в реално време чрез XHR events.
      await uploadDocument(file, buffer, userId, (pct) => setUploadPct(pct));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Неизвестна грешка при качване.');
      setStage('error');
      return;
    }

    setStage('done');
    // Кратко забавяне за да види потребителят "Качено успешно!" преди нулиране.
    setTimeout(() => {
      reset();
      onUploaded();
    }, 1500);
  }, [userId, onUploaded]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  // true докато pipeline-ът е в ход — блокираме нови избори на файл
  const isBusy = !['idle', 'error', 'done'].includes(stage);

  return (
    <div className="w-full">
      {/* ── Drag & Drop зона ────────────────────────────────────────────────── */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !isBusy && inputRef.current?.click()}
        className={`
          relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed
          px-6 py-10 text-center transition-colors
          ${isBusy ? 'cursor-default' : 'cursor-pointer'}
          ${isDragOver
            ? 'border-indigo-400 bg-indigo-50'
            : 'border-neutral-200 bg-neutral-50 hover:border-indigo-300 hover:bg-indigo-50/40'
          }
        `}
      >
        {/* Скрит file input — задейства се при клик върху зоната */}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={handleFileChange}
          disabled={isBusy}
        />

        {/* Икона */}
        <div className={`rounded-full p-3 ${isDragOver ? 'bg-indigo-100' : 'bg-neutral-100'}`}>
          {stage === 'done'
            ? <FileText size={24} className="text-indigo-600" />
            : <Upload size={24} className={isDragOver ? 'text-indigo-600' : 'text-neutral-400'} />
          }
        </div>

        {/* Начален текст */}
        {stage === 'idle' && (
          <>
            <p className="text-sm font-medium text-neutral-700">
              Влачете PDF тук или{' '}
              <span className="text-indigo-700 underline underline-offset-2">изберете файл</span>
            </p>
            <p className="text-xs text-neutral-400">Само PDF · максимум 25 MB</p>
          </>
        )}

        {/* Прогрес при активен pipeline */}
        {isBusy && (
          <div className="flex w-full flex-col items-center gap-2">
            <p className="text-sm text-neutral-600">{stageLabels[stage]}</p>
            {selectedFile && (
              <p className="max-w-full truncate text-xs text-neutral-400">{selectedFile.name}</p>
            )}
            {/* При uploading — реален progress bar; при останалите стъпки — анимирани точки */}
            {stage === 'uploading' ? (
              <div className="w-full max-w-xs">
                <div className="mb-1 flex justify-between text-xs text-neutral-400">
                  <span>Качване...</span>
                  <span>{uploadPct}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
                  <div
                    className="h-full rounded-full bg-indigo-500 transition-all duration-150"
                    style={{ width: `${uploadPct}%` }}
                  />
                </div>
              </div>
            ) : (
              <ProgressDots />
            )}
          </div>
        )}

        {stage === 'done' && (
          <p className="text-sm font-medium text-indigo-700">Качено успешно!</p>
        )}
      </div>

      {/* ── Съобщение за грешка ─────────────────────────────────────────────── */}
      {stage === 'error' && errorMessage && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
          <div className="flex-1">
            {/* whitespace-pre-line запазва \n от threats списъка */}
            <p className="whitespace-pre-line text-sm text-red-700">{errorMessage}</p>
          </div>
          <button onClick={reset} className="shrink-0 text-red-400 hover:text-red-600">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Три анимирани точки, показвани при бавни стъпки без измерим прогрес. */
function ProgressDots() {
  return (
    <div className="flex gap-1">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-400"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  );
}
