import { createHash } from 'node:crypto';

export function hashHostToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function validYouTubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{11}$/.test(value);
}

export function validGuestId(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f-]{36}$/i.test(value);
}

export function privateAddress(address = '') {
  const ip = address.replace(/^::ffff:/, '').split('%')[0];
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') ||
    ip.startsWith('fe80:') || /^10\./.test(ip) || /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}