/** CSV fixtures of E2E-01 (requirements §11). The EICAR string is assembled at runtime so scanners do not flag this file. */
// Fresh simulator aliases prevent previous runs' global bounce/complaint suppressions leaking in.
const feedbackTag = process.env['E2E_FEEDBACK_TAG'] ?? '';
export const E2E_SMALL_CSV = [
  'email,name',
  'success+e2e1@simulator.amazonses.com,Ann',
  'success+e2e2@simulator.amazonses.com,Ben',
  `bounce+e2e${feedbackTag}@simulator.amazonses.com,Cat`,
  `complaint+e2e${feedbackTag}@simulator.amazonses.com,Dan`,
  'success+e2e1@simulator.amazonses.com,Ann',
  'not-an-email,Eve',
  'success+supp@simulator.amazonses.com,Sam',
].join('\n');

export const E2E_STOP_CSV = ['email,name', ...Array.from({ length: 120 }, (_, i) => `success+stop${String(i).padStart(3, '0')}@simulator.amazonses.com,Stop${i}`)].join('\n');

// The scanner test must start with the canonical 68 bytes; a CSV header invalidates it.
export const EICAR_CSV = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

export const TEMPLATE = {
  name: 'E2E Template',
  subject: 'Hello {{name}}',
  html: '<p>Hi {{name}},</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
  text: 'Hi {{name}}. Unsubscribe: {{unsubscribe_url}}',
};
