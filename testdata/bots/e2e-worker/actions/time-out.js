/**
 * Closes the example session after idle (mock of the example end webhook).
 * @title Time out
 * @category E2E
 * @param {string} reason - why
 */
const axios = require('axios')

const run = async () => {
  await axios.post(session.mock + '/end', {
    sid: session.sid,
    unique_id: session.unique_id,
    account_id: session.accountId,
    reason: args.reason
  })
}

return run()
