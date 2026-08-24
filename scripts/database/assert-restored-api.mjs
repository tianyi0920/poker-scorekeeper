import { pathToFileURL } from 'node:url';

const detailMoneyFields = [
  'buyIn',
  'cashOut',
  'rawProfit',
  'roomFeeShare',
  'otherFeeShare',
  'afterFeeProfit',
  'rakeAmount',
  'finalAmount'
];

function exactFields(actual, expected, fields) {
  return fields.every((field) => actual?.[field] === expected[field]);
}

export function assertRestoredHistoryPayload(runId, list, detail) {
  if (!/^[a-z0-9]{6,12}$/.test(runId)) throw new Error('Invalid Task18 drill run id');
  const gameId = `t18gam${runId}`;
  const gameName = `Task18 release drill ${runId}`;
  const listItem = Array.isArray(list?.items)
    ? list.items.find((item) => item?.gameId === gameId)
    : undefined;
  if (
    listItem?.name !== gameName
    || listItem?.settledByNickname !== `Drill admin ${runId}`
    || listItem?.myFinalAmount !== '-300'
  ) {
    throw new Error('Restored history list does not contain the exact drill settlement');
  }

  const expectedTotals = {
    buyIn: '900',
    cashOut: '900',
    roomFee: '20',
    otherFee: '0',
    rake: '0',
    final: '-20'
  };
  const expectedPlayers = [
    {
      nickname: `Drill admin ${runId}`,
      buyIn: '600',
      cashOut: '900',
      rawProfit: '300',
      roomFeeShare: '20',
      otherFeeShare: '0',
      afterFeeProfit: '280',
      rakeAmount: '0',
      finalAmount: '280'
    },
    {
      nickname: `Drill player ${runId}`,
      buyIn: '300',
      cashOut: '0',
      rawProfit: '-300',
      roomFeeShare: '0',
      otherFeeShare: '0',
      afterFeeProfit: '-300',
      rakeAmount: '0',
      finalAmount: '-300'
    }
  ];
  if (
    detail?.immutable !== true
    || detail?.game?.id !== gameId
    || detail?.game?.name !== gameName
    || !exactFields(detail?.totals, expectedTotals, Object.keys(expectedTotals))
    || !Array.isArray(detail?.players)
    || detail.players.length !== expectedPlayers.length
    || !expectedPlayers.every((expected, index) => (
      detail.players[index]?.nickname === expected.nickname
      && exactFields(detail.players[index], expected, detailMoneyFields)
    ))
  ) {
    throw new Error('Restored history detail does not match the exact drill settlement');
  }
}

async function main() {
  const baseUrl = process.env.RESTORED_BASE_URL;
  const runId = process.env.TASK18_DRILL_RUN_ID;
  if (baseUrl !== 'http://127.0.0.1:3001' || !runId) {
    throw new Error('Restored API assertion requires the isolated local release instance');
  }
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `${runId}-player`,
      password: 'Task18-release-drill-password-12345'
    })
  });
  if (login.status !== 201) throw new Error('Restored release fixture login failed');
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Restored release fixture login returned no session cookie');
  const headers = { Cookie: cookie };
  const historyResponse = await fetch(`${baseUrl}/api/history`, { headers });
  if (!historyResponse.ok) throw new Error('Restored history list request failed');
  const history = await historyResponse.json();
  const gameId = `t18gam${runId}`;
  const detailResponse = await fetch(`${baseUrl}/api/history/${encodeURIComponent(gameId)}`, { headers });
  if (!detailResponse.ok) throw new Error('Restored history detail request failed');
  assertRestoredHistoryPayload(runId, history, await detailResponse.json());
  process.stdout.write('restored API history assertion passed\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Restored API assertion failed'}\n`);
    process.exitCode = 1;
  });
}
