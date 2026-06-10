import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok, type Services } from './helpers.js';

export interface UploadedImage {
  uuid: string;
  width?: number;
  height?: number;
  contentType?: string;
}

/** Read PNG/JPEG/GIF/WebP dimensions from a buffer header (best-effort, no deps). */
export function probeImageSize(buf: Buffer): { width?: number; height?: number; contentType?: string } {
  // PNG: \x89PNG\r\n\x1a\n then IHDR at offset 16 (width), 20 (height)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), contentType: 'image/png' };
  }
  // GIF: 'GIF8' then LE width/height at offset 6/8
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), contentType: 'image/gif' };
  }
  // JPEG: scan SOF markers
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
          contentType: 'image/jpeg',
        };
      }
      const len = buf.readUInt16BE(offset + 2);
      offset += 2 + len;
    }
    return { contentType: 'image/jpeg' };
  }
  // WebP: 'RIFF'....'WEBP'
  if (buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp' };
  }
  return {};
}

/**
 * Two-step image upload, chaining the presign + PUT. Returns the UUID that
 * Civitai expects in article covers / announcement images (NOT an http URL).
 *
 * Source can be a remote URL (fetched here) or raw base64 bytes.
 */
export async function uploadImage(
  services: Services,
  source: { url?: string; data?: string; contentType?: string }
): Promise<UploadedImage> {
  services.auth.requireKey();
  let bytes: Buffer;
  let contentType = source.contentType;

  if (source.url) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`Failed to fetch image from URL: ${res.status} ${res.statusText}`);
    contentType = contentType ?? res.headers.get('content-type') ?? undefined;
    bytes = Buffer.from(await res.arrayBuffer());
  } else if (source.data) {
    const cleaned = source.data.replace(/^data:[^;]+;base64,/, '');
    bytes = Buffer.from(cleaned, 'base64');
  } else {
    throw new Error('uploadImage requires either url or data (base64)');
  }

  const probed = probeImageSize(bytes);
  contentType = contentType ?? probed.contentType ?? 'application/octet-stream';

  // 1. Presign
  const presign = await services.rest.post<{ id: string; uploadURL: string }>('/image-upload', {});
  if (!presign?.id || !presign?.uploadURL) {
    throw new Error('image-upload did not return id + uploadURL');
  }

  // 2. PUT bytes to the presigned URL (not the civitai host).
  const putRes = await fetch(presign.uploadURL, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!putRes.ok) {
    const t = await putRes.text().catch(() => '');
    throw new Error(`Upload PUT failed: ${putRes.status} ${putRes.statusText} ${t.slice(0, 200)}`);
  }

  return { uuid: presign.id, width: probed.width, height: probed.height, contentType };
}

export const imageTools: ToolModule = (reg) => {
  reg(
    'upload_image',
    {
      title: 'Upload image',
      description:
        'Upload an image to Civitai from a URL or base64 data. Returns the image UUID (and probed dimensions) needed to set article covers and announcement images. Chains the presign + PUT upload internally.',
      inputSchema: {
        url: z.string().url().optional().describe('Remote image URL to fetch and upload'),
        data: z.string().optional().describe('Base64-encoded image bytes (data: URI prefix is stripped)'),
        contentType: z.string().optional().describe('MIME type override, e.g. image/png'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      if (!args.url && !args.data) throw new Error('Provide either url or data');
      const result = await uploadImage(services, args);
      return ok(
        `Uploaded image. UUID: ${result.uuid}` +
          (result.width ? ` (${result.width}x${result.height})` : ''),
        { ...result }
      );
    }
  );
};
