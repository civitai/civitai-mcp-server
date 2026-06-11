import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { probeImageSize } from '../src/tools/images.js';

describe('createServer', () => {
  // Phase 1 catalog = 26 tools: browse 7, articles 4, comments 8, messaging 1,
  // images 1, announcements 3, changelog 1, whoami 1.
  // Phase 2 (P0 community participation) adds 26: posts 4, engagement 8,
  // collections 3, notifications 3, chat 4, bounties 4. => 52.
  // Composite-endpoint rewire split chat read tools into mark_chat_read (per-chat)
  // + mark_all_chats_read (blanket) => 53 total.
  it('registers the full tool catalog (53 tools)', () => {
    const { toolCount } = createServer(parseConfig({}));
    expect(toolCount).toBe(53);
  });
});

describe('probeImageSize', () => {
  it('reads PNG dimensions from the IHDR header', () => {
    const buf = Buffer.alloc(24);
    // PNG signature
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    buf.writeUInt32BE(1920, 16);
    buf.writeUInt32BE(1080, 20);
    expect(probeImageSize(buf)).toEqual({ width: 1920, height: 1080, contentType: 'image/png' });
  });

  it('reads GIF dimensions', () => {
    const buf = Buffer.alloc(10);
    buf.write('GIF89a', 0, 'ascii');
    buf.writeUInt16LE(320, 6);
    buf.writeUInt16LE(240, 8);
    expect(probeImageSize(buf)).toEqual({ width: 320, height: 240, contentType: 'image/gif' });
  });

  it('detects JPEG content type', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(probeImageSize(buf).contentType).toBe('image/jpeg');
  });

  it('returns empty for unknown formats', () => {
    expect(probeImageSize(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toEqual({});
  });
});
