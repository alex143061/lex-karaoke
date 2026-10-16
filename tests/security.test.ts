import assert from 'node:assert/strict';
import test from 'node:test';
import { hashHostToken, privateAddress, validGuestId, validYouTubeVideoId } from '../lib/security';

test('host tokens are stored as stable one-way hashes', () => {
  const token = 'private-host-token';
  const hash = hashHostToken(token);
  assert.notEqual(hash, token);
  assert.equal(hashHostToken(token), hash);
});

test('validates YouTube video IDs and guest identifiers', () => {
  assert.equal(validYouTubeVideoId('abcdefghijk'), true);
  assert.equal(validYouTubeVideoId('too-short'), false);
  assert.equal(validGuestId('e2f28d83-a64a-4cf5-a237-1a856a3462e1'), true);
  assert.equal(validGuestId('guest'), false);
});

test('allows loopback and private LAN peers but rejects public peers', () => {
  assert.equal(privateAddress('127.0.0.1'), true);
  assert.equal(privateAddress('::ffff:192.168.1.25'), true);
  assert.equal(privateAddress('10.0.0.4'), true);
  assert.equal(privateAddress('172.20.1.3'), true);
  assert.equal(privateAddress('8.8.8.8'), false);
});