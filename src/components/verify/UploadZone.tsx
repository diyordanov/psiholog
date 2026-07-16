/**
 * UploadZone.tsx
 * Drag-and-drop зона за избор на PDF за верификация.
 * Файлът НЕ се качва — верификацията е изцяло в браузъра.
 */
import { useRef, useState, useCallback } from 'react';
import { Upload, FileText } from 'lucide-react';

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

interface Props {
  onFile: (file: File) => void;
  onError: (msg: string) => void;
}

/**
 * Компонент за избор на файл за верификация — чрез drag-and-drop или click.
 * Валидира локално (размер, разширение/MIME) и подава File нагоре чрез onFile;
 * самата верификация се извиква от родителя (VerifyPage), не тук.
 */
export default function UploadZone({ onFile, onError }: Props) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Проверява размер и тип на файла преди да го подаде нагоре.
   * file.type може да е празен низ при drag-and-drop от някои ОС/браузъри,
   * затова fallback-ваме на разширението .pdf.
   */
  const validate = useCallback((file: File): boolean => {
    if (file.size > MAX_BYTES) {
      onError('Файлът е твърде голям (максимум 50 MB).');
      return false;
    }
    const isPdf =
      file.type === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      onError('Файлът не е PDF документ.');
      return false;
    }
    return true;
  }, [onError]);

  /** Общ вход за файлове — от <input type="file"> и от drop събитието. */
  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (validate(file)) onFile(file);
  }, [validate, onFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    // preventDefault спира браузъра да отвори файла директно (default drop поведение).
    e.preventDefault();
    setIsDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  // preventDefault на dragover е задължителен — иначе браузърът никога не позволява drop.
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const onDragLeave = () => setIsDragOver(false);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Зона за плъзгане на PDF файл"
      onClick={() => inputRef.current?.click()}
      onKeyDown={e => e.key === 'Enter' && inputRef.current?.click()}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={`flex cursor-pointer flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-8 py-12 text-center backdrop-blur-xl transition-all select-none
        ${isDragOver
          ? 'scale-[1.01] border-indigo-400 bg-indigo-50/70 shadow-glass'
          : 'border-neutral-300/80 bg-white/50 hover:border-indigo-300 hover:bg-indigo-50/30'
        }`}
    >
      <div className={`rounded-full p-4 ${isDragOver ? 'bg-indigo-100' : 'bg-neutral-100'}`}>
        {isDragOver
          ? <FileText size={32} className="text-indigo-600" />
          : <Upload size={32} className="text-neutral-500" />
        }
      </div>

      <div>
        <p className="text-base font-medium text-neutral-800">
          {isDragOver
            ? 'Пуснете PDF файла тук'
            : <><span className="hidden sm:inline">Плъзнете подписан PDF тук или </span><span className="sm:hidden">Докоснете за да изберете PDF или </span><span className="sm:inline">кликнете за избор</span></>
          }
        </p>
        <p className="mt-1 text-sm text-neutral-500">Максимален размер 50 MB</p>
      </div>

      <p className="text-xs text-neutral-400">
        Файловете не се изпращат никъде — верификацията е изцяло в браузъра ви
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={e => handleFiles(e.target.files)}
      />
    </div>
  );
}
