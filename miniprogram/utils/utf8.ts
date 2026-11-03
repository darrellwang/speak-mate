/**
 * UTF-8 流式解码器（utils/utf8.ts）
 *
 * 为什么需要它：小程序没有 `TextDecoder`，而 SSE 分片是 `ArrayBuffer`。
 * 更麻烦的是——分片边界会劈开一个多字节字符（中文/音标/emoji 都是 3–4 字节），
 * 直接逐块 `String.fromCharCode` 会产出乱码。因此这里保留未完成序列到下一块。
 */

/**
 * 增量 UTF-8 解码：吞吐任意字节分片，输出已完整的字符，不完整的尾部留在内部。
 */
export class Utf8StreamDecoder {
  /** 上一段遗留的、不足以构成一个字符的字节 */
  private pending: number[] = [];

  /** 推入一个分片，返回本次可安全输出的字符串 */
  push(input: Uint8Array): string {
    const bytes: number[] = this.pending.slice();
    for (let i = 0; i < input.length; i += 1) {
      bytes.push(input[i] as number);
    }
    this.pending = [];

    let out = '';
    let i = 0;
    while (i < bytes.length) {
      const first = bytes[i] as number;
      let length = 0;
      if (first < 0x80) length = 1;
      else if (first >= 0xc0 && first < 0xe0) length = 2;
      else if (first >= 0xe0 && first < 0xf0) length = 3;
      else if (first >= 0xf0 && first < 0xf8) length = 4;

      if (length === 0) {
        // 非法首字节（含孤立的续字节）：丢弃，避免整个流卡死
        i += 1;
        continue;
      }
      if (i + length > bytes.length) {
        // 字符被分片截断：留存到下一次 push
        this.pending = bytes.slice(i);
        break;
      }
      out += decodeCodePoint(bytes, i, length);
      i += length;
    }
    return out;
  }

  /** 流结束：仍残留的字节按替换字符输出（不应发生，发生即说明服务端截断了响应） */
  flush(): string {
    if (this.pending.length === 0) return '';
    const broken = this.pending;
    this.pending = [];
    return broken.map(() => '�').join('');
  }
}

/** 解码单个 UTF-8 序列（调用方保证字节数足够） */
function decodeCodePoint(bytes: number[], start: number, length: number): string {
  const b0 = bytes[start] as number;
  if (length === 1) {
    return String.fromCharCode(b0);
  }
  if (length === 2) {
    return String.fromCharCode(((b0 & 0x1f) << 6) | ((bytes[start + 1] as number) & 0x3f));
  }
  if (length === 3) {
    return String.fromCharCode(
      ((b0 & 0x0f) << 12) |
        (((bytes[start + 1] as number) & 0x3f) << 6) |
        ((bytes[start + 2] as number) & 0x3f),
    );
  }
  // 4 字节（emoji 等）：BMP 之外，手工拆代理对，避免依赖 String.fromCodePoint
  const codePoint =
    ((b0 & 0x07) << 18) |
    (((bytes[start + 1] as number) & 0x3f) << 12) |
    (((bytes[start + 2] as number) & 0x3f) << 6) |
    ((bytes[start + 3] as number) & 0x3f);
  const offset = codePoint - 0x10000;
  return String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
}

/** 一次性解码（非流式场景，如完整响应体） */
export function decodeUtf8(buffer: ArrayBuffer): string {
  return new Utf8StreamDecoder().push(new Uint8Array(buffer));
}
