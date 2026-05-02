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
 *   R2_BUCKET
 * Optional:
 *   R2_ENDPOINT       (defaults to https://<accountId>.r2.cloudflarestorage.com)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

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

function getBucket(): string {
  return readEnv('R2_BUCKET');
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
      ContentDisposition: input.originalFilename
        ? `inline; filename="${input.originalFilename.replace(/"/g, '')}"`
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

export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );
}

export function buildExternalUploadKey(visitId: string, uploadId: string): string {
  return `visits/${visitId}/uploads/${uploadId}.pdf`;
}
