import { DurableObject } from 'cloudflare:workers';
import { stagingRelay } from './relay.mjs';

export class StagingQuota extends DurableObject {
  async take() {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS allowance (id INTEGER PRIMARY KEY, used INTEGER NOT NULL)');
    sql.exec('INSERT OR IGNORE INTO allowance VALUES (1, 0)');
    return sql.exec('UPDATE allowance SET used = used + 1 WHERE id = 1 AND used < 2 RETURNING used').toArray().length === 1;
  }
}

export default {fetch: stagingRelay()};
