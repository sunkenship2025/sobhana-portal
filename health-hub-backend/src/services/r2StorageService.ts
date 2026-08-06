/**
 * Cloudflare R2 Storage Service
 *
 * Single point of contact for object storage. Wraps the AWS S3 SDK pointed
 * at the R2 endpoint. Other services should call `putPdf` / `getObject` /
 * `deleteObject` rather than constructing their own S3Client.
 *
 * Required env:
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET         (PRIVATE — patient report PDFs & uploads live here; never make public)
 * Optional:
 *   R2_ENDPOINT       (defaults to https://<accountId>.r2.cloudflarestorage.com)
 *   R2_PUBLIC_BUCKET  (separate PUBLIC bucket for display ad media only; pass as the
 *                      `bucket` override so ads can be served publicly without ever
 *                      exposing the private report bucket)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

let cachedClient: S3Client | null = null;

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function getClient(): S3Client {
  if (cachedClient) return cachedClient;

  const accountId = readEnv('R2_ACCOUNT_ID');
  const accessKeyId = readEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = readEnv('R2_SECRET_ACCESS_KEY');
  const endpoint = process.env.R2_ENDPOINT?.trim()
    || `https://${accountId}.r2.cloudflarestorage.com`;

  cachedClient = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });

  return cachedClient;
}

function getBucket(override?: string): string {
  return override || readEnv('R2_BUCKET');
}

export interface PutPdfInput {
  key: string;
  body: Buffer;
  originalFilename?: string;
}

export async function putPdf(input: PutPdfInput): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: input.key,
      Body: input.body,
      ContentType: 'application/pdf',
      // Strip quotes AND CRLF — newlines in the filename would let a crafted
      // upload inject response headers when R2 serves the object back via
      // signed URL or via our /api/external-uploads/:id passthrough.
      ContentDisposition: input.originalFilename
        ? `inline; filename="${input.originalFilename.replace(/[\r\n"]/g, '')}"`
        : undefined,
    }),
  );
}

export async function getObject(key: string): Promise<Buffer> {
  const client = getClient();
  const result = await client.send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );

  const body = result.Body;
  if (!body) {
    throw new Error(`R2 object missing body: ${key}`);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string, bucket?: string): Promise<void> {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucket(bucket),
      Key: key,
    }),
  );
}

export function buildExternalUploadKey(visitId: string, uploadId: string): string {
  return `visits/${visitId}/uploads/${uploadId}.pdf`;
}

/** Generic object put (any content type) — used for display ad photos/videos. */
export async function putObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
  contentDisposition?: string;
  bucket?: string;
}): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(input.bucket),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentDisposition: input.contentDisposition
        ? input.contentDisposition.replace(/[\r\n"]/g, '')
        : undefined,
    }),
  );
}

export interface ObjectStream {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  status: number; // 200 full, 206 partial
}

/**
 * Stream an object straight from R2 (optionally a byte range). Returns the SDK
 * body stream to pipe to the response — never buffers the whole object, so a
 * large ad video can't OOM the 512MB instance. Pass the request's Range header
 * to support <video> seeking.
 */
export async function getObjectStream(key: string, range?: string, bucket?: string): Promise<ObjectStream> {
  const client = getClient();
  const result = await client.send(
    new GetObjectCommand({ Bucket: getBucket(bucket), Key: key, Range: range }),
  );
  return {
    body: result.Body as Readable,
    contentType: result.ContentType,
    contentLength: result.ContentLength,
    contentRange: result.ContentRange,
    status: range && result.ContentRange ? 206 : 200,
  };
}

/** Best-effort bulk delete (e.g. removing an ad's media). Never throws. */
export async function deleteObjects(keys: string[], bucket?: string): Promise<void> {
  for (const key of keys) {
    try {
      await deleteObject(key, bucket);
    } catch (err) {
      console.error('R2 deleteObjects: failed to delete', key, err);
    }
  }
}

/**
 * Cheap reachability probe used by the /health endpoint. Returns nothing on
 * success; throws on auth/permission/network failure.
 */
export async function headBucket(): Promise<void> {
  const client = getClient();
  await client.send(new HeadBucketCommand({ Bucket: getBucket() }));
}
