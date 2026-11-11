/**
 * Handover to a human agent (mock of the example handover webhook).
 * @title Handover
 * @category E2E
 * @param {string} reason - why
 */
const axios = require('axios')

const run = async () => {
  await axios.post(session.mock + '/handover', {
    sid: session.sid,
    unique_id: session.unique_id,
    account_id: session.accountId,
    channel_sources: session.channel_sources,
    reason: args.reason,
    message: event.payload.text,
    email: event.payload.metadata.profile.email,
    name: session.name
  })
  session.handoverSent = true
}

return run()
