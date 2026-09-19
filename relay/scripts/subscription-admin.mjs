// Run locally on the relay host; no public management API or payment processing.
import { openSubscriptions } from '../src/subscriptions.mjs';
const [, , filename, action, value] = process.argv;
if (!filename || !['issue', 'status', 'revoke'].includes(action)) throw new Error('用法：node relay/scripts/subscription-admin.mjs /绝对路径/subscriptions.sqlite issue 1|12 / status 设备ID / revoke 设备ID');
const store = openSubscriptions(filename);
try {
  if (action === 'issue') console.log(store.issue(Number(value)));
  else if (action === 'status') console.log(JSON.stringify(store.status(value)));
  else { store.revoke(value); console.log('已停用'); }
} finally { store.close(); }
