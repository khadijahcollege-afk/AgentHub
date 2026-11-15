import test from 'node:test';
import assert from 'node:assert/strict';
import { activePromos, expiredPromos, promoValidity } from '../lib/promo-validity.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-15T12:00:00Z');

test('promo tanpa tanggal berakhir tetap aktif, bukan dikarang', () => {
  const v = promoValidity({ name: 'Tanpa tanggal' }, NOW);
  assert.equal(v.state, 'active');
  assert.equal(v.endsAt, 0);
  assert.equal(v.daysLeft, null, 'tidak mengarang sisa hari');
});

test('promo yang sudah lewat ditandai expired dan disaring keluar', () => {
  const list = [
    { name: 'Lama', validUntil: '2026-11-01T00:00:00Z' },
    { name: 'Baru', validUntil: new Date(NOW + 30 * DAY).toISOString() },
    { name: 'Tanpa tanggal' },
  ];
  assert.equal(promoValidity(list[0], NOW).state, 'expired');
  assert.deepEqual(activePromos(list, NOW).map((p) => p.name), ['Baru', 'Tanpa tanggal']);
  assert.deepEqual(expiredPromos(list, NOW).map((p) => p.name), ['Lama']);
});

test('promo yang hampir berakhir dibedakan dari yang masih lama', () => {
  assert.equal(promoValidity({ validUntil: new Date(NOW + 3 * DAY).toISOString() }, NOW).state, 'ending');
  assert.equal(promoValidity({ validUntil: new Date(NOW + 20 * DAY).toISOString() }, NOW).state, 'active');
  assert.equal(promoValidity({ validUntil: new Date(NOW + 3 * DAY).toISOString() }, NOW).daysLeft, 3);
});

test('penanda expired eksplisit menang atas tanggal yang masih jauh', () => {
  assert.equal(promoValidity({ expired: true, validUntil: '2099-01-01T00:00:00Z' }, NOW).state, 'expired');
});

test('tanggal rusak tidak membuat promo hilang', () => {
  assert.equal(promoValidity({ validUntil: 'bukan tanggal' }, NOW).state, 'active');
  assert.equal(activePromos([{ validUntil: 'bukan tanggal' }], NOW).length, 1);
});
