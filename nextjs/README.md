# 愷樂生醫 — Premium Hero Banner（Next.js 版）

`HeroBanner.jsx` 是可直接放進 Next.js（App Router）專案的 Client Component，
用 **TailwindCSS + Framer Motion** 實作，與靜態版 `../hero-premium.html` 同一套設計。

## 安裝

```bash
npm i framer-motion
```

## 放置素材（複製到 public/）

```
public/
├─ logo.svg                    ← 來自 assets/img/logo.svg
└─ products/
   └─ gaba-box.jpg             ← 來自 assets/img/products/gaba/gaba-box.jpg
```

## 使用

```jsx
// app/page.jsx
import HeroBanner from '@/components/HeroBanner';

export default function Page() {
  return (
    <main>
      <HeroBanner />
      {/* 其餘內容，記得放一個 id="next" 的區塊給 SCROLL 錨點 */}
      <section id="next">…</section>
    </main>
  );
}
```

Tailwind 專案沿用即可（元件只用到 flex/grid/spacing 等基礎類別；漸層與品牌色以 inline style 寫死，方便你直接複製、不依賴自訂 theme）。

## 8 層結構（皆可獨立控制動畫）

| Layer | 內容 | 動效 |
|---|---|---|
| 1 | 背景暖色晨光 | 滑鼠視差 + 捲動放大 |
| 2 | 窗光斜射 | 緩慢掃過（screen 疊加）+ 視差 |
| 3 | 植物光暈（呼應海報綠意） | 極輕微旋轉晃動 + 視差 |
| 4 | 微塵 | 上飄 + 淡入淡出 + 視差 |
| 5 | **產品海報（原圖）** | **固定不變形，僅淡入**；上方光影高光緩慢掃過 |
| 6 | Logo | 進場 rise |
| 7 | 標題／副標 | 進場 stagger rise |
| 8 | CTA | 進場 rise；hover 柔和放大＋陰影 |

## 效能 / 合規

- 全部動效走 `transform` / `opacity`（GPU 加速）；**無 GIF / Video / Canvas**
- 產品海報用 `next/image` + `priority` + `fetchPriority="high"`（LCP 最佳化）；其餘圖層為 CSS 繪製
- 完整支援 `prefers-reduced-motion`（自動關閉視差與環境動效）
- 產品海報維持 **100% 原圖**，無透視／變形／重繪

## 想升級成「人物呼吸、植物各自搖」？

目前用的是一張**平面合成海報**，所以人物／植物／果凍是同一張圖、無法各自獨立動。
若能提供**去背分層 PNG／PSD**（人物、產品盒、植物、玻璃杯、果凍 各一張透明圖），
即可把 Layer 3–5 換成真正獨立的元素，加上呼吸、微搖、果凍高光等逐層動畫。
