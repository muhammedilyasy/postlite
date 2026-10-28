// AWS Signature V4 query-string presigning on WebCrypto (for R2's S3 API: direct browser/agent
// uploads of multipart parts). Spec: docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
// R2: developers.cloudflare.com/r2/api/s3/presigned-urls/ (region "auto", service "s3").
import { hmacBytes, sha256 } from './crypto.js';
import { toHex } from './bytes.js';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p) => p.split('/').map(enc).join('/');
const amzDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * @param {{method:string, url:string, accessKeyId:string, secretAccessKey:string, region?:string, service?:string, expires?:number, date?:Date, query?:Record<string,string>}} o
 * @returns {Promise<string>} presigned URL
 */
export async function presignUrl({ method, url, accessKeyId, secretAccessKey, region = 'auto', service = 's3', expires = 3600, date = new Date(), query = {} }) {
  const u = new URL(url);
  const datetime = amzDate(date);
  const day = datetime.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': datetime,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const canonicalRequest = [method.toUpperCase(), encPath(decodeURIComponent(u.pathname)), canonicalQuery, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, await sha256(canonicalRequest)].join('\n');
  let k = await hmacBytes(`AWS4${secretAccessKey}`, day);
  k = await hmacBytes(k, region);
  k = await hmacBytes(k, service);
  k = await hmacBytes(k, 'aws4_request');
  const signature = toHex(await hmacBytes(k, stringToSign));
  return `${u.origin}${encPath(decodeURIComponent(u.pathname))}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
