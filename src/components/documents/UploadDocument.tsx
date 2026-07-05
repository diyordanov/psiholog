import { useState, useRef, useCallback } from 'react';
import { Upload, FileText, X, AlertTriangle } from 'lucide-react';
import { scanPdf } from '../../lib/pdfSanitizer';
import { uploadDocument } from '../../lib/documentUpload';

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

type UploadStage =
  | 'idle'
  | 'validating'
  | 'scanning'
  | 'hashing'
  | 'uploading'
  | 'saving'
  | 'done'
  | 'error';

interface UploadDocumentProps {
  userId: string;
  onUploaded: () => void; // извиква се след успешно качване — родителят презарежда списъка
}

export default function UploadDocument({ userId, onUploaded }: UploadDocumentProps) {
  const [stage, setStage] = useState<UploadStage>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const reset = () => {
    setStage('idle');
    setErrorMessage(null);
    setSelectedFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const processFile = useCallback(async (file: File) => {
    setErrorMessage(null);
    setSelectedFile(file);

    // 1. Валидация на тип и размер
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

    // 2. Прочитаме файла
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      setErrorMessage('Неуспешно четене на файла.');
      setStage('error');
      return;
    }

    // 3. PDF Sanitization
    setStage('scanning');
    const { safe, threats } = scanPdf(buffer);
    if (!safe) {
      setErrorMessage(
        `Документът е отхвърлен — открити опасни елементи:\n• ${threats.join('\n• ')}`
      );
      setStage('error');
      return;
    }

    // 4. Hash + Upload
    setStage('hashing');
    await new Promise((r) => setTimeout(r, 50)); // позволяваме UI да се обнови

    setStage('uploading');
    try {
      await uploadDocument(file, buffer, userId);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Неизвестна грешка при качване.');
      setStage('error');
      return;
    }

    setStage('done');
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

  const isBusy = !['idle', 'error', 'done'].includes(stage);

  return (
    <div className="w-full">
      {/* Drag & Drop зона */}
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

        {/* Текст */}
        {stage === 'idle' && (
          <>
            <p className="text-sm font-medium text-neutral-700">
              Влачете PDF тук или{' '}
              <span className="text-indigo-700 underline underline-offset-2">изберете файл</span>
            </p>
            <p className="text-xs text-neutral-400">Само PDF · максимум 25 MB</p>
          </>
        )}

        {isBusy && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-neutral-600">{stageLabels[stage]}</p>
            {selectedFile && (
              <p className="text-xs text-neutral-400">{selectedFile.name}</p>
            )}
            <ProgressDots />
          </div>
        )}

        {stage === 'done' && (
          <p className="text-sm font-medium text-indigo-700">Качено успешно!</p>
        )}
      </div>

      {/* Грешка */}
      {stage === 'error' && errorMessage && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
          <div className="flex-1">
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
