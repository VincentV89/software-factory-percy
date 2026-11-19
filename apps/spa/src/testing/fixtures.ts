export function makeFixtures(tag: string, inbox: string): Record<string, string> {
  const email = (kind: string, suffix: string) => `${kind}+${tag}-${suffix}@simulator.amazonses.com`;
  const csv = (rows: string[][]) => rows.map((row) => row.map((cell) => '"' + cell.replaceAll('"', '""') + '"').join(',')).join('\n');
  const ann = email('success', 'ann');
  return {
    'mixed.csv': csv([['email', 'name'], [ann, 'Ann'], [email('success', 'ben'), 'Ben'], [email('bounce', 'cat'), 'Cat'], [email('complaint', 'dan'), 'Dan'], [ann, 'Ann'], ['not-an-email', 'Eve']]),
    'success-10.csv': csv([['email', 'name'], ...Array.from({ length: 10 }, (_, i) => [email('success', String(i)), `Person ${i}`])]),
    'stop-120.csv': csv([['email', 'name'], ...Array.from({ length: 120 }, (_, i) => [email('success', `stop${i}`), `Stop ${i}`])]),
    'missing-name.csv': csv([['email', 'name'], [email('success', 'named'), 'Ann'], [email('success', 'unnamed'), '']]),
    'missing-email-header.csv': 'name,city\nAnn,Singapore',
    'duplicate-header.csv': csv([['email', 'name', 'Name'], [email('success', 'duplicate'), 'Ann', 'Ann']]),
    'reserved-header.csv': csv([['email', 'unsubscribe_url'], [email('success', 'reserved'), 'https://example.com']]),
    'too-many-columns.csv': csv([['email', ...Array.from({ length: 21 }, (_, i) => `c${i}`)], [email('success', 'wide'), ...Array.from({ length: 21 }, () => 'x')]]),
    'wrong-column-count.csv': csv([['email', 'name'], [email('success', 'width')]]),
    'unverified-recipient.csv': 'email,name\nsomeone@example.com,Unverified',
    'inbox.csv': csv([['email', 'name'], [inbox, 'Tester']]),
    'eicar.csv': ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
  };
}

export function downloadFixture(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
