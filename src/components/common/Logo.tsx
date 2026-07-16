/**
 * Logo.tsx
 * Единна марка на SignShield — градиентен badge с иконата Shield + име.
 * Използва се навсякъде вместо ad-hoc Shield/ShieldCheck икони, за да
 * изглежда марката еднакво в auth екраните, verify страницата и главния shell.
 */
import { Shield } from 'lucide-react';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  withLabel?: boolean;
  labelClassName?: string;
}

const SIZE_MAP = {
  sm: { badge: 'h-8 w-8', icon: 16, text: 'text-base' },
  md: { badge: 'h-9 w-9', icon: 19, text: 'text-lg' },
  lg: { badge: 'h-11 w-11', icon: 24, text: 'text-xl' },
};

export default function Logo({ size = 'md', withLabel = true, labelClassName = '' }: LogoProps) {
  const s = SIZE_MAP[size];
  return (
    <div className="flex items-center gap-2.5">
      <div
        className={`flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-700 shadow-[0_4px_14px_-2px_rgba(79,70,229,0.5)] ${s.badge}`}
      >
        <Shield size={s.icon} className="text-white" strokeWidth={2.2} aria-hidden="true" />
      </div>
      {withLabel && (
        <span className={`font-semibold tracking-tight text-neutral-900 ${s.text} ${labelClassName}`}>
          SignShield
        </span>
      )}
    </div>
  );
}
