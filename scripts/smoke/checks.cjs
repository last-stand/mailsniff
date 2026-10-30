// Behavior checks run by scripts/smoke-test.mjs against the *installed* package, once through
// `import` (ESM) and once through `require` (CommonJS). Kept dependency-free and network-free.
'use strict';

const FUNCTIONS = [
  'addDisposableDomains',
  'clearCache',
  'close',
  'configure',
  'createMailSniff',
  'init',
  'isDisposableDomain',
  'isDisposableEmail',
  'listDisposableDomains',
  'refresh',
  'removeDisposableDomains',
  'status',
];

const CLASSES = [
  'CacheError',
  'ClosedError',
  'ConfigError',
  'DatasetError',
  'MailSniff',
  'MailSniffError',
  'ValidationError',
];

/** A fake download: two real disposable domains plus filler to pass the minimum-size check. */
function createFetch() {
  const domains = ['mailinator.com', 'guerrillamail.com'];
  for (let index = 0; index < 20; index += 1) {
    domains.push(`filler-${index}.example`);
  }
  const body = domains.join('\n');

  return () =>
    Promise.resolve({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: null,
      text: () => Promise.resolve(body),
    });
}

function options(overrides = {}) {
  return { dataset: { fetch: createFetch(), minDomains: 5 }, ...overrides };
}

function checkExports(mailsniff, assert) {
  for (const name of FUNCTIONS) {
    assert.equal(typeof mailsniff[name], 'function', `export "${name}" is missing`);
  }
  for (const name of CLASSES) {
    assert.equal(typeof mailsniff[name], 'function', `export "${name}" is missing`);
  }
  assert.ok(new mailsniff.ConfigError('x') instanceof mailsniff.MailSniffError);
}

async function checkDetection(mailsniff, assert) {
  const sniff = mailsniff.createMailSniff(options());
  try {
    assert.equal(await sniff.isDisposableEmail('Someone@Mailinator.com'), true);
    assert.equal(await sniff.isDisposableEmail('a@sub.guerrillamail.com'), true);
    assert.equal(await sniff.isDisposableEmail('someone@gmail.com'), false);
    assert.equal(await sniff.isDisposableDomain('mailinator.com'), true);
    assert.equal(await sniff.isDisposableDomain('not a domain'), false);
    await assert.rejects(sniff.isDisposableEmail(42), TypeError);

    const status = sniff.status();
    assert.equal(status.state, 'ready');
    assert.equal(status.backend, 'memory');
  } finally {
    await sniff.close();
  }
}

async function checkCustomDomains(mailsniff, assert) {
  const sniff = mailsniff.createMailSniff(options());
  try {
    await sniff.addDisposableDomains(['Burner.Example']);
    assert.equal(await sniff.isDisposableEmail('me@mail.burner.example'), true);
    assert.ok((await sniff.listDisposableDomains()).includes('burner.example'));

    await sniff.removeDisposableDomains('burner.example');
    assert.equal(await sniff.isDisposableDomain('burner.example'), false);

    await assert.rejects(
      sniff.addDisposableDomains(['ok.example', 'bad domain']),
      (error) =>
        error instanceof mailsniff.ValidationError &&
        error.code === 'VALIDATION_ERROR' &&
        error.invalid.length === 1,
    );
    assert.equal(await sniff.isDisposableDomain('ok.example'), false);
  } finally {
    await sniff.close();
  }
}

async function checkRefresh(mailsniff, assert) {
  assert.throws(() => mailsniff.createMailSniff({ refreshInterval: '1s' }), mailsniff.ConfigError);

  const sniff = mailsniff.createMailSniff(options({ refreshInterval: '1d' }));
  try {
    await sniff.init();
    assert.equal(sniff.status().autoRefresh, true);

    const result = await sniff.refresh();
    assert.ok(['updated', 'not-modified', 'synced'].includes(result.status), result.status);
    assert.ok(result.communityCount >= 5);
  } finally {
    await sniff.close();
  }
}

async function checkDefaultInstance(mailsniff, assert) {
  // status() must not lock in the default instance, so configure() still works afterwards.
  assert.equal(mailsniff.status().state, 'uninitialized');
  mailsniff.configure(options());

  assert.equal(await mailsniff.isDisposableDomain('mailinator.com'), true);
  assert.equal(mailsniff.status().state, 'ready');
  await mailsniff.close();
}

async function checkRedisIsOptional(mailsniff, assert) {
  // "ioredis" is not installed in the consumer project, so configuring Redis must fail clearly.
  const sniff = mailsniff.createMailSniff(options({ redis: { url: 'redis://127.0.0.1:6379' } }));
  try {
    await assert.rejects(
      sniff.init(),
      (error) => error instanceof mailsniff.ConfigError && /ioredis/.test(error.message),
    );
  } finally {
    await sniff.close();
  }
}

async function checkClosedInstance(mailsniff, assert) {
  const sniff = mailsniff.createMailSniff(options());
  await sniff.close();
  await assert.rejects(sniff.isDisposableDomain('mailinator.com'), mailsniff.ClosedError);
}

module.exports = async function runChecks(mailsniff, assert) {
  checkExports(mailsniff, assert);
  await checkDefaultInstance(mailsniff, assert); // first: needs a pristine default instance
  await checkDetection(mailsniff, assert);
  await checkCustomDomains(mailsniff, assert);
  await checkRefresh(mailsniff, assert);
  await checkRedisIsOptional(mailsniff, assert);
  await checkClosedInstance(mailsniff, assert);
};
