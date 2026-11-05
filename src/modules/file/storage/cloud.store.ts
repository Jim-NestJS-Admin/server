import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import OSS from 'ali-oss';
import { assertBlobKey, BlobStore, boundedBuffer } from './blob-store.js';

/** 客户端/桶只能由管理员配置，不能从上传请求接受 endpoint、bucket 或凭据。 */
export class S3BlobStore extends BlobStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    super();
    if (!bucket.trim()) throw new Error('S3 存储桶未配置');
  }
  async put(key: string, data: Buffer, mime: string): Promise<void> {
    assertBlobKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: mime,
        ContentDisposition: 'attachment',
        IfNoneMatch: '*',
      }),
    );
  }
  async get(key: string, maxBytes: number): Promise<Buffer> {
    assertBlobKey(key);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = result.Body;
    if (!body || !(Symbol.asyncIterator in body))
      throw new Error('存储没有返回文件流');
    try {
      return await boundedBuffer(body as AsyncIterable<Uint8Array>, maxBytes);
    } finally {
      if ('destroy' in body && typeof body.destroy === 'function')
        body.destroy();
    }
  }
  async discard(key: string): Promise<void> {
    assertBlobKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

export class OssBlobStore extends BlobStore {
  constructor(private readonly client: OSS) {
    super();
  }
  async put(key: string, data: Buffer, mime: string): Promise<void> {
    assertBlobKey(key);
    await this.client.put(key, data, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': 'attachment',
        'x-oss-object-acl': 'private',
        'x-oss-forbid-overwrite': 'true',
      },
    });
  }
  async get(key: string, maxBytes: number): Promise<Buffer> {
    assertBlobKey(key);
    const result = await this.client.getStream(key);
    try {
      return await boundedBuffer(
        result.stream as AsyncIterable<Uint8Array>,
        maxBytes,
      );
    } finally {
      result.stream.destroy();
    }
  }
  async discard(key: string): Promise<void> {
    assertBlobKey(key);
    await this.client.delete(key);
  }
}
