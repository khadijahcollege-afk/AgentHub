// test/ask-question.test.js — kontrak AskUserQuestion: validasi pertanyaan,
// normalisasi jawaban, dan bentuk teks yang dilihat model.
//
// Yang diuji di sini adalah bentuk, bukan UI: pertanyaan yang tidak bisa
// dirender menjadi tombol harus ditolak SEBELUM kartu dibuat, karena kartu
// setengah jadi lebih membingungkan daripada pesan galat yang jelas.
import test from 'node:test';
import assert from 'node:assert/strict';

const ask = await import('../lib/ask-question.js');

const opt = (label, description = 'penjelasan') => ({ label, description });

function q(overrides = {}) {
  return {
    question: 'Database apa?',
    header: 'Database',
    options: [opt('SQLite'), opt('Postgres')],
    ...overrides,
  };
}

test('pertanyaan sah dinormalkan', () => {
  const r = ask.validateQuestions({ questions: [q()] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.questions[0], {
    question: 'Database apa?',
    header: 'Database',
    multiSelect: false,
    options: [{ label: 'SQLite', description: 'penjelasan' }, { label: 'Postgres', description: 'penjelasan' }],
  });
});

test('jumlah pertanyaan harus 1 sampai 4', () => {
  assert.equal(ask.validateQuestions({}).ok, false);
  assert.equal(ask.validateQuestions({ questions: [] }).ok, false, 'daftar kosong tidak ada gunanya');
  assert.equal(ask.validateQuestions({ questions: 'halo' }).ok, false);
  const five = Array.from({ length: 5 }, (_, i) => q({ question: `Pertanyaan ${i}?`, header: `H${i}` }));
  const r = ask.validateQuestions({ questions: five });
  assert.equal(r.ok, false);
  assert.match(r.error, /Maksimal 4/);
});

test('opsi harus 2 sampai 4', () => {
  const one = ask.validateQuestions({ questions: [q({ options: [opt('Hanya')] })] });
  assert.equal(one.ok, false);
  assert.match(one.error, /minimal 2/);

  const five = ask.validateQuestions({
    questions: [q({ options: [opt('A'), opt('B'), opt('C'), opt('D'), opt('E')] })],
  });
  assert.equal(five.ok, false);
  assert.match(five.error, /maksimal 4/);
});

test('pertanyaan dan label ganda ditolak', () => {
  const dupQ = ask.validateQuestions({
    questions: [q(), q()],
  });
  assert.equal(dupQ.ok, false);
  assert.match(dupQ.error, /lebih dari sekali/);

  const dupLabel = ask.validateQuestions({ questions: [q({ options: [opt('Sama'), opt('sama')] })] });
  assert.equal(dupLabel.ok, false);
  assert.match(dupLabel.error, /lebih dari sekali/);

  // Label sama di pertanyaan BERBEDA tetap sah: keduanya milik daftar sendiri.
  const crossOk = ask.validateQuestions({
    questions: [q({ header: 'A' }), q({ question: 'Cache apa?', header: 'B' })],
  });
  assert.equal(crossOk.ok, true);
});

test('header wajib ada dan pendek', () => {
  assert.equal(ask.validateQuestions({ questions: [q({ header: '' })] }).ok, false);
  const long = ask.validateQuestions({ questions: [q({ header: 'Header Yang Jauh Terlalu Panjang' })] });
  assert.equal(long.ok, false);
  assert.match(long.error, /maksimal 12/);
});

test('opsi "Other/Lainnya" dari model ditolak: UI sudah menambahkannya', () => {
  for (const label of ['Other', 'Lainnya', 'Custom', 'other']) {
    const r = ask.validateQuestions({ questions: [q({ options: [opt(label), opt('Postgres')] })] });
    assert.equal(r.ok, false, `label "${label}" harus ditolak`);
    assert.match(r.error, /Lainnya/);
  }
  // Label yang hanya MENGANDUNG kata itu tetap sah.
  assert.equal(ask.validateQuestions({ questions: [q({ options: [opt('Other database'), opt('Postgres')] })] }).ok, true);
});

test('label lebih dari 5 kata ditolak, deskripsi wajib', () => {
  const words = ask.validateQuestions({ questions: [q({ options: [opt('satu dua tiga empat lima enam'), opt('Postgres')] })] });
  assert.equal(words.ok, false);
  assert.match(words.error, /5 kata/);

  const noDesc = ask.validateQuestions({ questions: [q({ options: [{ label: 'SQLite' }, opt('Postgres')] })] });
  assert.equal(noDesc.ok, false);
  assert.match(noDesc.error, /description/);
});

test('preview: dokumen HTML utuh, script, style, dan atribut event ditolak', () => {
  const bad = [
    '<!DOCTYPE html><p>x</p>',
    '<html><p>x</p></html>',
    '<head><title>x</title></head>',
    '<body>x</body>',
    '<script>alert(1)</script>',
    '<style>p{}</style>',
    '<p onclick="x()">y</p>',
  ];
  for (const preview of bad) {
    const r = ask.validateQuestions({ questions: [q({ options: [{ label: 'SQLite', description: 'x', preview }, opt('Postgres')] })] });
    assert.equal(r.ok, false, `preview "${preview.slice(0, 20)}" harus ditolak`);
  }
  // Fragmen dan markdown biasa sah.
  for (const preview of ['<b>tebal</b>', '**markdown**', '| a | b |\n| - | - |']) {
    const r = ask.validateQuestions({ questions: [q({ options: [{ label: 'SQLite', description: 'x', preview }, opt('Postgres')] })] });
    assert.equal(r.ok, true, `preview "${preview}" harus diterima`);
  }
  // Komentar HTML saja bukan fragmen yang bisa dirender.
  const comment = ask.validateQuestions({
    questions: [q({ options: [{ label: 'SQLite', description: 'x', preview: '<!-- kosong -->' }, opt('Postgres')] })],
  });
  assert.equal(comment.ok, false);
});

test('preview tidak boleh dipakai pada pertanyaan multi-pilih', () => {
  const r = ask.validateQuestions({
    questions: [q({
      multiSelect: true,
      options: [{ label: 'A', description: 'x', preview: '<b>a</b>' }, opt('B')],
    })],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /multi-pilih/);
});

test('normalizeAnswers: kunci tak dikenal ditolak, kosong dilewati', () => {
  const questions = [q({ header: 'A' }), q({ question: 'Cache apa?', header: 'B' })];

  const unknown = ask.normalizeAnswers(questions, { 'Pertanyaan asing?': 'x' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /tidak ditanyakan/);

  const partial = ask.normalizeAnswers(questions, { 'Database apa?': 'SQLite', 'Cache apa?': '   ' });
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.answers, { 'Database apa?': 'SQLite' }, 'jawaban kosong tidak ditulis sebagai string kosong');

  const none = ask.normalizeAnswers(questions, {});
  assert.equal(none.ok, true);
  assert.deepEqual(none.answers, {});

  const nul = ask.normalizeAnswers(questions, null);
  assert.deepEqual(nul.answers, {});

  assert.equal(ask.normalizeAnswers(questions, ['a']).ok, false, 'array bukan Record');

  // Kunci dicocokkan tanpa peduli huruf besar/kecil, tapi yang disimpan teks asli.
  const loose = ask.normalizeAnswers(questions, { 'database APA?': 'Postgres' });
  assert.deepEqual(loose.answers, { 'Database apa?': 'Postgres' });
});

test('normalizeAnswers: jawaban bebas dibatasi panjangnya', () => {
  const questions = [q()];
  const tooLong = ask.normalizeAnswers(questions, { 'Database apa?': 'x'.repeat(ask.LIMITS.maxAnswer + 1) });
  assert.equal(tooLong.ok, false);
  // Teks pendek yang bukan salah satu opsi tetap sah: itu jawaban "Lainnya".
  const free = ask.normalizeAnswers(questions, { 'Database apa?': 'MySQL 8' });
  assert.equal(free.ok, true);
  assert.equal(free.answers['Database apa?'], 'MySQL 8');
});

test('formatAnswerText menyebut tiap pasangan dan menghitung yang dilewati', () => {
  const questions = [q({ header: 'Database' }), q({ question: 'Cache apa?', header: 'Cache' })];
  const text = ask.formatAnswerText(questions, { 'Database apa?': 'Postgres' });
  assert.match(text, /Postgres/);
  assert.match(text, /Database: "Database apa\?"="Postgres"/);
  assert.match(text, /1 pertanyaan dilewati/);
  assert.match(text, /jangan mengarang/);
});

test('formatAnswerText untuk jawaban kosong meminta asumsi eksplisit', () => {
  const text = ask.formatAnswerText([q()], {});
  assert.match(text, /jawaban kosong/);
  assert.match(text, /asumsi/);
});

test('formatAnswerText menyertakan catatan dan preview pengguna', () => {
  const questions = [q()];
  const text = ask.formatAnswerText(
    questions,
    { 'Database apa?': 'SQLite' },
    { 'Database apa?': { notes: 'lebih murah', preview: '<b>sqlite</b>\nbaris dua' } },
  );
  assert.match(text, /catatan pengguna: lebih murah/);
  assert.match(text, /preview dipilih: <b>sqlite<\/b>/);
  assert.doesNotMatch(text, /baris dua/, 'preview cukup satu baris pertama');
});

test('normalizeAnnotations membuang kunci asing dan nilai kosong', () => {
  const questions = [q()];
  const ann = ask.normalizeAnnotations(questions, {
    'Database apa?': { notes: 'catatan', preview: '' },
    'Tidak ada?': { notes: 'abaikan' },
  });
  assert.deepEqual(ann, { 'Database apa?': { notes: 'catatan' } });
  assert.deepEqual(ask.normalizeAnnotations(questions, null), {});
});
