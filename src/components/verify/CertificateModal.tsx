/**
 * CertificateModal.tsx
 * Показва пълни X.509 детайли на leaf сертификата (subject, issuer, дати, алгоритъм).
 * Ползва @peculiar/x509 за парсиране на DER.
 */
import * as x509 from '@peculiar/x509';
import { X } from 'lucide-react';

interface Props {
  certDer: Uint8Array;
  onClose: () => void;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('bg-BG', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'UTC',
  }) + ' г.';
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 py-2 border-b border-neutral-100 last:border-0">
      <dt className="text-xs font-medium text-neutral-500">{label}</dt>
      <dd className="text-xs text-neutral-800 break-all font-mono">{value}</dd>
    </div>
  );
}

export default function CertificateModal({ certDer, onClose }: Props) {
  let cert: x509.X509Certificate;
  try {
    cert = new x509.X509Certificate(certDer as unknown as Uint8Array<ArrayBuffer>);
  } catch {
    return (
      <Overlay onClose={onClose}>
        <p className="text-sm text-red-600">Не може да се прочете сертификатът.</p>
      </Overlay>
    );
  }

  const sigAlg = cert.signatureAlgorithm as { name?: string; hash?: { name?: string } } | null;
  const sigAlgStr = sigAlg?.name
    ? `${sigAlg.name}${sigAlg.hash?.name ? ` / ${sigAlg.hash.name}` : ''}`
    : '—';

  return (
    <Overlay onClose={onClose}>
      <dl>
        <Row label="Subject" value={cert.subject} />
        <Row label="Издател" value={cert.issuer} />
        <Row label="Сериен номер" value={cert.serialNumber} />
        <Row label="Валиден от" value={fmtDate(cert.notBefore)} />
        <Row label="Валиден до" value={fmtDate(cert.notAfter)} />
        <Row label="Алгоритъм" value={sigAlgStr} />
        <Row label="DER размер" value={`${certDer.length} байта`} />
      </dl>
    </Overlay>
  );
}

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4 shrink-0">
          <h3 className="text-sm font-semibold text-neutral-800">Детайли на сертификата</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-2.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
            aria-label="Затвори"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
