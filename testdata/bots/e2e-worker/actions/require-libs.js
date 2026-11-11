/**
 * Uses the two npm modules the production bots require.
 * @title Require libs
 * @category E2E
 */
const moment = require('moment')
const qs = require('qs')

session.libs =
  moment('2026-01-02T03:04:05Z').utc().format('YYYY-MM-DD HH:mm') +
  '|' +
  qs.stringify({ a: 1, b: 'x y', c: ['p', 'q'] })
