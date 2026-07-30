'use client';

/**
 * 愷樂生醫 — Premium Hero Banner（Next.js + TailwindCSS + Framer Motion）
 * ---------------------------------------------------------------------------
 * ● 8 個獨立圖層，皆用 CSS Transform / opacity（GPU 加速）；無 GIF / Video / Canvas
 * ● 產品海報 = 原圖，固定不變形（僅淡入）；動效全部在周圍程式圖層
 * ● 滑鼠視差、捲動縮小、晨光掃過、微塵、光影高光、prefers-reduced-motion
 *
 * 使用方式：
 *   1) npm i framer-motion
 *   2) 把 gaba-box.jpg 放到  public/products/gaba-box.jpg
 *      把 logo.svg     放到  public/logo.svg
 *   3) import HeroBanner from '@/components/HeroBanner'
 *      <HeroBanner />
 *   4) Tailwind：專案已含 Tailwind 即可（此元件只用到 flex/grid/spacing 等基礎類別）
 */

import Image from 'next/image';
import { useRef } from 'react';
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useScroll,
  useReducedMotion,
} from 'framer-motion';

export default function HeroBanner() {
  const reduce = useReducedMotion();
  const heroRef = useRef(null);

  /* ── 滑鼠視差：pointer → -1..1 → spring ── */
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 120, damping: 20, mass: 0.4 });
  const sy = useSpring(my, { stiffness: 120, damping: 20, mass: 0.4 });

  const onPointerMove = (e) => {
    if (reduce) return;
    const r = heroRef.current.getBoundingClientRect();
    mx.set(((e.clientX - r.left) / r.width - 0.5) * 2);
    my.set(((e.clientY - r.top) / r.height - 0.5) * 2);
  };
  const onPointerLeave = () => { mx.set(0); my.set(0); };

  /* 每層不同視差量（產品層 = 0，完全固定） */
  const l1x = useTransform(sx, (v) => v * -14), l1y = useTransform(sy, (v) => v * -10);
  const l2x = useTransform(sx, (v) => v * -26), l2y = useTransform(sy, (v) => v * -14);
  const l3x = useTransform(sx, (v) => v * 18),  l3y = useTransform(sy, (v) => v * 12);
  const l4x = useTransform(sx, (v) => v * 10),  l4y = useTransform(sy, (v) => v * 8);

  /* ── 捲動：Hero 內容縮小淡出、背景放大 ── */
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const wrapScale = useTransform(scrollYProgress, [0, 1], [1, 0.94]);
  const wrapOpacity = useTransform(scrollYProgress, [0, 1], [1, 0.1]);
  const bgScale = useTransform(scrollYProgress, [0, 1], [1, 1.12]);
  const cueOpacity = useTransform(scrollYProgress, [0, 0.3], [1, 0]);

  /* ── 進場 stagger ── */
  const container = { hidden: {}, show: { transition: { staggerChildren: 0.11, delayChildren: 0.05 } } };
  const rise = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { duration: 0.9, ease: [0.2, 0.7, 0.25, 1] } },
  };
  const motes = Array.from({ length: 16 }, (_, i) => ({
    id: i, size: 2 + ((i * 37) % 40) / 10, left: (i * 61) % 100,
    top: 30 + ((i * 43) % 70), dur: 8 + ((i * 29) % 100) / 10, delay: -((i * 53) % 100) / 10,
  }));

  return (
    <section
      ref={heroRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      aria-label="愷樂生醫 GABA 鈣鎂晶凍"
      className="relative w-full min-h-[100svh] flex items-center overflow-hidden isolate"
      style={{ background: 'radial-gradient(120% 90% at 78% 18%, #FFFDF6 0%, #FBF6EA 34%, #F6EFDC 68%, #F0E6CC 100%)' }}
    >
      {/* LAYER 1 · 背景暖色晨光 */}
      <motion.div aria-hidden className="pointer-events-none absolute -inset-[8%] z-[1]"
        style={{
          x: l1x, y: l1y, scale: bgScale,
          background:
            'radial-gradient(38% 46% at 80% 12%,rgba(255,247,225,.95),rgba(255,247,225,0) 70%),radial-gradient(50% 55% at 88% 30%,rgba(200,162,77,.16),rgba(200,162,77,0) 70%)',
        }} />

      {/* LAYER 2 · 窗光斜射（緩慢掃過） */}
      <motion.div aria-hidden className="pointer-events-none absolute -inset-[20%] z-[2] mix-blend-screen"
        style={{
          x: l2x, y: l2y,
          background:
            'linear-gradient(115deg,transparent 34%,rgba(255,249,232,.55) 48%,rgba(255,241,206,.28) 56%,transparent 68%)',
        }}
        animate={reduce ? {} : { x: ['-16%', '10%', '-16%'], opacity: [0.35, 0.75, 0.35] }}
        transition={reduce ? {} : { duration: 19, repeat: Infinity, ease: 'easeInOut' }} />

      {/* LAYER 3 · 植物光暈（呼應海報綠意，極輕微晃動） */}
      <motion.div aria-hidden className="pointer-events-none absolute z-[3] rounded-full"
        style={{
          x: l3x, y: l3y, width: '44vmax', height: '44vmax', left: '-10vmax', bottom: '-12vmax',
          filter: 'blur(42px)', opacity: 0.5,
          background: 'radial-gradient(circle at 40% 40%,rgba(120,150,86,.30),rgba(120,150,86,0) 62%)',
        }}
        animate={reduce ? {} : { rotate: [-1.2, 1.2, -1.2] }}
        transition={reduce ? {} : { duration: 14, repeat: Infinity, ease: 'easeInOut' }} />
      <motion.div aria-hidden className="pointer-events-none absolute z-[3] rounded-full"
        style={{
          x: l3x, y: l3y, width: '36vmax', height: '36vmax', right: '-14vmax', bottom: '2vmax',
          filter: 'blur(42px)', opacity: 0.36,
          background: 'radial-gradient(circle at 60% 40%,rgba(150,168,110,.26),rgba(150,168,110,0) 62%)',
        }}
        animate={reduce ? {} : { rotate: [1, -1, 1] }}
        transition={reduce ? {} : { duration: 16, repeat: Infinity, ease: 'easeInOut', delay: -5 }} />

      {/* LAYER 4 · 微塵 */}
      <motion.div aria-hidden className="pointer-events-none absolute inset-0 z-[4]" style={{ x: l4x, y: l4y }}>
        {!reduce && motes.map((m) => (
          <motion.i key={m.id} className="absolute rounded-full"
            style={{
              width: m.size, height: m.size, left: `${m.left}%`, top: `${m.top}%`,
              background: 'radial-gradient(circle,rgba(255,244,214,.9),rgba(255,244,214,0) 70%)',
            }}
            animate={{ y: [14, -70], scale: [0.6, 1], opacity: [0, 0.55, 0.5, 0] }}
            transition={{ duration: m.dur, delay: m.delay, repeat: Infinity, ease: 'linear' }} />
        ))}
      </motion.div>

      {/* 底部融入頁面的暖色壓底 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-[6]"
        style={{ background: 'linear-gradient(180deg,transparent 62%,rgba(240,230,204,.55) 100%)' }} />

      {/* CONTENT */}
      <motion.div
        variants={reduce ? undefined : container} initial="hidden" animate="show"
        style={{ scale: wrapScale, opacity: wrapOpacity }}
        className="relative z-[7] mx-auto w-full max-w-[1320px] grid items-stretch
                   grid-cols-1 lg:[grid-template-columns:46fr_54fr]
                   gap-6 lg:gap-14 px-6 sm:px-10 lg:px-[72px] pt-28 lg:pt-[132px] pb-24 lg:pb-[84px]">
        {/* 文案 */}
        <div className="self-center flex flex-col max-w-[560px] text-center lg:text-left items-center lg:items-start">
          <motion.img variants={rise} src="/logo.svg" width={186} height={47} alt="愷樂生醫 KAILE BIOMED"
            className="w-[186px] h-auto mb-8 lg:mb-10" />{/* Layer 6 Logo */}
          <motion.p variants={rise} className="text-[13px] font-semibold uppercase mb-[18px]"
            style={{ letterSpacing: '0.34em', color: '#C8A24D' }}>GABA · CALCIUM · MAGNESIUM</motion.p>
          <motion.h1 variants={rise} className="font-bold mb-[22px]"
            style={{ fontFamily: '"Noto Serif TC",serif', color: '#7A1024', lineHeight: 1.1, fontSize: 'clamp(2.7rem,5.4vw,4.4rem)' }}>
            GABA <span className="whitespace-nowrap">鈣鎂晶凍</span>{/* Layer 7 標題 */}
          </motion.h1>
          <motion.p variants={rise} className="mb-[14px] font-medium"
            style={{ color: 'rgba(51,38,42,.82)', lineHeight: 1.7, fontSize: 'clamp(1.05rem,1.5vw,1.4rem)' }}>
            一夜好眠 · 從晶凍開始
          </motion.p>
          <motion.p variants={rise} className="mb-9 lg:mb-11 max-w-[30em] hidden lg:block"
            style={{ color: 'rgba(51,38,42,.56)', lineHeight: 1.85, fontSize: 'clamp(.9rem,1.1vw,1rem)' }}>
            睡前放鬆儀式 × 日常鈣鎂營養補充。純素、幾乎無糖、晶凍劑型好入口——把照顧自己，變成每天的小事。
          </motion.p>
          <motion.div variants={rise} className="flex flex-wrap gap-[14px] justify-center lg:justify-start">{/* Layer 8 CTA */}
            <a href="/gaba" className="group relative inline-flex items-center gap-2 rounded-full px-[34px] py-[15px] font-bold transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:scale-[1.035]"
              style={{ background: 'linear-gradient(135deg,#7A1024,#5C0A1B)', color: '#fbeede', boxShadow: '0 14px 30px -14px rgba(122,16,36,.6),inset 0 0 0 1px rgba(224,192,121,.25)' }}>
              立即了解 <span className="transition-transform duration-300 group-hover:translate-x-1">→</span>
            </a>
            <a href="/jelly" className="inline-flex items-center rounded-full px-[34px] py-[15px] font-bold backdrop-blur-sm transition-[transform,box-shadow,background] duration-300 hover:-translate-y-0.5 hover:scale-[1.035]"
              style={{ background: 'rgba(255,255,255,.5)', color: '#7A1024', boxShadow: 'inset 0 0 0 1.5px rgba(122,16,36,.28)' }}>
              產品介紹
            </a>
          </motion.div>
        </div>

        {/* LAYER 5 · 產品層（海報原圖，固定不變形，僅淡入） */}
        <div className="relative self-end justify-self-center w-full max-w-[560px] flex justify-center items-end">
          <motion.div className="relative w-full"
            style={{ filter: 'drop-shadow(0 40px 60px rgba(90,40,20,.24))' }}
            initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
            transition={{ duration: 1.15, delay: 0.15, ease: [0.2, 0.7, 0.25, 1] }}>
            <Image src="/products/gaba-box.jpg" width={1086} height={1448} priority fetchPriority="high"
              alt="愷樂生醫 GABA 鈣鎂晶凍 產品包裝"
              className="block w-full h-auto rounded-[26px]"
              style={{ border: '1px solid rgba(200,162,77,.28)' }} sizes="(max-width:900px) 90vw, 40vw" />
            {/* 光影高光緩慢掃過（疊在海報上，不修改海報像素） */}
            <div className="pointer-events-none absolute inset-0 rounded-[26px] overflow-hidden z-[2]">
              <motion.div className="absolute -top-[30%] h-[160%] w-[55%]"
                style={{ transform: 'skewX(-14deg)', mixBlendMode: 'soft-light',
                  background: 'linear-gradient(105deg,transparent,rgba(255,255,255,.05) 40%,rgba(255,255,255,.42) 50%,rgba(255,255,255,.05) 60%,transparent)' }}
                animate={reduce ? {} : { left: ['-60%', '130%', '130%'] }}
                transition={reduce ? {} : { duration: 7.5, repeat: Infinity, ease: [0.5, 0, 0.2, 1] }} />
            </div>
          </motion.div>
        </div>
      </motion.div>

      {/* SCROLL CUE */}
      <motion.a href="#next" aria-label="向下捲動" style={{ opacity: cueOpacity }}
        className="absolute left-1/2 -translate-x-1/2 bottom-6 z-[8] flex flex-col items-center gap-[7px]"
        >
        <span className="text-[10px] uppercase" style={{ letterSpacing: '0.22em', color: 'rgba(122,16,36,.5)' }}>Scroll</span>
        <motion.svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(122,16,36,.5)" strokeWidth="1.5"
          animate={reduce ? {} : { y: [0, 5, 0] }} transition={reduce ? {} : { duration: 1.9, repeat: Infinity, ease: 'easeInOut' }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </motion.svg>
      </motion.a>
    </section>
  );
}
