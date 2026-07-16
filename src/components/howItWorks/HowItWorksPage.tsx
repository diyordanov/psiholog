/**
 * HowItWorksPage.tsx
 * Обяснителна страница за платформата — какво е SignShield и как се използва.
 * Чисто презентационен компонент, без собствено състояние или мрежови заявки.
 */
import {
  Fingerprint,
  UploadCloud,
  FileSignature,
  ShieldCheck,
  KeyRound,
  ScanLine,
  Lock,
  Sparkles,
} from 'lucide-react';

const STEPS: {
  icon: React.ReactNode;
  title: string;
  description: string;
  accent: string;
}[] = [
  {
    icon: <Fingerprint size={22} />,
    title: 'Регистрирайте се с passkey',
    description:
      'Без пароли за запомняне. Влизате с биометрия или PIN на устройството си — частният ключ никога не напуска телефона или компютъра ви.',
    accent: 'bg-indigo-50 text-indigo-600',
  },
  {
    icon: <UploadCloud size={22} />,
    title: 'Качете вашия документ',
    description:
      'Прикачвате PDF файл от "Моите документи". Файлът се съхранява криптирано и е достъпен само за вас.',
    accent: 'bg-sky-50 text-sky-600',
  },
  {
    icon: <FileSignature size={22} />,
    title: 'Подпишете с един жест',
    description:
      'При подписване се генерира криптографски подпис (PAdES-B), обвързан с вашия passkey и издаден сертификат — правно валиден и съвместим с Adobe Reader.',
    accent: 'bg-violet-50 text-violet-600',
  },
  {
    icon: <ScanLine size={22} />,
    title: 'Споделете и проверете',
    description:
      'Всеки подписан документ получава линк за независима проверка — получателят вижда веднага дали подписът е валиден, без нужда от акаунт.',
    accent: 'bg-emerald-50 text-emerald-600',
  },
];

const FEATURES: { icon: React.ReactNode; title: string; description: string }[] = [
  {
    icon: <KeyRound size={18} />,
    title: 'Passwordless по дизайн',
    description: 'Passkey замества паролата напълно — устойчив на фишинг и кражба на данни.',
  },
  {
    icon: <ShieldCheck size={18} />,
    title: 'Пост-квантова криптография',
    description: 'Ed25519 и ML-DSA-65 — сигурни днес и подготвени за квантовите заплахи на утрешния ден.',
  },
  {
    icon: <Lock size={18} />,
    title: 'Верижна проверимост',
    description: 'Всеки сертификат може да бъде проверен независимо, без да разчита на нашите сървъри.',
  },
];

export default function HowItWorksPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      {/* Hero */}
      <div className="animate-fadeIn mb-12 text-center">
        <div className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-indigo-50/80 px-3 py-1 text-xs font-medium text-indigo-700 shadow-sm backdrop-blur-sm">
          <Sparkles size={13} />
          Как работи SignShield
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 sm:text-3xl">
          Електронно подписване, обяснено просто
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-500 sm:text-base">
          От регистрация до правно валиден подпис — четири стъпки, без пароли и без сложност.
        </p>
      </div>

      {/* Стъпки */}
      <div className="relative mb-14">
        <div
          aria-hidden="true"
          className="absolute left-[27px] top-2 hidden h-[calc(100%-2rem)] w-px bg-neutral-200 sm:block"
        />
        <div className="flex flex-col gap-6">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="animate-fadeInUp relative flex gap-4 opacity-0 sm:gap-5"
              style={{ animationDelay: `${i * 120}ms` }}
            >
              <div className="relative z-10 flex shrink-0 flex-col items-center">
                <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ring-4 ring-white ${step.accent}`}>
                  {step.icon}
                </div>
              </div>
              <div className="glass-panel min-w-0 flex-1 rounded-2xl px-5 py-4 transition-shadow hover:shadow-glassLg">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-neutral-300">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="text-sm font-medium text-neutral-800 sm:text-base">{step.title}</h3>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-neutral-500">{step.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Защо да имаме доверие */}
      <div
        className="animate-fadeInUp relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#211d5e] via-[#1e1b4b] to-[#151235] px-6 py-8 opacity-0 shadow-glassLg sm:px-10"
        style={{ animationDelay: '520ms' }}
      >
        <div aria-hidden="true" className="animate-floatSlow absolute -right-16 -top-20 h-64 w-64 rounded-full bg-indigo-500/25 blur-3xl" />
        <div
          aria-hidden="true"
          className="animate-floatSlow absolute -bottom-24 -left-10 h-72 w-72 rounded-full bg-violet-500/20 blur-3xl"
          style={{ animationDelay: '1.5s' }}
        />
        <h2 className="relative text-center text-lg font-medium text-indigo-100">
          Защо можете да разчитате на подписа
        </h2>
        <div className="relative mt-7 grid gap-6 sm:grid-cols-3">
          {FEATURES.map((feature, i) => (
            <div
              key={feature.title}
              className="animate-scaleIn opacity-0"
              style={{ animationDelay: `${600 + i * 100}ms` }}
            >
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-indigo-300 backdrop-blur-sm">
                {feature.icon}
              </div>
              <p className="text-sm font-medium text-indigo-100">{feature.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-indigo-300">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
