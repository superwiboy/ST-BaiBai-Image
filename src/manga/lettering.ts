/**
 * 漫画台词嵌字渲染器 (Manga Dialogue Lettering)
 *
 * 针对 SDXL / Illustrious 等不具备汉字扩散字形先验的底模，
 * 在生图完成后由前端 Canvas 读取版式中的 text 槽位及台词文本，
 * 在对应的气泡区域以漫画标准排版无损印制矢量汉字，
 * 实现 100% 零错字、字迹锐利、防边框覆盖的工业级成图。
 */

export interface TextItemInfo {
  text: string;
  bbox: [number, number, number, number];
}

export function extractTextItems(layoutJsonText: string): TextItemInfo[] {
  const trimmed = layoutJsonText.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  try {
    const data = JSON.parse(trimmed);
    if (!data || !Array.isArray(data.items)) return [];
    const isCentralized = data.bbox_coord_space === 'abs_centralized';
    const items: TextItemInfo[] = [];
    for (const it of data.items) {
      if (!it || typeof it !== 'object') continue;
      if (it.label === 'text' && typeof it.text === 'string' && it.text.trim()) {
        if (Array.isArray(it.bbox) && it.bbox.length === 4) {
          items.push({ text: it.text.trim(), bbox: it.bbox as [number, number, number, number] });
        }
      }
    }
    return items;
  } catch {
    return [];
  }
}

/** 换行分词：中英文混合自适应宽度折行 */
export function wrapMangaText(
  text: string,
  measureWidth: (line: string) => number,
  maxWidth: number,
): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (!para) {
      lines.push('');
      continue;
    }
    let currentLine = '';
    for (const char of para) {
      const candidate = currentLine + char;
      if (measureWidth(candidate) <= maxWidth || currentLine.length === 0) {
        currentLine = candidate;
      } else {
        lines.push(currentLine);
        currentLine = char;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines;
}

/**
 * 在浏览器 Canvas 上为图片叠加漫画台词
 */
export async function applyMangaLettering(
  imageUrl: string,
  layoutJsonText: string,
  canvasW = 832,
  canvasH = 1216,
): Promise<{ url: string; revokedOriginal?: boolean } | null> {
  if (typeof document === 'undefined') return null; // Node.js 环境跳过

  const textItems = extractTextItems(layoutJsonText);
  if (textItems.length === 0) return null;

  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const width = img.naturalWidth || canvasW;
        const height = img.naturalHeight || canvasH;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }

        // 1. 绘制底层生图画面
        ctx.drawImage(img, 0, 0, width, height);

        // 2. 遍历文字项嵌字
        for (const item of textItems) {
          const [y1, x1, y2, x2] = item.bbox;
          // 坐标映射到当前物理画布
          const left = x1 + width / 2;
          const top = y1 + height / 2;
          const right = x2 + width / 2;
          const bottom = y2 + height / 2;

          const rx = Math.max(0, Math.round(Math.min(left, right)));
          const ry = Math.max(0, Math.round(Math.min(top, bottom)));
          const rw = Math.max(20, Math.round(Math.abs(right - left)));
          const rh = Math.max(20, Math.round(Math.abs(bottom - top)));

          const paddingX = rw * 0.12;
          const maxTextW = Math.max(20, rw - paddingX * 2);

          // 自动估算字号并折行
          let fontSize = Math.min(24, Math.max(13, Math.floor(rh * 0.28)));
          ctx.font = `bold ${fontSize}px "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif`;

          let lines = wrapMangaText(item.text, s => ctx.measureText(s).width, maxTextW);
          const lineHeight = fontSize * 1.35;
          let totalHeight = lines.length * lineHeight;

          // 若行数超出高度，适当缩小字号二次折行
          if (totalHeight > rh * 0.85 && fontSize > 12) {
            fontSize = Math.max(12, Math.floor(fontSize * 0.85));
            ctx.font = `bold ${fontSize}px "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif`;
            lines = wrapMangaText(item.text, s => ctx.measureText(s).width, maxTextW);
          }

          const centerX = rx + rw / 2;
          const startY = ry + (rh - lines.length * fontSize * 1.35) / 2 + fontSize * 0.9;

          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            const lineY = startY + li * (fontSize * 1.35);

            // 白色外描边增加可读性
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = '#ffffff';
            ctx.strokeText(line, centerX, lineY);

            // 纯黑漫画印刷墨水填充
            ctx.fillStyle = '#111111';
            ctx.fillText(line, centerX, lineY);
          }
        }

        canvas.toBlob(blob => {
          if (!blob) {
            resolve(null);
            return;
          }
          const letteredUrl = URL.createObjectURL(blob);
          resolve({ url: letteredUrl });
        }, 'image/png');
      } catch (e) {
        console.warn('[柏宝绘] 漫画台词嵌字失败(降级为无文字生图):', e);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}
