/**
 * Calls the mock webhook (a stand-in for example incoming webhooks) with axios.
 * @title Notify webhook
 * @category E2E
 * @param {string} path - mock path: notify or fail
 */
const axios = require('axios')

const run = async () => {
  try {
    const res = await axios.post(
      session.mock + '/' + args.path,
      {
        sid: session.sid,
        unique_id: session.unique_id,
        accountId: session.accountId,
        text: event.payload.text,
        nested: { list: [1, 2, 3], ok: true }
      },
      { headers: { 'X-E2E': 'yes' } }
    )
    session.webhookStatus = res.status
    session.webhookData = res.data.ok
  } catch (e) {
    session.webhookStatus = e.response ? e.response.status : 'noresponse'
    session.webhookData = e.response && e.response.data ? e.response.data.error : String(e.message)
  }
}

return run()
