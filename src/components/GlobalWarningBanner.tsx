import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

const LIMIT_YEAR = 2026;
const LIMIT_MONTH = 7;
const LIMIT_DAY = 14;

export function GlobalWarningBanner() {
  const bannerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateHeight = () => {
      const height = bannerRef.current?.getBoundingClientRect().height || 0;
      document.documentElement.style.setProperty('--banner-height', `${height}px`);
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    if (bannerRef.current) {
      observer.observe(bannerRef.current);
    }

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--banner-height');
    };
  }, []);

  const getTimingText = () => {
    const today = new Date();
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const targetDate = new Date(LIMIT_YEAR, LIMIT_MONTH, LIMIT_DAY);
    const diffMs = targetDate.getTime() - todayMidnight.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays <= 0) {
      return 'hoje é o último dia';
    }
    if (diffDays === 1) {
      return 'amanhã';
    }
    return `em ${diffDays} dias`;
  };

  const timingText = getTimingText();

  return (
    <div
      ref={bannerRef}
      className="fixed top-0 left-0 right-0 z-[90] w-full h-[56px] md:h-[44px] bg-[#DC2626] text-white flex items-center justify-center px-4 shadow-sm"
    >
      <div className="flex items-center justify-center gap-4 md:gap-6 text-center">
        <div className="flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-white shrink-0" />
          <span className="text-[14px] font-semibold text-white leading-none whitespace-nowrap">
            <span className="inline md:hidden">
              ⚠️ Floow descontinuado <strong className="font-bold">{timingText}</strong>
            </span>
            <span className="hidden md:inline">
              ⚠️ O Floow será descontinuado <strong className="font-bold">{timingText}</strong> — migre para a nova versão sem perder nenhum dado.
            </span>
          </span>
        </div>

        <a
          href="https://wa.me/5519993929168?text=Ol%C3%A1%2C%20quero%20garantir%20a%20migra%C3%A7%C3%A3o%20do%20meu%20Floow"
          target="_blank"
          rel="noopener noreferrer"
          className="h-[30px] flex items-center justify-center shrink-0 bg-white text-[#DC2626] font-bold text-[13px] px-[14px] rounded-[6px] hover:bg-white/95 active:scale-[0.97] transition-all duration-160 shadow"
        >
          <span className="inline md:hidden">WhatsApp</span>
          <span className="hidden md:inline">Falar no WhatsApp</span>
        </a>
      </div>
    </div>
  );
}
