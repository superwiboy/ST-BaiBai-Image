import { describe, it, expect } from 'vitest';
import { extractTextItems, wrapMangaText } from './lettering';

describe('manga lettering', () => {
  it('extractTextItems 从 layout JSON 中提取 text 槽位', () => {
    const layout = JSON.stringify({
      items: [
        { label: 'character', caption: '1girl' },
        { label: 'text', text: '你好，世界！', bbox: [-100, -200, 100, 200] },
        { label: 'text', text: '', bbox: [0, 0, 10, 10] }, // 空文本应被忽略
      ],
    });
    const items = extractTextItems(layout);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('你好，世界！');
    expect(items[0].bbox).toEqual([-100, -200, 100, 200]);
  });

  it('wrapMangaText 自适应按最大宽度折行', () => {
    // 假设每个汉字宽度 10px
    const text = '今天天气真好我们一起出去玩吧';
    const measure = (s: string) => s.length * 10;
    const lines = wrapMangaText(text, measure, 60); // 每行最多 6 个字
    expect(lines).toEqual(['今天天气真好', '我们一起出去', '玩吧']);
  });
});
