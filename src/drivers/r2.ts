/** R2 驱动: 单分片直接 put, 多分片走 multipart (分片号 = idx + 1)  */
import type { Env } from '../env';

export const r2Key = (blobId: string) => `b/${blobId}`;

export async function r2CreateMultipart(env: Env, blobId: string, mime: string): Promise<string> {
  const up = await env.BUCKET.createMultipartUpload(r2Key(blobId), { httpMetadata: { contentType: mime } });
  return up.uploadId;
}

export async function r2PutPart(env: Env, blobId: string, uploadId: string, idx: number, body: ReadableStream | ArrayBuffer): Promise<string> {
  const up = env.BUCKET.resumeMultipartUpload(r2Key(blobId), uploadId);
  const part = await up.uploadPart(idx + 1, body);
  return part.etag;
}

export async function r2Complete(env: Env, blobId: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
  const up = env.BUCKET.resumeMultipartUpload(r2Key(blobId), uploadId);
  await up.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
}

export async function r2Abort(env: Env, blobId: string, uploadId: string) {
  try {
    await env.BUCKET.resumeMultipartUpload(r2Key(blobId), uploadId).abort();
  } catch {
    /* 已完成或已中止 */
  }
}

export async function r2PutWhole(env: Env, blobId: string, body: ReadableStream | ArrayBuffer, mime: string) {
  await env.BUCKET.put(r2Key(blobId), body, { httpMetadata: { contentType: mime } });
}
