import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateSpendTotals,
  googleOrderFinancials,
  googlePurchaseType,
  purchaseHistory,
  reconcileAndroidOrderStates,
  reconcileAndroidVoids,
  verifyAndroidPurchase,
} from '../server/worker.js';

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    if (this.sql.includes('FROM purchase_reconciliation_state'))
      return this.db.reconciliationState;
    return null;
  }

  async all() {
    if (this.sql.includes("WHERE p.platform='android'"))
      return { results: this.db.ordersToSync };
    return { results: [] };
  }

  async run() {
    this.db.writes.push(this);
    return { success: true };
  }
}

class Db {
  reconciliationState = null;
  ordersToSync = [];
  writes = [];
  batches = [];

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

const boundAccountToken = async (accountId) => {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`discipline-account:${accountId}`),
  )).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const purchaseRequest = (productId = 'm_stack') => new Request(
  'https://api.example/v1/purchases/android/verify',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productId,
      purchaseToken: 'purchase-token-long-enough-for-google',
    }),
  },
);

test('Google order response is the exact financial source of truth', () => {
  const result = googleOrderFinancials({
    orderId: 'GPA.123',
    purchaseToken: 'play-token',
    state: 'PROCESSED',
    lastEventTime: '2026-07-23T12:00:00Z',
    total: { currencyCode: 'USD', units: '4', nanos: 990_000_000 },
    lineItems: [{
      productId: 'm_stack',
      total: { currencyCode: 'USD', units: '4', nanos: 990_000_000 },
    }],
  }, {
    orderId: 'GPA.123',
    purchaseToken: 'play-token',
    productId: 'm_stack',
  });

  assert.deepEqual(result, {
    currencyCode: 'USD',
    units: '4',
    nanos: 990_000_000,
    financialStatus: 'processed',
    lastEventTime: '2026-07-23T12:00:00Z',
  });
  assert.throws(() => googleOrderFinancials({
    orderId: 'GPA.other',
    state: 'PROCESSED',
    total: { currencyCode: 'USD', units: '4', nanos: 990_000_000 },
    lineItems: [{
      productId: 'm_stack',
      total: { currencyCode: 'USD', units: '4', nanos: 990_000_000 },
    }],
  }, { orderId: 'GPA.123', productId: 'm_stack' }), /google_order_mismatch/);
});

test('test, promo, and rewarded transactions are classified separately from paid standard orders', () => {
  assert.equal(googlePurchaseType(undefined), 'standard');
  assert.equal(googlePurchaseType(0), 'test');
  assert.equal(googlePurchaseType(1), 'promo');
  assert.equal(googlePurchaseType(2), 'rewarded');
  assert.equal(googlePurchaseType(99), 'unknown');
});

test('standard Android verification records exact Orders line-item Money before consumption', async () => {
  const DB = new Db();
  const account = { id: 42 };
  const expectedToken = await boundAccountToken(account.id);
  const calls = [];
  const fetcher = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith(':consume')) return new Response(null, { status: 200 });
    if (target.includes('/orders/')) return Response.json({
      orderId: 'GPA.paid',
      purchaseToken: 'purchase-token-long-enough-for-google',
      state: 'PROCESSED',
      total: { currencyCode: 'USD', units: '99', nanos: 0 },
      lineItems: [{
        productId: 'm_stack',
        total: { currencyCode: 'USD', units: '4', nanos: 990_000_000 },
      }],
    });
    return Response.json({
      purchaseState: 0,
      consumptionState: 0,
      orderId: 'GPA.paid',
      productId: 'm_stack',
      obfuscatedExternalAccountId: expectedToken,
      quantity: 1,
      regionCode: 'US',
    });
  };

  const response = await verifyAndroidPurchase(
    purchaseRequest(),
    { DB },
    account,
    { accessToken: 'access', fetcher },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    amount: 280,
    transactionId: 'GPA.paid',
  });
  const financial = DB.writes.find((write) => write.sql.includes('INSERT INTO purchase_financials'));
  assert.ok(financial);
  assert.equal(financial.args[2], 'standard');
  assert.equal(financial.args[4], 'US');
  assert.equal(financial.args[5], 'USD');
  assert.equal(financial.args[6], '4');
  assert.equal(financial.args[7], 990_000_000);
  assert.ok(calls.findIndex((url) => url.includes('/orders/'))
    < calls.findIndex((url) => url.endsWith(':consume')));
});

test('standard paid purchase fails closed when Orders financials are unavailable', async () => {
  const DB = new Db();
  const account = { id: 7 };
  const expectedToken = await boundAccountToken(account.id);
  const calls = [];
  const response = await verifyAndroidPurchase(
    purchaseRequest(),
    { DB },
    account,
    {
      accessToken: 'access',
      fetcher: async (url) => {
        const target = String(url);
        calls.push(target);
        return target.includes('/orders/')
          ? new Response('forbidden', { status: 403 })
          : Response.json({
            purchaseState: 0,
            consumptionState: 0,
            orderId: 'GPA.no-orders',
            productId: 'm_stack',
            obfuscatedExternalAccountId: expectedToken,
          });
      },
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'purchase_financials_unavailable',
    recorded: true,
    amount: 280,
    transactionId: 'GPA.no-orders',
  });
  assert.equal(DB.writes.length, 2);
  assert.match(DB.writes[0].sql, /INSERT INTO purchases/);
  assert.match(DB.writes[1].sql, /INSERT INTO purchase_financials/);
  assert.equal(DB.writes[1].args[8], 'pending');
  assert.equal(calls.some((url) => url.endsWith(':consume')), false);
});

test('license-test purchase remains testable but cannot enter real-money totals', async () => {
  const DB = new Db();
  const account = { id: 9 };
  const expectedToken = await boundAccountToken(account.id);
  const response = await verifyAndroidPurchase(
    purchaseRequest(),
    { DB },
    account,
    {
      accessToken: 'access',
      fetcher: async (url) => {
        const target = String(url);
        if (target.endsWith(':consume')) return new Response(null, { status: 200 });
        if (target.includes('/orders/')) return new Response('not available', { status: 404 });
        return Response.json({
          purchaseState: 0,
          consumptionState: 0,
          purchaseType: 0,
          orderId: 'GPA.license-test',
          productId: 'm_stack',
          obfuscatedExternalAccountId: expectedToken,
        });
      },
    },
  );
  assert.equal(response.status, 200);
  const financial = DB.writes.find((write) => write.sql.includes('INSERT INTO purchase_financials'));
  assert.equal(financial.args[2], 'test');
  assert.equal(financial.args[8], 'unavailable');
});

test('spend totals preserve Google Money precision and stay grouped by currency', () => {
  assert.deepEqual(aggregateSpendTotals([
    { paid_currency: 'USD', paid_units: '4', paid_nanos: 990_000_000 },
    { paid_currency: 'USD', paid_units: '1', paid_nanos: 20_000_000 },
    { paid_currency: 'CAD', paid_units: '2', paid_nanos: 0 },
  ]), [
    { currencyCode: 'CAD', units: '2', nanos: 0, transactionCount: 1 },
    { currencyCode: 'USD', units: '6', nanos: 10_000_000, transactionCount: 2 },
  ]);
});

test('purchase history exposes transaction statuses and only eligible paid totals', async () => {
  const statements = [];
  const DB = {
    prepare(sql) {
      const statement = {
        sql: sql.replace(/\s+/g, ' ').trim(),
        bind(...args) {
          this.args = args;
          statements.push(this);
          return this;
        },
        async all() {
          if (this.sql.includes("pf.purchase_type='standard'")) {
            return { results: [
              { paid_currency: 'USD', paid_units: '4', paid_nanos: 990_000_000 },
            ] };
          }
          return { results: [{
            platform: 'android',
            transaction_id: 'GPA.paid',
            purchase_type: 'standard',
            financial_status: 'processed',
            transaction_status: 'delivered',
          }] };
        },
        async first() {
          return { m: 280 };
        },
      };
      return statement;
    },
  };
  const response = await purchaseHistory(null, { DB }, { id: 42 });
  assert.deepEqual(await response.json(), {
    purchases: [{
      platform: 'android',
      transaction_id: 'GPA.paid',
      purchase_type: 'standard',
      financial_status: 'processed',
      transaction_status: 'delivered',
    }],
    purchasedMentality: 280,
    spendTotals: [{
      currencyCode: 'USD',
      units: '4',
      nanos: 990_000_000,
      transactionCount: 1,
    }],
  });
  const paidQuery = statements.find((statement) => statement.sql.includes("pf.purchase_type='standard'"));
  assert.match(paidQuery.sql, /pf\.financial_status='processed'/);
  assert.match(paidQuery.sql, /pf\.revoked_at IS NULL/);
});

test('void reconciliation uses overlap-safe pagination and deterministic idempotent events', async () => {
  const DB = new Db();
  const seenUrls = [];
  const fetcher = async (url) => {
    seenUrls.push(String(url));
    return Response.json({
      voidedPurchases: [{
        orderId: 'GPA.voided',
        voidedTimeMillis: '1784808000000',
        voidedSource: 0,
        voidedReason: 7,
      }],
    });
  };
  const options = { accessToken: 'access', fetcher, nowMs: 1_784_808_100_000 };
  const first = await reconcileAndroidVoids({ DB }, options);
  const firstKey = DB.batches[0][0].args[0];
  const second = await reconcileAndroidVoids({ DB }, options);
  const secondKey = DB.batches[1][0].args[0];

  assert.deepEqual(first, { reconciled: 1, hasMore: false });
  assert.deepEqual(second, { reconciled: 1, hasMore: false });
  assert.equal(firstKey, secondKey);
  assert.match(DB.batches[0][0].sql, /INSERT OR IGNORE INTO purchase_reversals/);
  assert.match(DB.batches[0][1].sql, /financial_status='revoked'/);
  assert.match(seenUrls[0], /purchases\/voidedpurchases/);
  assert.match(seenUrls[0], /includeQuantityBasedPartialRefund=true/);
  assert.match(seenUrls[0], /type=0/);
  assert.equal(DB.writes.at(-1).args[0], options.nowMs);
});

test('periodic Orders sync marks refunded transactions revoked and retains exact paid Money', async () => {
  const DB = new Db();
  DB.ordersToSync = [{ transaction_id: 'GPA.refund', product_id: 'm_vault' }];
  const result = await reconcileAndroidOrderStates({ DB }, {
    accessToken: 'access',
    fetcher: async () => Response.json({
      orderId: 'GPA.refund',
      state: 'REFUNDED',
      lastEventTime: '2026-07-23T13:00:00Z',
      total: { currencyCode: 'EUR', units: '9', nanos: 500_000_000 },
      lineItems: [{
        productId: 'm_vault',
        total: { currencyCode: 'EUR', units: '9', nanos: 500_000_000 },
      }],
    }),
  });

  assert.deepEqual(result, { checked: 1, updated: 1, errors: [] });
  const write = DB.writes.at(-1);
  assert.match(write.sql, /INSERT INTO purchase_financials/);
  assert.equal(write.args[5], 'EUR');
  assert.equal(write.args[6], '9');
  assert.equal(write.args[7], 500_000_000);
  assert.equal(write.args[8], 'refunded');
  assert.equal(write.args[10], '2026-07-23T13:00:00Z');
  assert.equal(write.args[11], 'google:orders');
});
