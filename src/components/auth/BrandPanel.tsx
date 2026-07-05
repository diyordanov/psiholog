import { Fingerprint, FileSignature, ShieldCheck, Check } from 'lucide-react';

interface BrandPanelProps {
  variant: 'login' | 'signup';
}

export default function BrandPanel({ variant }: BrandPanelProps) {
  return (
    <div className="flex h-full flex-col justify-between bg-[#1e1b4b] px-10 py-10 xl:px-14">
      {variant === 'login' ? <LoginContent /> : <SignupContent />}
      <p className="text-xs text-indigo-500">Курсова работа · ТУ - София · 2026</p>
    </div>
  );
}

function LoginContent() {
  return (
    <div>
      <h2 className="text-lg font-medium leading-snug text-indigo-100">
        Електронно подписване с пост-квантова сигурност
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-indigo-300">
        Подписвайте PDF документи с криптографски п��дписи от следващо поколение.
      </p>
      <div className="mt-10 flex flex-col gap-7">
        <FeatureItem
          icon={<Fingerprint size={18} />}
          title="Passwordless вход"
          subtitle="Passkey / биометрия"
        />
        <FeatureItem
          icon={<FileSignature size={18} />}
          title="PAdES-B подпис"
          subtitle="Adobe Reader съвместим"
        />
        <FeatureItem
          icon={<ShieldCheck size={18} />}
          title="Пост-квантова крипто"
          subtitle="Ed25519 + ML-DSA"
        />
      </div>
    </div>
  );
}

function SignupContent() {
  return (
    <div>
      <h2 className="text-lg font-medium leading-snug text-indigo-100">Защо passkey?</h2>
      <p className="mt-3 text-sm leading-relaxed text-indigo-300">
        Без пароли за помнене, без риск от phishing.
      </p>
      <div className="mt-10 flex flex-col gap-5">
        <BulletItem text="Частният ключ никога не напуска вашето устройство" />
        <BulletItem text="Влизате с биометрия или PIN на устройството" />
        <BulletItem text="Резистентен на phishing и credential stuffing атаки" />
      </div>
      <p className="mt-10 text-xs text-indigo-400">
        Съвместимо с Chrome, Firefox, Safari
      </p>
    </div>
  );
}

function FeatureItem({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0 text-indigo-400">{icon}</div>
      <div>
        <p className="text-sm font-medium text-indigo-100">{title}</p>
        <p className="mt-0.5 text-xs text-indigo-400">{subtitle}</p>
      </div>
    </div>
  );
}

function BulletItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0 rounded-full bg-indigo-700 p-0.5 text-indigo-200">
        <Check size={12} />
      </div>
      <p className="text-sm leading-relaxed text-indigo-200">{text}</p>
    </div>
  );
}
